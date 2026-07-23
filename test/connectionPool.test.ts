import { describe, expect, it } from "vitest";
import {
  ConnectionPool,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_SIZE,
  MAX_POOL_SIZE,
} from "../src/connectionPool.js";

describe("ConnectionPool (issue #360)", () => {
  it("falls back to a single connection when poolSize=1", () => {
    const pool = new ConnectionPool({
      rpcUrl: "https://soroban-testnet.stellar.org",
      poolSize: 1,
    });
    expect(pool.size).toBe(1);
    expect(pool.select()).toBeDefined();
  });

  it("defaults to DEFAULT_POOL_SIZE when poolSize is omitted", () => {
    const pool = new ConnectionPool({
      rpcUrl: "https://soroban-testnet.stellar.org",
    });
    expect(pool.size).toBe(DEFAULT_POOL_SIZE);
    expect(pool.size).toBeLessThanOrEqual(MAX_POOL_SIZE);
  });

  it("caps poolSize at MAX_POOL_SIZE", () => {
    const pool = new ConnectionPool({
      rpcUrl: "https://soroban-testnet.stellar.org",
      poolSize: 99,
    });
    expect(pool.size).toBe(MAX_POOL_SIZE);
  });

  it("floors poolSize to at least 1", () => {
    const pool = new ConnectionPool({
      rpcUrl: "https://soroban-testnet.stellar.org",
      poolSize: 0,
    });
    expect(pool.size).toBe(1);
  });

  it("rejects when rpcUrl is missing or empty", () => {
    expect(() => new ConnectionPool({ rpcUrl: "" })).toThrow();
  });

  it("falls back to a no-op pool for non-http schemes (ws://, ftp://, etc.)", () => {
    const pool = new ConnectionPool({
      rpcUrl: "ws://soroban-testnet.stellar.org",
      poolSize: 4,
    });
    expect(pool.size).toBe(1);
    expect(() => pool.select()).toThrow(/non-http|ConnectionPool|unsupported/i);
  });

  it("rejects non-finite poolSize inputs", () => {
    expect(() => new ConnectionPool({ rpcUrl: "https://x.example", poolSize: NaN }))
      .toThrow(/must be a finite number/);
    expect(() => new ConnectionPool({ rpcUrl: "https://x.example", poolSize: Infinity }))
      .toThrow(/must be a finite number/);
  });

  it("rotates selections across slots and tracks per-slot request counts", () => {
    const pool = new ConnectionPool({
      rpcUrl: "https://soroban-testnet.stellar.org",
      poolSize: 3,
    });

    for (let i = 0; i < 9; i++) pool.select();
    const stats = pool.getStats();

    expect(stats.totalRequests).toBe(9);
    expect(stats.poolSize).toBe(3);
    const sumSelections = stats.perSlot.reduce(
      (acc, slot) => acc + slot.totalRequests,
      0,
    );
    expect(sumSelections).toBe(9);
  });

  it("recycles a slot once it has been idle past idleTimeoutMs", () => {
    let now = 1_000_000;
    const pool = new ConnectionPool({
      rpcUrl: "https://soroban-testnet.stellar.org",
      poolSize: 2,
      idleTimeoutMs: 100,
      now: () => now,
    });

    const first = pool.select();
    expect(pool.getStats().recycledCount).toBe(0);

    // Slight churn without surpassing the idle timeout — no recycle yet.
    now += 60;
    pool.select();
    expect(pool.getStats().recycledCount).toBe(0);

    // Now beyond the idle window on a quiescent slot — expect a recycle.
    now += 60;
    const after = pool.select();
    expect(pool.getStats().recycledCount).toBeGreaterThanOrEqual(1);
    expect(after).toBeDefined();
    // The recycled slot's Server instance is fresh and not the same object.
    expect(after).not.toBe(first);
  });

  it("least-busy selection prefers slots with the lowest inFlight", () => {
    const pool = new ConnectionPool({
      rpcUrl: "https://soroban-testnet.stellar.org",
      poolSize: 3,
      now: () => 0,
    });

    // Saturate all three slots via acquire(), then release one and confirm
    // the next select() returns that released slot (least inFlight).
    const a = pool.acquire();
    const b = pool.acquire();
    const c = pool.acquire();
    expect(pool.totalInFlight).toBe(3);

    a.release();
    expect(pool.totalInFlight).toBe(2);

    const chosen = pool.select();
    expect(chosen).toBe(a.server);
    expect(pool.totalInFlight).toBe(2); // select() doesn't acquire a lease

    b.release();
    c.release();
    pool.dispose();
  });

  it("acquire/release tracks inFlight and error counts", () => {
    const pool = new ConnectionPool({
      rpcUrl: "https://soroban-testnet.stellar.org",
      poolSize: 2,
    });

    const first = pool.acquire();
    expect(first.server).toBeDefined();
    expect(pool.totalInFlight).toBe(1);

    first.release(false);
    expect(pool.totalInFlight).toBe(0);
    expect(pool.getStats().totalErrors).toBe(0);

    const second = pool.acquire();
    second.release(true);
    expect(pool.getStats().totalErrors).toBe(1);
  });

  it("recycles at the issue #360 default of 60s of inactivity", () => {
    let now = 0;
    const pool = new ConnectionPool({
      rpcUrl: "https://soroban-testnet.stellar.org",
      poolSize: 1,
      idleTimeoutMs: DEFAULT_IDLE_TIMEOUT_MS,
      now: () => now,
    });
    const before = pool.select();
    now += DEFAULT_IDLE_TIMEOUT_MS + 1;
    const after = pool.select();
    expect(after).not.toBe(before);
    expect(pool.getStats().recycledCount).toBe(1);
  });

  it("getStats distinguishes slots that have been used from untouched slots", () => {
    const pool = new ConnectionPool({
      rpcUrl: "https://soroban-testnet.stellar.org",
      poolSize: 2,
    });

    pool.select();
    const stats = pool.getStats();
    const touched = stats.perSlot.find((s) => s.totalRequests === 1);
    const untouched = stats.perSlot.find((s) => s.totalRequests === 0);
    expect(touched?.lastUsedAt).not.toBeNull();
    expect(untouched?.lastUsedAt).toBeNull();
  });

  it("availableCount reflects slots whose inFlight counter is zero", () => {
    const pool = new ConnectionPool({
      rpcUrl: "https://soroban-testnet.stellar.org",
      poolSize: 3,
    });

    expect(pool.getStats().availableCount).toBe(3);

    const lease = pool.acquire();
    const afterAcquire = pool.getStats();
    expect(afterAcquire.availableCount).toBe(2);
    expect(afterAcquire.totalInFlight).toBe(1);

    lease.release();
    expect(pool.getStats().availableCount).toBe(3);
  });

  it("recordError attributes errors to the slot owning the given server", () => {
    const pool = new ConnectionPool({
      rpcUrl: "https://soroban-testnet.stellar.org",
      poolSize: 2,
    });
    const a = pool.acquire();
    a.release();
    const target = a.server;

    pool.recordError(target);
    pool.recordError(target);

    expect(pool.getStats().totalErrors).toBe(2);
  });

  it("dispose is idempotent and prevents further select()/acquire() calls", () => {
    const pool = new ConnectionPool({
      rpcUrl: "https://soroban-testnet.stellar.org",
      poolSize: 2,
    });
    pool.dispose();
    pool.dispose();
    expect(pool.isDisposed).toBe(true);
    expect(() => pool.select()).toThrow();
    expect(() => pool.acquire()).toThrow();
  });

  it("accepts the legacy positional constructor signature", () => {
    const pool = new ConnectionPool(
      "https://soroban-testnet.stellar.org",
      3,
      false,
    );
    expect(pool.size).toBe(3);
  });
});
