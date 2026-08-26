package com.demo.upimesh.service;

import com.demo.upimesh.crypto.HybridCryptoService;
import com.demo.upimesh.model.MeshPacket;
import com.demo.upimesh.model.PaymentInstruction;
import com.demo.upimesh.model.Transaction;
import jakarta.annotation.PostConstruct;
import jakarta.annotation.PreDestroy;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Instant;
import java.time.Duration;
import org.springframework.data.redis.core.StringRedisTemplate;
import com.fasterxml.jackson.databind.ObjectMapper;

/**
 * Orchestrates the full server-side pipeline for one inbound packet from a
 * bridge node:
 *
 *   1. Rate limiting (Token Bucket).
 *   2. Hash the ciphertext.
 *   3. Try to claim that hash via the idempotency cache (Synchronous).
 *      - If already claimed: this is a duplicate. Drop it immediately.
 *   4. If new, push the packet to an Async Message Queue and return 202 ACCEPTED.
 *
 *   --- Asynchronous Worker Pipeline ---
 *   5. A background thread pulls from the queue.
 *   6. Decrypt the ciphertext with the server's private key (CPU heavy).
 *   7. Check freshness — reject if signedAt is too old (replay protection).
 *   8. Hand off to SettlementService for the actual debit/credit.
 */
@Service
public class BridgeIngestionService {

    private static final Logger log = LoggerFactory.getLogger(BridgeIngestionService.class);

    @Autowired private HybridCryptoService crypto;
    @Autowired private IdempotencyService idempotency;
    @Autowired private SettlementService settlement;
    @Autowired private RateLimiterService rateLimiter;
    @Autowired private StringRedisTemplate redisTemplate;
    @Autowired private ObjectMapper objectMapper;

    @Value("${upi.mesh.packet-max-age-seconds:86400}")
    private long maxAgeSeconds;

    // The distributed Message Queue using Redis List
    private static final String QUEUE_KEY = "ingestion_queue";
    private Thread workerThread;
    private volatile boolean running = true;

    public record IngestionTask(MeshPacket packet, String bridgeNodeId, int hopCount, String packetHash) {}

    private static final long BACKOFF_MIN_MS = 1_000L;
    private static final long BACKOFF_MAX_MS = 60_000L;

    @PostConstruct
    public void startAsyncWorker() {
        workerThread = new Thread(() -> {
            log.info("AsyncDecryptionWorker started. Listening to Redis queue...");
            long backoffMs = BACKOFF_MIN_MS;
            long failureStreak = 0;

            while (running) {
                try {
                    // Block for up to 1 second waiting for an element
                    String jsonTask = redisTemplate.opsForList().leftPop(QUEUE_KEY, Duration.ofSeconds(1));
                    if (jsonTask != null) {
                        IngestionTask task = objectMapper.readValue(jsonTask, IngestionTask.class);
                        processTaskAsynchronously(task);
                    }
                    if (failureStreak > 0) {
                        log.info("Redis reachable again after {} failed attempt(s)", failureStreak);
                        failureStreak = 0;
                        backoffMs = BACKOFF_MIN_MS;
                    }
                } catch (Exception e) {
                    // Catch everything so the worker thread doesn't die silently.
                    //
                    // When Redis is gone the queue poll fails on every pass. Retrying
                    // once a second and printing a full stack trace each time buries
                    // the logs and burns CPU we do not have, so back off to a minute
                    // and log the first failure of each streak at ERROR, the rest at
                    // DEBUG.
                    failureStreak++;
                    if (failureStreak == 1) {
                        log.error("Worker cannot reach Redis: {} — backing off, will keep retrying", e.getMessage(), e);
                    } else {
                        log.debug("Worker retry {} still failing: {}", failureStreak, e.getMessage());
                    }
                    try {
                        Thread.sleep(backoffMs);
                    } catch (InterruptedException ie) {
                        Thread.currentThread().interrupt();
                        break;
                    }
                    backoffMs = Math.min(backoffMs * 2, BACKOFF_MAX_MS);
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
        if (workerThread != null) {
            workerThread.interrupt();
        }
    }

    public IngestResult ingest(MeshPacket packet, String bridgeNodeId, int hopCount) {
        try {
            // ---- Rate Limiting (Priority-based) ----
            // hopCount <= 1 means this is a fresh transaction (0 = injected directly at bridge,
            // 1 = gossiped exactly once before reaching a bridge).
            // These VIP packets bypass the rate limiter entirely so your own payment is NEVER blocked.
            boolean isVip = (hopCount <= 1);
            if (!rateLimiter.tryConsume(bridgeNodeId, isVip)) {
                log.warn("STANDARD RATE LIMIT EXCEEDED for bridge {} — packet throttled", bridgeNodeId);
                return IngestResult.throttled(bridgeNodeId);
            }

            String packetHash = crypto.hashCiphertext(packet.getCiphertext());

            // ---- Idempotency gate (Synchronous fast-path) ----
            if (!idempotency.claim(packetHash)) {
                log.info("DUPLICATE packet {} from bridge {} — dropped",
                        packetHash.substring(0, 12) + "...", bridgeNodeId);
                return IngestResult.duplicate(packetHash);
            }

            // ---- Enqueue for Async Processing (Distributed Queue) ----
            IngestionTask task = new IngestionTask(packet, bridgeNodeId, hopCount, packetHash);
            String jsonTask = objectMapper.writeValueAsString(task);
            redisTemplate.opsForList().rightPush(QUEUE_KEY, jsonTask);
            log.info("ACCEPTED packet {} from bridge {} — queued to Redis for async processing",
                    packetHash.substring(0, 12) + "...", bridgeNodeId);

            return new IngestResult("ACCEPTED_FOR_PROCESSING", packetHash, "Queued for decryption", null);

        } catch (Exception e) {
            log.error("Ingestion error: {}", e.getMessage(), e);
            return IngestResult.invalid("?", "internal_error: " + e.getMessage());
        }
    }

    private void processTaskAsynchronously(IngestionTask task) {
        log.info("[AsyncWorker] Processing packet {}", task.packetHash().substring(0, 12) + "...");
        
        // ---- Decrypt (CPU Heavy) ----
        PaymentInstruction instruction;
        try {
            // Simulating CPU work
            Thread.sleep(200);
            instruction = crypto.decrypt(task.packet().getCiphertext());
        } catch (Exception e) {
            log.warn("[AsyncWorker] Decryption failed for packet {}: {}",
                    task.packetHash().substring(0, 12) + "...", e.getMessage());
            return;
        }

        // ---- Freshness check (replay protection) ----
        long ageSeconds = (Instant.now().toEpochMilli() - instruction.getSignedAt()) / 1000;
        if (ageSeconds > maxAgeSeconds) {
            log.warn("[AsyncWorker] Packet {} too old ({}s), rejected",
                    task.packetHash().substring(0, 12) + "...", ageSeconds);
            return;
        }
        if (ageSeconds < -300) { // small clock-skew tolerance
            log.warn("[AsyncWorker] Packet {} is future-dated, rejected",
                    task.packetHash().substring(0, 12) + "...");
            return;
        }

    // ---- Settle ----
        settlement.settle(instruction, task.packetHash(), task.bridgeNodeId(), task.hopCount());
        log.info("[AsyncWorker] Successfully settled packet {}", task.packetHash().substring(0, 12) + "...");
    }

    public void clearQueue() {
        redisTemplate.delete(QUEUE_KEY);
        log.info("Redis async ingestion queue cleared");
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
