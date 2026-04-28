package com.demo.upimesh.service;

import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.data.redis.core.StringRedisTemplate;
import org.springframework.stereotype.Service;

import java.time.Duration;

/**
 * Distributed Rate Limiting using Redis (Fixed Window Algorithm).
 * 
 * Pattern: Priority-based rate limiting.
 * - Standard Bucket: Used for mesh-gossiped packets (strict limit).
 * - VIP Bucket: Used for brand new transactions from the source device (generous limit).
 */
@Service
public class RateLimiterService {

    private static final Logger log = LoggerFactory.getLogger(RateLimiterService.class);

    @Autowired
    private StringRedisTemplate redisTemplate;

    /**
     * Tries to consume a token for a specific bridge node.
     * @param bridgeId The ID of the bridge node
     * @param isVip If true, uses the more generous VIP limit
     * @return true if allowed, false if rate limited
     */
    public boolean tryConsume(String bridgeId, boolean isVip) {
        // VIP packets (fresh transactions from the source) bypass the rate limiter entirely.
        // This guarantees that a user's own payment is NEVER blocked by mesh congestion.
        if (isVip) {
            log.info("[RateLimiter] VIP bypass granted for bridge: {}", bridgeId);
            return true;
        }

        // Standard mesh packets use a Fixed Window rate limiter backed by Redis.
        long currentMinute = System.currentTimeMillis() / 60000;
        String key = "ratelimit:std:" + bridgeId + ":" + currentMinute;

        Long count = redisTemplate.opsForValue().increment(key);

        // Set expiry on the first request so the key auto-cleans from Redis
        if (count != null && count == 1) {
            redisTemplate.expire(key, Duration.ofMinutes(2));
        }

        int limit = 5; // 5 standard packets per minute per bridge node
        boolean allowed = count != null && count <= limit;
        if (!allowed) {
            log.warn("[RateLimiter] STANDARD limit exceeded for bridge: {} (count: {})", bridgeId, count);
        }
        return allowed;
    }
}
