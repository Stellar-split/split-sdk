import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SimpleCache } from "../src/cache.js";
import type { CacheEvent } from "../src/cache.js";

describe("SimpleCache behavior (issue #1304)", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("caches values and counts hits and misses", () => {
    const c = new SimpleCache<number>(1000);
    expect(c.get("a")).toBeUndefined();
    c.set("a", 1);
    expect(c.get("a")).toBe(1);
    expect(c.get("a")).toBe(1);
    const s = c.getStats();
    expect(s.hits).toBe(2);
    expect(s.misses).toBe(1);
    expect(s.size).toBe(1);
  });

  it("is a no-op when disabled (no ttl configured)", () => {
    const c = new SimpleCache<number>({});
    c.set("a", 1);
    expect(c.get("a")).toBeUndefined();
    expect(c.getStats().size).toBe(0);
  });

  it("expires entries after their ttl", () => {
    const c = new SimpleCache<string>(100);
    c.set("a", "x");
    vi.advanceTimersByTime(99);
    expect(c.get("a")).toBe("x");
    vi.advanceTimersByTime(2);
    expect(c.get("a")).toBeUndefined();
    expect(c.getStats().size).toBe(0);
  });

  it("applies per-method ttl policies, falling back to default and skipping ttl<=0", () => {
    const c = new SimpleCache<string>({ ttl: { getInvoice: 1000, getFee: 0, default: 50 } });
    c.set("getInvoice:1", "inv");
    c.set("getFee:1", "fee");
    c.set("other:1", "o");
    expect(c.get("getFee:1")).toBeUndefined();
    vi.advanceTimersByTime(100);
    expect(c.get("other:1")).toBeUndefined();
    expect(c.get("getInvoice:1")).toBe("inv");
  });

  it("invalidates by exact key, by method prefix, with args, and all", () => {
    const c = new SimpleCache<number>(1000);
    c.set("getInvoice:[1]", 1);
    c.set("getInvoice:[2]", 2);
    c.set("pay:[1]", 3);
    c.invalidate("getInvoice", [1]);
    expect(c.get("getInvoice:[1]")).toBeUndefined();
    expect(c.get("getInvoice:[2]")).toBe(2);
    c.invalidate("getInvoice");
    expect(c.get("getInvoice:[2]")).toBeUndefined();
    expect(c.get("pay:[1]")).toBe(3);
    c.invalidate();
    expect(c.getStats().size).toBe(0);
  });

  it("evicts the least recently used entry when maxEntries is reached", () => {
    const c = new SimpleCache<number>({ ttlMs: 1000, maxEntries: 2 });
    c.set("a", 1);
    c.set("b", 2);
    c.get("a"); // a becomes most recent
    c.set("c", 3);
    expect(c.get("b")).toBeUndefined();
    expect(c.get("a")).toBe(1);
    expect(c.get("c")).toBe(3);
    expect(c.getStats().evictions).toBe(1);
  });

  it("overwriting an existing key does not evict", () => {
    const c = new SimpleCache<number>({ ttlMs: 1000, maxEntries: 2 });
    c.set("a", 1);
    c.set("b", 2);
    c.set("a", 10);
    expect(c.getStats().evictions).toBe(0);
    expect(c.get("a")).toBe(10);
    expect(c.get("b")).toBe(2);
  });

  it("emits lifecycle events and supports unsubscribe", () => {
    const c = new SimpleCache<number>(1000);
    const events: CacheEvent[] = [];
    const off = c.on((e) => events.push(e));
    c.get("a");
    c.set("a", 1);
    c.get("a");
    c.invalidate("a");
    expect(events.map((e) => e.type)).toEqual(["miss", "set", "hit", "invalidate"]);
    off();
    c.get("a");
    expect(events).toHaveLength(4);
  });

  it("stays consistent under concurrent async readers and writers", async () => {
    const c = new SimpleCache<number>(1000);
    await Promise.all(
      Array.from({ length: 50 }, async (_, i) => {
        await Promise.resolve();
        c.set(`k${i % 5}`, i);
        c.get(`k${i % 5}`);
      }),
    );
    const s = c.getStats();
    expect(s.size).toBe(5);
    expect(s.hits).toBe(50);
  });

  it("clear empties the store", () => {
    const c = new SimpleCache<number>(1000);
    c.set("a", 1);
    c.clear();
    expect(c.get("a")).toBeUndefined();
  });

  it("round-trips compressed values transparently", () => {
    const c = new SimpleCache<{ s: string }>({ ttlMs: 1000, compression: { enabled: true, threshold: 10 } });
    const v = { s: "abc".repeat(500) };
    c.set("big", v);
    expect(c.get("big")).toBeDefined();
    expect(c.entries().get("big")).toEqual(v);
  });
});
