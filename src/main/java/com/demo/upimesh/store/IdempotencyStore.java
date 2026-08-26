package com.demo.upimesh.store;

import org.springframework.data.redis.core.StringRedisTemplate;

import java.time.Duration;
import java.util.Iterator;
import java.util.Map;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;

/**
 * "Has this packet hash been seen before?" — the gate that stops three bridge
 * nodes delivering the same payment three times.
 *
 * The only hard requirement is that {@link #claim} is atomic: if N callers
 * claim the same key at the same instant, exactly one gets true.
 *
 * Two implementations. {@link InMemory} is the default and needs nothing
 * installed; {@link Redis} is used instead when a Redis server is actually
 * reachable, which is what makes the guarantee hold across more than one node.
 */
public interface IdempotencyStore {

    /** @return true if this caller is the first to claim the key inside its TTL. */
    boolean claim(String key, Duration ttl);

    int size();

    void clear();

    /** Name of the backing store, for display. */
    String backend();

    // ---------------------------------------------------------------- memory

    final class InMemory implements IdempotencyStore {

        /** key -> epoch millis at which the claim lapses */
        private final ConcurrentHashMap<String, Long> claims = new ConcurrentHashMap<>();

        @Override
        public boolean claim(String key, Duration ttl) {
            long now = System.currentTimeMillis();
            // compute() holds the bin lock for this key, so two threads racing on
            // the same key are serialised and only one sees a lapsed entry.
            final boolean[] first = { false };
            claims.compute(key, (k, expiresAt) -> {
                if (expiresAt == null || expiresAt <= now) {
                    first[0] = true;
                    return now + ttl.toMillis();
                }
                return expiresAt;
            });
            return first[0];
        }

        @Override
        public int size() {
            sweep();
            return claims.size();
        }

        @Override
        public void clear() {
            claims.clear();
        }

        @Override
        public String backend() {
            return "memory";
        }

        /** Drop lapsed claims. Cheap: this map holds one small entry per packet. */
        private void sweep() {
            long now = System.currentTimeMillis();
            Iterator<Map.Entry<String, Long>> it = claims.entrySet().iterator();
            while (it.hasNext()) {
                if (it.next().getValue() <= now) it.remove();
            }
        }
    }

    // ----------------------------------------------------------------- redis

    final class Redis implements IdempotencyStore {

        private final StringRedisTemplate redis;

        public Redis(StringRedisTemplate redis) {
            this.redis = redis;
        }

        @Override
        public boolean claim(String key, Duration ttl) {
            return Boolean.TRUE.equals(redis.opsForValue().setIfAbsent(key, "1", ttl));
        }

        @Override
        public int size() {
            Set<String> keys = redis.keys("idemp:*");
            return keys == null ? 0 : keys.size();
        }

        @Override
        public void clear() {
            Set<String> keys = redis.keys("idemp:*");
            if (keys != null && !keys.isEmpty()) redis.delete(keys);
        }

        @Override
        public String backend() {
            return "redis";
        }
    }
}
