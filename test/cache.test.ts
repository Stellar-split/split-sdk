import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { SimpleCache, Cache } from "../src/cache.js";

describe("SimpleCache LRU", () => {
  it("evicts the oldest entry when maxEntries is exceeded", () => {
    const cache = new SimpleCache<string>({ ttlMs: 10000, maxEntries: 3 });

    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");
    
    // Cache is full. Next set should evict "a" (oldest).
    cache.set("d", "4");

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
    expect(cache.get("c")).toBe("3");
    expect(cache.get("d")).toBe("4");

    const stats = cache.getStats();
    expect(stats.size).toBe(3);
    expect(stats.evictions).toBe(1);
  });

  it("updates LRU order on get()", () => {
    const cache = new SimpleCache<string>({ ttlMs: 10000, maxEntries: 3 });

    cache.set("a", "1");
    cache.set("b", "2");
    cache.set("c", "3");

    // Read "a", making it the most recently used
    cache.get("a");

    // Cache is full. Next set should evict "b" (now the oldest).
    cache.set("d", "4");

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBe("1");
    expect(cache.get("c")).toBe("3");
    expect(cache.get("d")).toBe("4");

    const stats = cache.getStats();
    expect(stats.size).toBe(3);
    expect(stats.evictions).toBe(1);
  });

  it("defaults to maxEntries 1000 if cache is enabled", () => {
    const cache = new SimpleCache<string>({ ttlMs: 10000 });
    
    // Instead of setting 1000, let's just inspect it if we can or trust the code.
    // The code sets this.maxEntries to 1000.
    for (let i = 0; i < 1005; i++) {
      cache.set(`k${i}`, "v");
    }

    const stats = cache.getStats();
    expect(stats.size).toBe(1000);
    expect(stats.evictions).toBe(5);
  });

  it("allows 0 maxEntries to mean unbounded cache", () => {
    const cache = new SimpleCache<string>({ ttlMs: 10000, maxEntries: 0 });
    
    for (let i = 0; i < 1005; i++) {
      cache.set(`k${i}`, "v");
    }

    const stats = cache.getStats();
    expect(stats.size).toBe(1005);
    expect(stats.evictions).toBe(0);
  });
});

describe("Cache – TTL-based expiry", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  // ── construction ──────────────────────────────────────────────────────────

  it("accepts an optional ttlMs constructor argument", () => {
    const withTtl = new Cache<string>(1000);
    const withoutTtl = new Cache<string>();
    expect(withTtl).toBeDefined();
    expect(withoutTtl).toBeDefined();
  });

  // ── set / get ─────────────────────────────────────────────────────────────

  it("get() returns the value before TTL elapses", () => {
    const cache = new Cache<string>(1000);
    cache.set("key", "value");
    vi.advanceTimersByTime(999);
    expect(cache.get("key")).toBe("value");
  });

  it("get() returns undefined and removes the entry after TTL elapses", () => {
    const cache = new Cache<string>(1000);
    cache.set("key", "value");
    vi.advanceTimersByTime(1001);
    expect(cache.get("key")).toBeUndefined();
    // Entry must have been deleted
    expect(cache.size).toBe(0);
  });

  it("get() returns undefined for a missing key", () => {
    const cache = new Cache<string>(1000);
    expect(cache.get("nonexistent")).toBeUndefined();
  });

  it("records the write timestamp at the moment of set()", () => {
    const cache = new Cache<number>(500);
    vi.advanceTimersByTime(200);
    cache.set("k", 42); // written at t=200
    vi.advanceTimersByTime(400); // now t=600; 400 ms after write > 500 ms TTL? no: 400 < 500
    expect(cache.get("k")).toBe(42);
    vi.advanceTimersByTime(101); // now t=701; 501 ms after write — expired
    expect(cache.get("k")).toBeUndefined();
  });

  // ── has() ─────────────────────────────────────────────────────────────────

  it("has() returns true for an entry that has not expired", () => {
    const cache = new Cache<string>(1000);
    cache.set("key", "value");
    vi.advanceTimersByTime(500);
    expect(cache.has("key")).toBe(true);
  });

  it("has() returns false for an expired entry and removes it", () => {
    const cache = new Cache<string>(1000);
    cache.set("key", "value");
    vi.advanceTimersByTime(1001);
    expect(cache.has("key")).toBe(false);
    expect(cache.size).toBe(0);
  });

  it("has() returns false for a missing key", () => {
    const cache = new Cache<string>(1000);
    expect(cache.has("ghost")).toBe(false);
  });

  // ── purgeExpired() ────────────────────────────────────────────────────────

  it("purgeExpired() removes only expired entries", () => {
    const cache = new Cache<string>(1000);
    cache.set("fresh", "a");
    vi.advanceTimersByTime(500);
    cache.set("also-fresh", "b");
    vi.advanceTimersByTime(600); // "fresh" is now 1100 ms old (expired); "also-fresh" is 600 ms old (not expired)
    cache.purgeExpired();
    expect(cache.get("fresh")).toBeUndefined();
    expect(cache.get("also-fresh")).toBe("b");
    expect(cache.size).toBe(1);
  });

  it("purgeExpired() removes all entries when all are expired", () => {
    const cache = new Cache<number>(500);
    cache.set("a", 1);
    cache.set("b", 2);
    cache.set("c", 3);
    vi.advanceTimersByTime(600);
    cache.purgeExpired();
    expect(cache.size).toBe(0);
  });

  it("purgeExpired() is a no-op when no TTL is configured", () => {
    const cache = new Cache<string>(); // no TTL
    cache.set("x", "1");
    cache.set("y", "2");
    vi.advanceTimersByTime(999999);
    cache.purgeExpired();
    // entries should still be present
    expect(cache.get("x")).toBe("1");
    expect(cache.get("y")).toBe("2");
  });

  // ── no-expiry (backward compatibility) ───────────────────────────────────

  it("entries never expire when ttlMs is not provided", () => {
    const cache = new Cache<string>();
    cache.set("forever", "value");
    vi.advanceTimersByTime(Number.MAX_SAFE_INTEGER / 2);
    expect(cache.get("forever")).toBe("value");
    expect(cache.has("forever")).toBe(true);
  });

  // ── delete / clear ────────────────────────────────────────────────────────

  it("delete() removes a specific entry", () => {
    const cache = new Cache<string>(5000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.delete("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
  });

  it("clear() removes all entries", () => {
    const cache = new Cache<string>(5000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.size).toBe(0);
  });

  // ── size ──────────────────────────────────────────────────────────────────

  it("size reflects the number of stored entries", () => {
    const cache = new Cache<number>(5000);
    expect(cache.size).toBe(0);
    cache.set("x", 1);
    expect(cache.size).toBe(1);
    cache.set("y", 2);
    expect(cache.size).toBe(2);
    cache.delete("x");
    expect(cache.size).toBe(1);
  });
});
