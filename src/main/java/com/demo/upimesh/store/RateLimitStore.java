package com.demo.upimesh.store;

import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Duration;
import java.util.Iterator;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.atomic.AtomicLong;

/**
 * Fixed-window counter behind the rate limiter.
 *
 * The caller folds the current window into the key, so this only has to count
 * and forget. {@link #hit} must be atomic per key or two bridge nodes can slip
 * past the same limit.
 */
public interface RateLimitStore {

    /** Increment the counter for this window and return the new value. */
    long hit(String key, Duration ttl);

    String backend();

    // ---------------------------------------------------------------- memory

    final class InMemory implements RateLimitStore {

        private record Window(AtomicLong count, long expiresAt) {}

        private final ConcurrentHashMap<String, Window> windows = new ConcurrentHashMap<>();

        @Override
        public long hit(String key, Duration ttl) {
            long now = System.currentTimeMillis();
            if (windows.size() > 512) sweep(now);
            Window w = windows.compute(key, (k, existing) ->
                    (existing == null || existing.expiresAt() <= now)
                            ? new Window(new AtomicLong(), now + ttl.toMillis())
                            : existing);
            return w.count().incrementAndGet();
        }

        @Override
        public String backend() {
            return "memory";
        }

        private void sweep(long now) {
            Iterator<Map.Entry<String, Window>> it = windows.entrySet().iterator();
            while (it.hasNext()) {
                if (it.next().getValue().expiresAt() <= now) it.remove();
            }
        }
    }

    // ----------------------------------------------------------------- redis

    final class Redis implements RateLimitStore {

        private final StringRedisTemplate redis;

        public Redis(StringRedisTemplate redis) {
            this.redis = redis;
        }

        @Override
        public long hit(String key, Duration ttl) {
            Long count = redis.opsForValue().increment(key);
            // Set the expiry on the first hit so the window key cleans itself up.
            if (count != null && count == 1L) redis.expire(key, ttl);
            return count == null ? 0L : count;
        }

        @Override
        public String backend() {
            return "redis";
        }
    }
}
