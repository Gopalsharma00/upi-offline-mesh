package com.demo.upimesh.service;

import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;
import java.util.Set;

/**
 * Distributed idempotency cache using Redis SETNX + TTL.
 *
 * The contract:
 *   - claim(hash) returns true on first call, false on every call after that
 *     (within the TTL window)
 *   - the operation is atomic — even if 100 nodes call claim(hash) at the
 *     same instant, exactly one returns true
 *
 * This is what kills the "three bridges deliver simultaneously" problem across a cluster.
 */
@Service
public class IdempotencyService {

    @Autowired
    private StringRedisTemplate redisTemplate;

    @Value("${upi.mesh.idempotency-ttl-seconds:86400}")
    private long ttlSeconds;

    /**
     * Try to claim a hash. Returns true if this caller is the first; false if
     * someone else already claimed it (i.e. the packet is a duplicate).
     */
    public boolean claim(String packetHash) {
        String key = "idemp:" + packetHash;
        Boolean success = redisTemplate.opsForValue().setIfAbsent(key, "1", Duration.ofSeconds(ttlSeconds));
        return Boolean.TRUE.equals(success);
    }

    public int size() {
        // Warning: KEYS is generally bad practice in production Redis, but acceptable for this demo
        Set<String> keys = redisTemplate.keys("idemp:*");
        return keys == null ? 0 : keys.size();
    }

    /** Test/demo helper. */
    public void clear() {
        Set<String> keys = redisTemplate.keys("idemp:*");
        if (keys != null && !keys.isEmpty()) {
            redisTemplate.delete(keys);
        }
    }
}
