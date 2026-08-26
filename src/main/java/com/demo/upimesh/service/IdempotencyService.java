package com.demo.upimesh.service;

import com.demo.upimesh.store.IdempotencyStore;
import org.springframework.beans.factory.annotation.Autowired;
import org.springframework.beans.factory.annotation.Value;
import org.springframework.stereotype.Service;

import java.time.Duration;

/**
 * Idempotency cache.
 *
 * The contract:
 *   - claim(hash) returns true on first call, false on every call after that
 *     within the TTL window
 *   - the operation is atomic — if 100 threads call claim(hash) at the same
 *     instant, exactly one returns true
 *
 * This is what kills the "three bridges deliver simultaneously" problem. On the
 * in-memory store the guarantee holds within one instance; point REDIS_HOST at a
 * server and it holds across the whole cluster.
 */
@Service
public class IdempotencyService {

    @Autowired
    private IdempotencyStore store;

    @Value("${upi.mesh.idempotency-ttl-seconds:86400}")
    private long ttlSeconds;

    /**
     * Try to claim a hash. Returns true if this caller is the first; false if
     * someone else already claimed it (i.e. the packet is a duplicate).
     */
    public boolean claim(String packetHash) {
        return store.claim("idemp:" + packetHash, Duration.ofSeconds(ttlSeconds));
    }

    public int size() {
        return store.size();
    }

    /** Test/demo helper. */
    public void clear() {
        store.clear();
    }

    public String backend() {
        return store.backend();
    }
}
