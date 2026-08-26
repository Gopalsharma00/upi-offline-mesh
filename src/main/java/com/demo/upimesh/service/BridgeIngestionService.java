package com.demo.upimesh.service;

import com.demo.upimesh.crypto.HybridCryptoService;
import com.demo.upimesh.model.MeshPacket;
import com.demo.upimesh.model.PaymentInstruction;
import com.demo.upimesh.model.Transaction;
import com.demo.upimesh.store.TaskQueue;
import com.fasterxml.jackson.databind.ObjectMapper;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.time.Instant;
import java.util.concurrent.CountDownLatch;

/**
 * Server-side pipeline for one inbound packet from a bridge node:
 *
 *   1. Rate limiting — VIP packets bypass, gossiped ones are capped.
 *   2. Hash the ciphertext.
 *   3. Claim that hash. Already claimed means duplicate: drop it.
 *   4. Queue the packet and return ACCEPTED_FOR_PROCESSING.
 *
 *   --- worker thread ---
 *   5. Pull from the queue.
 *   6. Decrypt with the server's private key (CPU heavy, hence off-thread).
 *   7. Reject anything older than the freshness window (replay protection).
 *   8. Hand to SettlementService for the debit/credit.
 */
@Service
public class BridgeIngestionService {

    private static final Logger log = LoggerFactory.getLogger(BridgeIngestionService.class);

    @Autowired private HybridCryptoService crypto;
    @Autowired private IdempotencyService idempotency;
    @Autowired private SettlementService settlement;
    @Autowired private RateLimiterService rateLimiter;
    @Autowired private TaskQueue queue;
    @Autowired private ObjectMapper objectMapper;

    @Value("${upi.mesh.packet-max-age-seconds:86400}")
    private long maxAgeSeconds;

    private Thread workerThread;
    private volatile boolean running = true;

    /** Counts packets that have finished the worker, so tests can wait deterministically. */
    private volatile CountDownLatch drainLatch = new CountDownLatch(0);

    public record IngestionTask(MeshPacket packet, String bridgeNodeId, int hopCount, String packetHash) {}

    @PostConstruct
    public void startAsyncWorker() {
        workerThread = new Thread(() -> {
            log.info("AsyncDecryptionWorker started on the {} queue", queue.backend());
            long backoffMs = 1_000L;
            long failureStreak = 0;

            while (running) {
                try {
                    String jsonTask = queue.poll(Duration.ofSeconds(1));
                    if (jsonTask != null) {
                        try {
                            processTask(objectMapper.readValue(jsonTask, IngestionTask.class));
                        } finally {
                            drainLatch.countDown();
                        }
                    }
                    if (failureStreak > 0) {
                        log.info("Queue reachable again after {} failed attempt(s)", failureStreak);
                        failureStreak = 0;
                        backoffMs = 1_000L;
                    }
                } catch (InterruptedException ie) {
                    Thread.currentThread().interrupt();
                    break;
                } catch (Exception e) {
                    // Never let the worker die. Back off rather than spinning: a
                    // broken queue used to retry every second and print a stack
                    // trace each time, which buried the log.
                    failureStreak++;
                    if (failureStreak == 1) {
                        log.error("Worker cannot read the queue: {} — backing off, still retrying", e.getMessage(), e);
                    } else {
                        log.debug("Worker retry {} still failing: {}", failureStreak, e.getMessage());
                    }
                    try {
                        Thread.sleep(backoffMs);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                    backoffMs = Math.min(backoffMs * 2, 60_000L);
                }
            }
        });
        workerThread.setName("AsyncDecryptionWorker");
        workerThread.setDaemon(true);
        workerThread.start();
    }

    @PreDestroy
    public void stopAsyncWorker() {
        running = false;
        if (workerThread != null) workerThread.interrupt();
    }

    public IngestResult ingest(MeshPacket packet, String bridgeNodeId, int hopCount) {
        try {
            // hopCount <= 1 means a fresh transaction: injected at a bridge, or
            // gossiped exactly once before reaching one. These bypass the limiter
            // so a user's own payment is never blocked by mesh congestion.
            boolean isVip = (hopCount <= 1);
            if (!rateLimiter.tryConsume(bridgeNodeId, isVip)) {
                log.warn("Rate limit exceeded for bridge {} — packet throttled", bridgeNodeId);
                return IngestResult.throttled(bridgeNodeId);
            }

            String packetHash = crypto.hashCiphertext(packet.getCiphertext());

            if (!idempotency.claim(packetHash)) {
                log.info("DUPLICATE packet {} from bridge {} — dropped", shortHash(packetHash), bridgeNodeId);
                return IngestResult.duplicate(packetHash);
            }

            queue.push(objectMapper.writeValueAsString(
                    new IngestionTask(packet, bridgeNodeId, hopCount, packetHash)));
            log.info("ACCEPTED packet {} from bridge {} — queued for decryption",
                    shortHash(packetHash), bridgeNodeId);

            return new IngestResult("ACCEPTED_FOR_PROCESSING", packetHash, "Queued for decryption", null);

        } catch (Exception e) {
            log.error("Ingestion error: {}", e.getMessage(), e);
            return IngestResult.invalid("?", "internal_error: " + e.getMessage());
        }
    }

    private void processTask(IngestionTask task) {
        log.info("[AsyncWorker] Processing packet {}", shortHash(task.packetHash()));

        PaymentInstruction instruction;
        try {
            Thread.sleep(200);   // stand-in for the real RSA cost
            instruction = crypto.decrypt(task.packet().getCiphertext());
        } catch (InterruptedException ie) {
            Thread.currentThread().interrupt();
            return;
        } catch (Exception e) {
            log.warn("[AsyncWorker] Decryption failed for packet {}: {}",
                    shortHash(task.packetHash()), e.getMessage());
            return;
        }

        long ageSeconds = (Instant.now().toEpochMilli() - instruction.getSignedAt()) / 1000;
        if (ageSeconds > maxAgeSeconds) {
            log.warn("[AsyncWorker] Packet {} too old ({}s), rejected", shortHash(task.packetHash()), ageSeconds);
            return;
        }
        if (ageSeconds < -300) {   // small clock-skew tolerance
            log.warn("[AsyncWorker] Packet {} is future-dated, rejected", shortHash(task.packetHash()));
            return;
        }

        try {
            settlement.settle(instruction, task.packetHash(), task.bridgeNodeId(), task.hopCount());
            log.info("[AsyncWorker] Settled packet {}", shortHash(task.packetHash()));
        } catch (Exception e) {
            log.warn("[AsyncWorker] Settlement failed for packet {}: {}",
                    shortHash(task.packetHash()), e.getMessage());
        }
    }

    /**
     * Arm a latch for the next {@code expected} packets to clear the worker, so a
     * test can await the async pipeline instead of sleeping and hoping.
     */
    public CountDownLatch expectProcessed(int expected) {
        CountDownLatch latch = new CountDownLatch(expected);
        this.drainLatch = latch;
        return latch;
    }

    public void clearQueue() {
        queue.clear();
        log.info("Ingestion queue cleared");
    }

    public int queueDepth() {
        return queue.depth();
    }

    public String backend() {
        return queue.backend();
    }

    private static String shortHash(String hash) {
        if (hash == null) return "unknown";
        return (hash.length() > 12 ? hash.substring(0, 12) : hash) + "...";
    }

    public record IngestResult(String outcome, String packetHash, String reason, Long transactionId) {
        public static IngestResult settled(String hash, Transaction tx) {
            return new IngestResult("SETTLED", hash, null, tx.getId());
        }
        public static IngestResult duplicate(String hash) {
            return new IngestResult("DUPLICATE_DROPPED", hash, null, null);
        }
        public static IngestResult invalid(String hash, String reason) {
            return new IngestResult("INVALID", hash, reason, null);
        }
        public static IngestResult throttled(String bridgeNodeId) {
            return new IngestResult("THROTTLED", null, "Rate limit exceeded for " + bridgeNodeId, null);
        }
    }
}
