package com.demo.upimesh;

import com.demo.upimesh.crypto.HybridCryptoService;
import com.demo.upimesh.crypto.ServerKeyHolder;
import com.demo.upimesh.model.AccountRepository;
import com.demo.upimesh.model.MeshPacket;
import com.demo.upimesh.model.PaymentInstruction;
import com.demo.upimesh.service.BridgeIngestionService;
import com.demo.upimesh.service.DemoService;
import com.demo.upimesh.service.IdempotencyService;
import org.junit.jupiter.api.BeforeEach;
import org.junit.jupiter.api.Test;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.boot.test.context.SpringBootTest;

import java.math.BigDecimal;
import java.util.concurrent.*;
import java.util.concurrent.atomic.AtomicInteger;

import static org.junit.jupiter.api.Assertions.*;

/**
 * The scenario that matters: one payment, several bridge nodes surfacing at the
 * same instant, and the ledger moving exactly once.
 *
 * Ingestion is asynchronous — ingest() claims the hash and queues, and a worker
 * decrypts and settles. So these tests assert on the ingest verdict and then
 * wait on the worker rather than expecting a balance to have moved by the time
 * ingest() returns.
 */
@SpringBootTest
class IdempotencyConcurrencyTest {

    @Autowired private DemoService demoService;
    @Autowired private BridgeIngestionService bridge;
    @Autowired private IdempotencyService idempotency;
    @Autowired private AccountRepository accounts;
    @Autowired private HybridCryptoService crypto;
    @Autowired private ServerKeyHolder serverKey;

    @BeforeEach
    void clear() {
        idempotency.clear();
        bridge.clearQueue();
    }

    @Test
    void singlePacketDeliveredByThreeBridgesSettlesExactlyOnce() throws Exception {
        BigDecimal aliceBefore = accounts.findById("alice@demo").orElseThrow().getBalance();
        BigDecimal bobBefore = accounts.findById("bob@demo").orElseThrow().getBalance();

        MeshPacket packet = demoService.createPacket(
                "alice@demo", "bob@demo", new BigDecimal("100.00"), "1234", 5);

        // Only the packet that wins the idempotency claim reaches the worker.
        CountDownLatch settledOnce = bridge.expectProcessed(1);

        ExecutorService pool = Executors.newFixedThreadPool(3);
        CountDownLatch start = new CountDownLatch(1);
        AtomicInteger accepted = new AtomicInteger();
        AtomicInteger duplicates = new AtomicInteger();

        Future<?>[] futures = new Future[3];
        for (int i = 0; i < 3; i++) {
            final String node = "bridge-" + i;
            futures[i] = pool.submit(() -> {
                try {
                    start.await();
                    // hopCount 3 keeps every caller on the standard path; the
                    // limit is 5/min so none of the three is throttled.
                    BridgeIngestionService.IngestResult r = bridge.ingest(packet, node, 3);
                    switch (r.outcome()) {
                        case "ACCEPTED_FOR_PROCESSING" -> accepted.incrementAndGet();
                        case "DUPLICATE_DROPPED" -> duplicates.incrementAndGet();
                        default -> fail("unexpected outcome: " + r.outcome() + " / " + r.reason());
                    }
                } catch (Exception e) {
                    throw new RuntimeException(e);
                }
            });
        }

        start.countDown();   // release all three at once
        for (Future<?> f : futures) f.get(10, TimeUnit.SECONDS);
        pool.shutdown();

        assertEquals(1, accepted.get(), "exactly one bridge should win the claim");
        assertEquals(2, duplicates.get(), "the other two should be dropped as duplicates");

        assertTrue(settledOnce.await(10, TimeUnit.SECONDS), "worker should drain the queued packet");

        BigDecimal aliceAfter = accounts.findById("alice@demo").orElseThrow().getBalance();
        BigDecimal bobAfter = accounts.findById("bob@demo").orElseThrow().getBalance();
        assertEquals(0, aliceBefore.subtract(new BigDecimal("100.00")).compareTo(aliceAfter),
                "sender debited exactly once");
        assertEquals(0, bobBefore.add(new BigDecimal("100.00")).compareTo(bobAfter),
                "receiver credited exactly once");
    }

    @Test
    void tamperedCiphertextNeverSettles() throws Exception {
        BigDecimal aliceBefore = accounts.findById("alice@demo").orElseThrow().getBalance();
        BigDecimal bobBefore = accounts.findById("bob@demo").orElseThrow().getBalance();

        MeshPacket packet = demoService.createPacket(
                "alice@demo", "bob@demo", new BigDecimal("50.00"), "1234", 5);

        // Flip a byte in the middle of the ciphertext.
        char[] chars = packet.getCiphertext().toCharArray();
        chars[chars.length / 2] = chars[chars.length / 2] == 'A' ? 'B' : 'A';
        packet.setCiphertext(new String(chars));

        CountDownLatch processed = bridge.expectProcessed(1);

        // Tampering is invisible at ingest — the hash is simply of different
        // bytes, so it is accepted. AES-GCM catches it when the worker decrypts.
        BridgeIngestionService.IngestResult r = bridge.ingest(packet, "bridge-x", 1);
        assertEquals("ACCEPTED_FOR_PROCESSING", r.outcome());

        assertTrue(processed.await(10, TimeUnit.SECONDS), "worker should have attempted the packet");

        assertEquals(0, aliceBefore.compareTo(accounts.findById("alice@demo").orElseThrow().getBalance()),
                "a tampered packet must not move the sender's balance");
        assertEquals(0, bobBefore.compareTo(accounts.findById("bob@demo").orElseThrow().getBalance()),
                "a tampered packet must not move the receiver's balance");
    }

    @Test
    void replayOfAnAlreadySettledPacketIsDropped() throws Exception {
        MeshPacket packet = demoService.createPacket(
                "carol@demo", "dave@demo", new BigDecimal("25.00"), "1234", 5);

        CountDownLatch first = bridge.expectProcessed(1);
        assertEquals("ACCEPTED_FOR_PROCESSING", bridge.ingest(packet, "bridge-a", 1).outcome());
        assertTrue(first.await(10, TimeUnit.SECONDS));

        BigDecimal carolAfterFirst = accounts.findById("carol@demo").orElseThrow().getBalance();

        // Same ciphertext replayed much later still loses to the claim.
        assertEquals("DUPLICATE_DROPPED", bridge.ingest(packet, "bridge-b", 1).outcome());

        assertEquals(0, carolAfterFirst.compareTo(accounts.findById("carol@demo").orElseThrow().getBalance()),
                "a replayed packet must not debit twice");
    }

    @Test
    void encryptDecryptRoundTrip() throws Exception {
        PaymentInstruction original = new PaymentInstruction(
                "alice@demo", "bob@demo", new BigDecimal("123.45"),
                "abcdef", "nonce-1", System.currentTimeMillis());

        String ct = crypto.encrypt(original, serverKey.getPublicKey());
        PaymentInstruction decrypted = crypto.decrypt(ct);

        assertEquals(original.getSenderVpa(), decrypted.getSenderVpa());
        assertEquals(original.getReceiverVpa(), decrypted.getReceiverVpa());
        assertEquals(0, original.getAmount().compareTo(decrypted.getAmount()));
        assertEquals(original.getNonce(), decrypted.getNonce());
    }
}
