import { describe, it, expect, vi } from "vitest";
import { SdkConnectionPool } from "../src/sdkConnectionPool.js";

describe("SdkConnectionPool", () => {
  it("reuses released connections", async () => {
    let n = 0;
    const pool = new SdkConnectionPool({ create: async () => ({ id: ++n }), max: 2 });
    const a = await pool.acquire();
    pool.release(a);
    const b = await pool.acquire();
    expect(b).toBe(a);
    expect(pool.stats()).toMatchObject({ created: 1, reused: 1, active: 1 });
  });

  it("queues when at max and serves on release", async () => {
    const pool = new SdkConnectionPool({ create: async () => ({}), max: 1 });
    const a = await pool.acquire();
    const p = pool.acquire();
    expect(pool.stats().waiting).toBe(1);
    pool.release(a);
    expect(await p).toBe(a);
  });

  it("shrinks idle items on resize and drains", async () => {
    const destroy = vi.fn();
    const pool = new SdkConnectionPool({ create: async () => ({}), destroy, max: 3 });
    const items = await Promise.all([pool.acquire(), pool.acquire(), pool.acquire()]);
    items.forEach((i) => pool.release(i));
    await pool.resize(0, 1);
    expect(pool.stats().size).toBe(1);
    await pool.drain();
    expect(destroy).toHaveBeenCalledTimes(3);
  });
});
