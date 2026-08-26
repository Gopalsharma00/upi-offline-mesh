package com.demo.upimesh.service;

import com.demo.upimesh.store.RateLimitStore;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.stereotype.Service;

import java.time.Duration;

/**
 * Priority-based rate limiting, fixed window.
 *
 * - VIP: a brand-new transaction from the source device. Bypasses the limiter
 *   entirely, so a user's own payment is never blocked by mesh congestion.
 * - Standard: a packet that has been gossiped around. Capped per bridge node.
 */
@Service
public class RateLimiterService {

    private static final Logger log = LoggerFactory.getLogger(RateLimiterService.class);

    private static final int STANDARD_LIMIT_PER_MINUTE = 5;
    private static final Duration WINDOW_TTL = Duration.ofMinutes(2);

    @Autowired
    private RateLimitStore store;

    /**
     * @param isVip if true, skip the limiter entirely
     * @return true if allowed, false if rate limited
     */
    public boolean tryConsume(String bridgeId, boolean isVip) {
        if (isVip) {
            log.info("[RateLimiter] VIP bypass for bridge {}", bridgeId);
            return true;
        }

        // The window is folded into the key, so the store only has to count.
        long currentMinute = System.currentTimeMillis() / 60_000;
        long count = store.hit("ratelimit:std:" + bridgeId + ":" + currentMinute, WINDOW_TTL);

        boolean allowed = count <= STANDARD_LIMIT_PER_MINUTE;
        if (!allowed) {
            log.warn("[RateLimiter] STANDARD limit exceeded for bridge {} (count {})", bridgeId, count);
        }
        return allowed;
    }

    public String backend() {
        return store.backend();
    }
}
