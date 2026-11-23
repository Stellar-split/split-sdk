import { describe, it, expect, vi, afterEach } from "vitest";
import { RpcConnectionPool } from "../src/connectionPool.js";

const ENDPOINT = "https://soroban-testnet.stellar.org";

describe("RpcConnectionPool (issue #1306)", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("pre-creates minConnections idle connections", () => {
    const pool = new RpcConnectionPool(ENDPOINT, { minConnections: 3 });
    const s = pool.getStats();
    expect(s.totalConnections).toBe(3);
    expect(s.idleConnections).toBe(3);
    expect(s.activeConnections).toBe(0);
  });

  it("reuses an idle connection after release", async () => {
    const pool = new RpcConnectionPool(ENDPOINT, { minConnections: 1, maxConnections: 5 });
    const a = await pool.acquire();
    pool.release(a);
    const b = await pool.acquire();
    expect(b.id).toBe(a.id);
    expect(pool.getStats().totalConnections).toBe(1);
  });

  it("grows up to maxConnections and never beyond", async () => {
    const pool = new RpcConnectionPool(ENDPOINT, { minConnections: 1, maxConnections: 2 });
    const a = await pool.acquire();
    const b = await pool.acquire();
    expect(a.id).not.toBe(b.id);
    const c = await pool.acquire();
    expect(pool.getStats().totalConnections).toBe(2);
    expect([a.id, b.id]).toContain(c.id);
  });

  it("tracks acquire/release counters and active/idle split", async () => {
    const pool = new RpcConnectionPool(ENDPOINT, { minConnections: 1, maxConnections: 3 });
    const a = await pool.acquire();
    expect(pool.getStats()).toMatchObject({ activeConnections: 1, totalAcquired: 1 });
    pool.release(a);
    expect(pool.getStats()).toMatchObject({
      activeConnections: 0,
      idleConnections: 1,
      totalReleased: 1,
    });
  });

  it("ignores release of a connection that is not active (no double release)", async () => {
    const pool = new RpcConnectionPool(ENDPOINT, { minConnections: 1 });
    const a = await pool.acquire();
    pool.release(a);
    pool.release(a);
    const s = pool.getStats();
    expect(s.totalReleased).toBe(1);
    expect(s.idleConnections).toBe(1);
  });

  it("evicts idle connections beyond the minimum after idleTimeoutMs", async () => {
    vi.useFakeTimers();
    const pool = new RpcConnectionPool(ENDPOINT, {
      minConnections: 1,
      maxConnections: 4,
      idleTimeoutMs: 1000,
    });
    const conns = [await pool.acquire(), await pool.acquire(), await pool.acquire()];
    conns.forEach((c) => pool.release(c));
    expect(pool.getStats().totalConnections).toBe(3);

    vi.advanceTimersByTime(1500);
    const next = await pool.acquire();
    pool.release(next);
    expect(pool.getStats().totalConnections).toBe(1);
  });

  it("drops an unhealthy connection on release when the action failed", async () => {
    const pool = new RpcConnectionPool(ENDPOINT, { minConnections: 1, maxConnections: 3 });
    const a = await pool.acquire();
    await expect(a.execute(async () => { throw new Error("rpc down"); })).rejects.toThrow("rpc down");
    expect(a.isHealthy).toBe(false);
    pool.release(a);
    const s = pool.getStats();
    expect(s.totalConnections).toBe(0);
    expect(s.failedHealthChecks).toBe(1);
  });

  it("checkHealth removes unhealthy connections and recovers to minConnections", async () => {
    const pool = new RpcConnectionPool(ENDPOINT, { minConnections: 2 });
    const a = await pool.acquire();
    a.isHealthy = false;
    pool.checkHealth();
    const s = pool.getStats();
    expect(s.totalConnections).toBe(2);
    expect(s.failedHealthChecks).toBe(1);
    const fresh = await pool.acquire();
    expect(fresh.id).not.toBe(a.id);
    expect(fresh.isHealthy).toBe(true);
  });

  it("execute passes through results for healthy actions", async () => {
    const pool = new RpcConnectionPool(ENDPOINT);
    const c = await pool.acquire();
    await expect(c.execute(async () => 42)).resolves.toBe(42);
    expect(c.isHealthy).toBe(true);
  });

  it("destroy clears all connections and stats gauges", async () => {
    const pool = new RpcConnectionPool(ENDPOINT, { minConnections: 2 });
    await pool.acquire();
    pool.destroy();
    expect(pool.getStats()).toMatchObject({
      totalConnections: 0,
      activeConnections: 0,
      idleConnections: 0,
    });
  });
});
