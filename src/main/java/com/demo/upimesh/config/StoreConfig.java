package com.demo.upimesh.config;

import com.demo.upimesh.store.IdempotencyStore;
import com.demo.upimesh.store.RateLimitStore;
import com.demo.upimesh.store.TaskQueue;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.data.redis.connection.RedisConnection;
import org.springframework.data.redis.connection.RedisConnectionFactory;
import org.springframework.data.redis.core.StringRedisTemplate;

/**
 * Picks where idempotency claims, rate-limit windows and the ingestion queue
 * live.
 *
 * The demo has to run with nothing installed, so in-memory is the default and
 * every feature works on it. Redis is an upgrade rather than a requirement: set
 * REDIS_HOST to a reachable server and the same three concerns move there,
 * which is what makes them hold across more than one instance.
 *
 * The choice is made once, at startup, by pinging the server. Deciding per-call
 * would mean a claim could land in Redis and its duplicate in local memory,
 * which is worse than either backend on its own.
 */
@Configuration
public class StoreConfig {

    private static final Logger log = LoggerFactory.getLogger(StoreConfig.class);

    private boolean redisReachable(RedisConnectionFactory factory) {
        if (factory == null) return false;
        try (RedisConnection conn = factory.getConnection()) {
            conn.ping();
            return true;
        } catch (Exception e) {
            log.info("Redis not reachable ({}). Using in-memory stores — every feature "
                    + "still works; set REDIS_HOST to distribute them across instances.",
                    e.getMessage());
            return false;
        }
    }

    @Bean
    public StoreBackend storeBackend(StringRedisTemplate redis) {
        boolean up = redisReachable(redis.getConnectionFactory());
        if (up) log.info("Redis reachable — idempotency, rate limiting and the ingestion queue are distributed.");
        return new StoreBackend(up, redis);
    }

    @Bean
    public IdempotencyStore idempotencyStore(StoreBackend backend) {
        return backend.redisUp()
                ? new IdempotencyStore.Redis(backend.redis())
                : new IdempotencyStore.InMemory();
    }

    @Bean
    public RateLimitStore rateLimitStore(StoreBackend backend) {
        return backend.redisUp()
                ? new RateLimitStore.Redis(backend.redis())
                : new RateLimitStore.InMemory();
    }

    @Bean
    public TaskQueue taskQueue(StoreBackend backend) {
        return backend.redisUp()
                ? new TaskQueue.Redis(backend.redis())
                : new TaskQueue.InMemory();
    }

    /** Result of the one-time probe, so all three stores agree on where they live. */
    public record StoreBackend(boolean redisUp, StringRedisTemplate redis) {
        public String name() { return redisUp ? "redis" : "memory"; }
    }
}
