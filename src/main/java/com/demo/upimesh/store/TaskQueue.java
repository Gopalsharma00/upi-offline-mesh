package com.demo.upimesh.store;

import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Duration;
import java.util.concurrent.LinkedBlockingQueue;
import java.util.concurrent.TimeUnit;

/**
 * The hand-off between "packet accepted" and "packet decrypted and settled".
 *
 * Ingestion pushes; a single worker thread blocks on {@link #poll}. Keeping the
 * decrypt off the request thread is the point — RSA is slow, and a bridge node
 * uploading a batch should not wait for it.
 */
public interface TaskQueue {

    void push(String payload);

    /** Blocks up to {@code timeout} for an item. Returns null if none arrived. */
    String poll(Duration timeout) throws InterruptedException;

    int depth();

    void clear();

    String backend();

    // ---------------------------------------------------------------- memory

    final class InMemory implements TaskQueue {

        private final LinkedBlockingQueue<String> queue = new LinkedBlockingQueue<>();

        @Override
        public void push(String payload) {
            queue.add(payload);
        }

        @Override
        public String poll(Duration timeout) throws InterruptedException {
            return queue.poll(timeout.toMillis(), TimeUnit.MILLISECONDS);
        }

        @Override
        public int depth() {
            return queue.size();
        }

        @Override
        public void clear() {
            queue.clear();
        }

        @Override
        public String backend() {
            return "memory";
        }
    }

    // ----------------------------------------------------------------- redis

    final class Redis implements TaskQueue {

        private static final String KEY = "ingestion_queue";

        private final StringRedisTemplate redis;

        public Redis(StringRedisTemplate redis) {
            this.redis = redis;
        }

        @Override
        public void push(String payload) {
            redis.opsForList().rightPush(KEY, payload);
        }

        @Override
        public String poll(Duration timeout) {
            return redis.opsForList().leftPop(KEY, timeout);
        }

        @Override
        public int depth() {
            Long n = redis.opsForList().size(KEY);
            return n == null ? 0 : n.intValue();
        }

        @Override
        public void clear() {
            redis.delete(KEY);
        }

        @Override
        public String backend() {
            return "redis";
        }
    }
}
