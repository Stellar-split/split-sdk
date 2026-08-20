import { describe, it, expect, vi } from "vitest";
import { SimpleCache } from "../src/cache.js";

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

describe("SimpleCache has()", () => {
  it("returns true when key exists and is not expired", () => {
    const cache = new SimpleCache<string>({ ttlMs: 10000 });
    cache.set("key", "value");
    expect(cache.has("key")).toBe(true);
  });

  it("returns false when key does not exist", () => {
    const cache = new SimpleCache<string>({ ttlMs: 10000 });
    expect(cache.has("nonexistent")).toBe(false);
  });

  it("returns false for expired key", () => {
    const cache = new SimpleCache<string>({ ttlMs: 1 });
    cache.set("key", "value");
    // Wait for TTL to expire
    const start = Date.now();
    while (Date.now() - start < 5) {} // busy-wait ~5ms
    expect(cache.has("key")).toBe(false);
  });

  it("returns false when cache is disabled", () => {
    const cache = new SimpleCache<string>();
    cache.set("key", "value");
    expect(cache.has("key")).toBe(false);
  });
});

describe("SimpleCache purgeExpired()", () => {
  it("removes only expired entries", () => {
    const cache = new SimpleCache<string>({ ttlMs: 10000 });
    cache.set("fresh", "value");
    cache.set("stale", "value");
    // Manually set the stale entry to expired
    const store = (cache as any).store as Map<string, any>;
    const staleEntry = store.get("stale");
    if (staleEntry) {
      staleEntry.expiresAt = Date.now() - 1;
    }
    const removed = cache.purgeExpired();
    expect(removed).toBe(1);
    expect(cache.has("fresh")).toBe(true);
    expect(cache.has("stale")).toBe(false);
  });

  it("returns 0 when nothing is expired", () => {
    const cache = new SimpleCache<string>({ ttlMs: 10000 });
    cache.set("a", "1");
    cache.set("b", "2");
    expect(cache.purgeExpired()).toBe(0);
  });

  it("returns 0 when cache is disabled", () => {
    const cache = new SimpleCache<string>();
    expect(cache.purgeExpired()).toBe(0);
  });
});
