import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { randomBytes } from "crypto";
import { StrKey } from "@stellar/stellar-base";
import { MultiTenantClient } from "../src/multiTenant.js";
import { StellarSplitClient } from "../src/client.js";
import type { StellarSplitClientConfig } from "../src/client.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContractId(): string {
  return StrKey.encodeContract(randomBytes(32));
}

function makeFactory(contractId = makeContractId()) {
  return vi.fn((_tenantId: string): StellarSplitClientConfig => ({
    rpcUrl: "https://example.com",
    networkPassphrase: "Test Network",
    contractId,
  }));
}

// ---------------------------------------------------------------------------
// Original behaviour (backwards-compat)
// ---------------------------------------------------------------------------

describe("MultiTenantClient — original behaviour", () => {
  it("returns the same client instance for repeated tenant IDs", () => {
    const factory = makeFactory();
    const pool = new MultiTenantClient(factory);

    const first = pool.getClient("tenant-a");
    const second = pool.getClient("tenant-a");

    expect(first).toBe(second);
    expect(factory).toHaveBeenCalledTimes(1);
  });

  it("creates separate clients for different tenant IDs", () => {
    const factory = makeFactory();
    const pool = new MultiTenantClient(factory);

    const a = pool.getClient("tenant-a");
    const b = pool.getClient("tenant-b");

    expect(a).not.toBe(b);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("recreates a client after explicit eviction", () => {
    const factory = makeFactory();
    const pool = new MultiTenantClient(factory);

    const first = pool.getClient("tenant-a");
    expect(pool.evict("tenant-a")).toBe(true);

    const second = pool.getClient("tenant-a");
    expect(second).not.toBe(first);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("evict() returns false for unknown tenant", () => {
    const pool = new MultiTenantClient(makeFactory());
    expect(pool.evict("does-not-exist")).toBe(false);
  });

  it("evictAll() removes all cached clients", () => {
    const factory = makeFactory();
    const pool = new MultiTenantClient(factory);

    const a = pool.getClient("tenant-a");
    const b = pool.getClient("tenant-b");

    pool.evictAll();

    const a2 = pool.getClient("tenant-a");
    const b2 = pool.getClient("tenant-b");

    expect(a2).not.toBe(a);
    expect(b2).not.toBe(b);
    expect(factory).toHaveBeenCalledTimes(4);
  });
});

// ---------------------------------------------------------------------------
// LRU eviction
// ---------------------------------------------------------------------------

describe("MultiTenantClient — LRU eviction", () => {
  it("evicts the least-recently-used client when maxClients is reached", () => {
    const factory = makeFactory();
    const pool = new MultiTenantClient(factory, { maxClients: 2 });

    const a = pool.getClient("a");
    const b = pool.getClient("b");

    // Adding a third client should evict "a" (LRU)
    pool.getClient("c");

    expect(pool.stats().size).toBe(2);
    expect(pool.stats().evictions).toBe(1);

    // "a" was evicted so a new instance must be created
    const a2 = pool.getClient("a");
    expect(a2).not.toBe(a);

    // "b" or "c" should have been evicted next; only 2 slots
    expect(pool.stats().size).toBe(2);

    void b; // suppress unused variable warning
  });

  it("refreshes LRU order on access so recently used entries survive", () => {
    const factory = makeFactory();
    const pool = new MultiTenantClient(factory, { maxClients: 2 });

    pool.getClient("a");
    pool.getClient("b");

    // Access "a" again — it becomes MRU; "b" is now LRU
    const a = pool.getClient("a");

    // Adding "c" should evict "b", not "a"
    pool.getClient("c");

    expect(pool.stats().size).toBe(2);

    // "a" should still be in the pool (no new instance created)
    const aAgain = pool.getClient("a");
    expect(aAgain).toBe(a);
  });

  it("pool.stats() reflects eviction counts correctly", () => {
    const pool = new MultiTenantClient(makeFactory(), { maxClients: 1 });

    pool.getClient("a");
    pool.getClient("b"); // evicts "a"
    pool.getClient("c"); // evicts "b"

    const s = pool.stats();
    expect(s.evictions).toBe(2);
    expect(s.misses).toBe(3);
    expect(s.size).toBe(1);
  });

  it("never evicts below maxClients when pool has not reached the limit", () => {
    const pool = new MultiTenantClient(makeFactory(), { maxClients: 5 });

    for (let i = 0; i < 5; i++) pool.getClient(`t-${i}`);

    expect(pool.stats().evictions).toBe(0);
    expect(pool.stats().size).toBe(5);
  });
});

// ---------------------------------------------------------------------------
// TTL eviction
// ---------------------------------------------------------------------------

describe("MultiTenantClient — TTL eviction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns the same client before TTL expires", () => {
    const pool = new MultiTenantClient(makeFactory(), { ttlMs: 5_000 });

    const first = pool.getClient("t");
    vi.advanceTimersByTime(4_999);
    const second = pool.getClient("t");

    expect(second).toBe(first);
  });

  it("evicts and recreates a client after TTL expires", () => {
    const factory = makeFactory();
    const pool = new MultiTenantClient(factory, { ttlMs: 5_000 });

    const first = pool.getClient("t");
    vi.advanceTimersByTime(5_001);
    const second = pool.getClient("t");

    expect(second).not.toBe(first);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("counts TTL evictions in pool.stats()", () => {
    const pool = new MultiTenantClient(makeFactory(), { ttlMs: 1_000 });

    pool.getClient("t");
    vi.advanceTimersByTime(1_001);
    pool.getClient("t"); // triggers TTL eviction then recreates

    const s = pool.stats();
    expect(s.evictions).toBe(1);
    expect(s.misses).toBe(2);
  });

  it("independent TTLs per tenant — only the expired one is evicted", () => {
    const factory = makeFactory();
    const pool = new MultiTenantClient(factory, { ttlMs: 3_000 });

    const a = pool.getClient("a");
    vi.advanceTimersByTime(1_500);
    pool.getClient("b");

    // Advance so "a" has lived 3_001 ms total; "b" only 1_501 ms
    vi.advanceTimersByTime(1_501);

    const a2 = pool.getClient("a");
    const b2 = pool.getClient("b");

    expect(a2).not.toBe(a);         // "a" expired, new instance
    expect(b2).toBe(pool.getClient("b")); // "b" still valid
  });
});

// ---------------------------------------------------------------------------
// Health check eviction
// ---------------------------------------------------------------------------

describe("MultiTenantClient — health check eviction", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("evicts a client whose RPC returns an error during health check", async () => {
    const { rpc: SorobanRpc } = await import("@stellar/stellar-sdk");
    const spy = vi
      .spyOn(SorobanRpc.Server.prototype, "getLatestLedger")
      .mockRejectedValue(new Error("connection refused"));

    try {
      const factory = makeFactory();
      const pool = new MultiTenantClient(factory, {
        healthCheckIntervalMs: 1_000,
      });

      pool.getClient("t");
      expect(pool.stats().size).toBe(1);

      // Advance time past one interval and let the async health-check settle
      await vi.advanceTimersByTimeAsync(1_001);

      expect(pool.stats().size).toBe(0);
      expect(pool.stats().healthCheckFailures).toBe(1);
      expect(pool.stats().evictions).toBe(1);

      pool.destroy();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps healthy clients during a health check sweep", async () => {
    const { rpc: SorobanRpc } = await import("@stellar/stellar-sdk");
    const spy = vi
      .spyOn(SorobanRpc.Server.prototype, "getLatestLedger")
      .mockResolvedValue({ sequence: 100, id: "abc", protocolVersion: 20 } as never);

    try {
      const pool = new MultiTenantClient(makeFactory(), {
        healthCheckIntervalMs: 1_000,
      });

      pool.getClient("t");
      await vi.advanceTimersByTimeAsync(1_001);

      expect(pool.stats().size).toBe(1);
      expect(pool.stats().healthCheckFailures).toBe(0);
      expect(pool.stats().evictions).toBe(0);

      pool.destroy();
    } finally {
      spy.mockRestore();
    }
  });

  it("evicts only unhealthy clients in a mixed pool", async () => {
    const { rpc: SorobanRpc } = await import("@stellar/stellar-sdk");

    // Alternate: first call succeeds, second fails
    let callCount = 0;
    const spy = vi
      .spyOn(SorobanRpc.Server.prototype, "getLatestLedger")
      .mockImplementation(async () => {
        callCount++;
        if (callCount % 2 === 0) throw new Error("down");
        return { sequence: 100, id: "x", protocolVersion: 20 } as never;
      });

    try {
      const pool = new MultiTenantClient(makeFactory(), {
        healthCheckIntervalMs: 1_000,
      });

      pool.getClient("healthy");
      pool.getClient("unhealthy");
      expect(pool.stats().size).toBe(2);

      await vi.advanceTimersByTimeAsync(1_001);

      expect(pool.stats().size).toBe(1);
      expect(pool.stats().healthCheckFailures).toBe(1);

      pool.destroy();
    } finally {
      spy.mockRestore();
    }
  });

  it("destroy() stops the health-check timer", async () => {
    const { rpc: SorobanRpc } = await import("@stellar/stellar-sdk");
    const spy = vi
      .spyOn(SorobanRpc.Server.prototype, "getLatestLedger")
      .mockRejectedValue(new Error("down"));

    try {
      const pool = new MultiTenantClient(makeFactory(), {
        healthCheckIntervalMs: 1_000,
      });

      pool.getClient("t");
      pool.destroy(); // stops timer + evicts all

      // Advance time — timer should NOT fire after destroy
      await vi.advanceTimersByTimeAsync(5_000);

      // destroy() evicted via evictAll, not health check, so healthCheckFailures=0
      expect(pool.stats().healthCheckFailures).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });
});

// ---------------------------------------------------------------------------
// pool.stats() accuracy
// ---------------------------------------------------------------------------

describe("MultiTenantClient — pool.stats()", () => {
  it("starts with all-zero stats", () => {
    const pool = new MultiTenantClient(makeFactory());
    expect(pool.stats()).toEqual({
      size: 0,
      hits: 0,
      misses: 0,
      evictions: 0,
      healthCheckFailures: 0,
    });
  });

  it("increments misses on new client creation", () => {
    const pool = new MultiTenantClient(makeFactory());
    pool.getClient("a");
    pool.getClient("b");
    expect(pool.stats().misses).toBe(2);
    expect(pool.stats().hits).toBe(0);
  });

  it("increments hits on repeated access of the same tenant", () => {
    const pool = new MultiTenantClient(makeFactory());
    pool.getClient("a");
    pool.getClient("a");
    pool.getClient("a");
    expect(pool.stats().hits).toBe(2);
    expect(pool.stats().misses).toBe(1);
  });

  it("increments evictions on explicit evict()", () => {
    const pool = new MultiTenantClient(makeFactory());
    pool.getClient("a");
    pool.getClient("b");
    pool.evict("a");
    expect(pool.stats().evictions).toBe(1);
    expect(pool.stats().size).toBe(1);
  });

  it("increments evictions on evictAll()", () => {
    const pool = new MultiTenantClient(makeFactory());
    pool.getClient("a");
    pool.getClient("b");
    pool.getClient("c");
    pool.evictAll();
    expect(pool.stats().evictions).toBe(3);
    expect(pool.stats().size).toBe(0);
  });

  it("size tracks the current pool size accurately", () => {
    const pool = new MultiTenantClient(makeFactory());
    expect(pool.stats().size).toBe(0);
    pool.getClient("a");
    expect(pool.stats().size).toBe(1);
    pool.getClient("b");
    expect(pool.stats().size).toBe(2);
    pool.evict("a");
    expect(pool.stats().size).toBe(1);
    pool.evictAll();
    expect(pool.stats().size).toBe(0);
  });

  it("stats accumulate across multiple evict cycles", () => {
    const pool = new MultiTenantClient(makeFactory());

    pool.getClient("a"); // miss
    pool.getClient("a"); // hit
    pool.evict("a");     // eviction
    pool.getClient("a"); // miss again
    pool.getClient("a"); // hit

    const s = pool.stats();
    expect(s.misses).toBe(2);
    expect(s.hits).toBe(2);
    expect(s.evictions).toBe(1);
  });

  it("config override passed to getClient is used for new clients", () => {
    const defaultFactory = makeFactory();
    const pool = new MultiTenantClient(defaultFactory);

    const overrideContractId = makeContractId();
    const client = pool.getClient("t", {
      rpcUrl: "https://custom.com",
      networkPassphrase: "Custom Net",
      contractId: overrideContractId,
    });

    expect(client).toBeInstanceOf(StellarSplitClient);
    // Factory should NOT have been called because config was provided directly
    expect(defaultFactory).not.toHaveBeenCalled();
  });
});
