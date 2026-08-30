import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { parseRetryAfter } from "../src/throttle/RateLimitParser.js";
import {
  validateMetadataKeys,
  MAX_METADATA_KEY_LENGTH,
} from "../src/validators/invoiceMetadataValidator.js";
import {
  MemoryProfiler,
  ProfilerNotInitializedError,
} from "../src/memoryProfiler.js";
import { EnricherCache } from "../src/enricher.js";

describe("parseRetryAfter", () => {
  it("parses an integer second value", () => {
    expect(parseRetryAfter("3")).toBe(3000);
  });

  it("parses a fractional second value", () => {
    expect(parseRetryAfter("1.5")).toBe(1500);
  });

  it("parses a fractional value with many decimals", () => {
    expect(parseRetryAfter("0.25")).toBe(250);
  });

  it("returns 0 for '0'", () => {
    expect(parseRetryAfter("0")).toBe(0);
  });

  it("parses an HTTP-date format value", () => {
    const futureDate = new Date(Date.now() + 5000);
    const httpDate = futureDate.toUTCString();
    const result = parseRetryAfter(httpDate);
    expect(result).toBeGreaterThanOrEqual(4000);
    expect(result).toBeLessThanOrEqual(6000);
  });

  it("returns null for empty string", () => {
    expect(parseRetryAfter("")).toBeNull();
  });

  it("returns null for unparseable value", () => {
    expect(parseRetryAfter("unknown")).toBeNull();
  });

  it("returns 0 for a past HTTP-date", () => {
    const pastDate = new Date(Date.now() - 10000);
    const httpDate = pastDate.toUTCString();
    expect(parseRetryAfter(httpDate)).toBe(0);
  });

  it("returns non-negative for negative numeric input", () => {
    expect(parseRetryAfter("-5")).toBe(0);
  });
});

describe("validateMetadataKeys", () => {
  it("returns valid for undefined input", () => {
    expect(validateMetadataKeys(undefined)).toEqual({ valid: true });
  });

  it("returns valid for empty object", () => {
    expect(validateMetadataKeys({})).toEqual({ valid: true });
  });

  it("returns valid for keys within the limit", () => {
    const keys = { short: "value", another: "value2" };
    expect(validateMetadataKeys(keys)).toEqual({ valid: true });
  });

  it("returns invalid for a key exceeding max length", () => {
    const longKey = "a".repeat(MAX_METADATA_KEY_LENGTH + 1);
    const result = validateMetadataKeys({ [longKey]: "value" });
    expect(result.valid).toBe(false);
    expect(result.error).toContain(longKey);
    expect(result.error).toContain(String(MAX_METADATA_KEY_LENGTH + 1));
  });

  it("returns valid for a key exactly at max length", () => {
    const exactKey = "a".repeat(MAX_METADATA_KEY_LENGTH);
    expect(validateMetadataKeys({ [exactKey]: "value" })).toEqual({
      valid: true,
    });
  });

  it("validates nested custom keys", () => {
    const longNestedKey = "b".repeat(MAX_METADATA_KEY_LENGTH + 1);
    const input = { parent: { [longNestedKey]: "nested_value" } };
    const result = validateMetadataKeys(input);
    expect(result.valid).toBe(false);
    expect(result.error).toContain(longNestedKey);
  });

  it("returns valid for nested keys within limit", () => {
    const input = { parent: { child: "value" } };
    expect(validateMetadataKeys(input)).toEqual({ valid: true });
  });
});

describe("MemoryProfiler", () => {
  let profiler: MemoryProfiler;

  beforeEach(() => {
    profiler = new MemoryProfiler();
  });

  it("throws ProfilerNotInitializedError before init", () => {
    expect(() => profiler.snapshot()).toThrow(ProfilerNotInitializedError);
  });

  it("takes a snapshot after init", () => {
    profiler.init();
    const snap = profiler.snapshot();
    expect(snap.heapUsed).toBeGreaterThan(0);
    expect(snap.heapTotal).toBeGreaterThan(0);
    expect(snap.rss).toBeGreaterThan(0);
    expect(snap.timestamp).toBeGreaterThan(0);
  });

  it("records multiple snapshots", () => {
    profiler.init();
    profiler.snapshot();
    profiler.snapshot();
    expect(profiler.getSnapshots()).toHaveLength(2);
  });

  it("returns a copy of snapshots", () => {
    profiler.init();
    profiler.snapshot();
    const snaps = profiler.getSnapshots();
    snaps.pop();
    expect(profiler.getSnapshots()).toHaveLength(1);
  });

  it("exports a heap snapshot file", async () => {
    profiler.init();
    const filePath = await profiler.exportHeapSnapshot(
      "test-heap-export.heapsnapshot"
    );
    expect(filePath).toBeTruthy();
    const fs = await import("node:fs/promises");
    const stat = await fs.stat(filePath);
    expect(stat.size).toBeGreaterThan(0);
    await fs.unlink(filePath);
  });

  it("exports to a directory with auto-generated name", async () => {
    profiler.init();
    const filePath = await profiler.exportHeapSnapshot(".");
    expect(filePath).toMatch(/heap-.*\.heapsnapshot$/);
    const fs = await import("node:fs/promises");
    await fs.unlink(filePath);
  });

  it("reset clears snapshots", () => {
    profiler.init();
    profiler.snapshot();
    profiler.reset();
    expect(profiler.getSnapshots()).toHaveLength(0);
  });

  it("reset clears snapshots but keeps profiler initialized", () => {
    profiler.init();
    profiler.snapshot();
    profiler.reset();
    expect(profiler.getSnapshots()).toHaveLength(0);
    const snap = profiler.snapshot();
    expect(snap.heapUsed).toBeGreaterThan(0);
  });
});

describe("EnricherCache", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caches and returns the fetched value", async () => {
    const cache = new EnricherCache<string>();
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      return "result";
    };

    const result = await cache.getOrFetch("key1", fetcher);
    expect(result).toBe("result");
    expect(callCount).toBe(1);
  });

  it("returns cached value on second call without re-fetching", async () => {
    const cache = new EnricherCache<string>();
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      return "result";
    };

    await cache.getOrFetch("key1", fetcher);
    await cache.getOrFetch("key1", fetcher);
    expect(callCount).toBe(1);
  });

  it("expires entries after TTL", async () => {
    vi.useFakeTimers();
    const cache = new EnricherCache<string>(1000);
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      return "result";
    };

    await cache.getOrFetch("key1", fetcher);
    expect(callCount).toBe(1);

    vi.advanceTimersByTime(1100);
    await cache.getOrFetch("key1", fetcher);
    expect(callCount).toBe(2);
  });

  it("clearCache empties the cache", async () => {
    const cache = new EnricherCache<string>();
    let callCount = 0;
    const fetcher = async () => {
      callCount++;
      return "result";
    };

    await cache.getOrFetch("key1", fetcher);
    cache.clearCache();
    await cache.getOrFetch("key1", fetcher);
    expect(callCount).toBe(2);
  });

  it("size counts non-expired entries", async () => {
    vi.useFakeTimers();
    const cache = new EnricherCache<string>(1000);

    await cache.getOrFetch("a", async () => "1");
    await cache.getOrFetch("b", async () => "2");
    expect(cache.size).toBe(2);

    vi.advanceTimersByTime(1100);
    expect(cache.size).toBe(0);
  });

  it("uses default TTL of 60s", () => {
    const cache = new EnricherCache<string>();
    // Access private field for testing
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((cache as any)._ttlMs).toBe(60_000);
  });
});
