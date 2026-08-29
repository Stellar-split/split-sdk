import { describe, it, expect, vi, afterEach } from "vitest";
import { parseRateLimitHeaders } from "../src/throttle/RateLimitParser.js";
import { AdaptiveThrottle, DEFAULT_PENALTY_DURATION_MS } from "../src/throttle/AdaptiveThrottle.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("parseRateLimitHeaders", () => {
  it("parses a real Headers object", () => {
    const headers = new Headers({
      "X-RateLimit-Limit": "100",
      "X-RateLimit-Remaining": "42",
      "X-RateLimit-Reset": "1700000000",
    });
    expect(parseRateLimitHeaders(headers)).toEqual({
      limit: 100,
      remaining: 42,
      resetAt: 1_700_000_000_000,
    });
  });

  it("parses a plain-object header map, case-insensitively", () => {
    const headers = {
      "x-ratelimit-limit": "10",
      "x-ratelimit-remaining": "3",
      "x-ratelimit-reset": "1000",
    };
    expect(parseRateLimitHeaders(headers)).toEqual({
      limit: 10,
      remaining: 3,
      resetAt: 1_000_000,
    });
  });

  it("defaults to Infinity/Infinity/0 when headers are missing", () => {
    expect(parseRateLimitHeaders({})).toEqual({
      limit: Infinity,
      remaining: Infinity,
      resetAt: 0,
    });
  });

  it("defaults partially when only some headers are present", () => {
    expect(parseRateLimitHeaders({ "X-RateLimit-Limit": "50" })).toEqual({
      limit: 50,
      remaining: Infinity,
      resetAt: 0,
    });
  });
});

describe("AdaptiveThrottle", () => {
  it("acquire() resolves immediately while unthrottled (no headers observed yet)", async () => {
    const throttle = new AdaptiveThrottle();
    await expect(throttle.acquire()).resolves.toBeUndefined();
    expect(throttle.getStats().refillRate).toBe(Infinity);
  });

  it("update() sizes the bucket from parsed rate-limit headers", () => {
    let now = 0;
    const throttle = new AdaptiveThrottle({ now: () => now });
    throttle.update({ limit: 10, remaining: 4, resetAt: 1_000 });
    const stats = throttle.getStats();
    expect(stats.tokenCount).toBe(4);
    expect(stats.refillRate).toBeCloseTo(10 / 1_000);
  });

  it("spreads a burst of 50 concurrent calls so no more than `limit` dispatch per window", async () => {
    vi.useFakeTimers();
    let now = 0;
    const throttle = new AdaptiveThrottle({ now: () => now });
    // 10 tokens per 1000ms window.
    throttle.update({ limit: 10, remaining: 10, resetAt: 1_000 });

    let resolvedCount = 0;
    const acquisitions = Array.from({ length: 50 }, () =>
      throttle.acquire().then(() => {
        resolvedCount += 1;
      }),
    );

    // Allow the initial (already-available) tokens to resolve synchronously.
    await vi.advanceTimersByTimeAsync(0);
    expect(resolvedCount).toBeLessThanOrEqual(10);
    const afterFirstWindow = resolvedCount;

    // Advance through 4 more ~1s windows (needs manual `now` advancement
    // alongside the fake timer clock, since AdaptiveThrottle uses the
    // injected `now` rather than Date.now()).
    for (let i = 0; i < 5; i++) {
      now += 1_000;
      await vi.advanceTimersByTimeAsync(1_000);
    }

    await Promise.all(acquisitions);
    expect(resolvedCount).toBe(50);
    expect(afterFirstWindow).toBeLessThanOrEqual(10);
  });

  it("recordRateLimited() halves the refill rate", () => {
    let now = 0;
    const throttle = new AdaptiveThrottle({ now: () => now });
    throttle.update({ limit: 10, remaining: 10, resetAt: 1_000 });
    const before = throttle.getStats().refillRate;

    throttle.recordRateLimited();
    const after = throttle.getStats().refillRate;

    expect(after).toBeCloseTo(before / 2);
    expect(throttle.getStats().penalized).toBe(true);
  });

  it("recordRateLimited() delays subsequent calls by at least penaltyDurationMs", async () => {
    vi.useFakeTimers();
    let now = 0;
    const throttle = new AdaptiveThrottle({ now: () => now, penaltyDurationMs: 5_000 });
    throttle.update({ limit: 10, remaining: 0, resetAt: 1_000 });
    throttle.recordRateLimited();

    let resolved = false;
    void throttle.acquire().then(() => {
      resolved = true;
    });

    now += 4_999;
    await vi.advanceTimersByTimeAsync(4_999);
    expect(resolved).toBe(false);
    expect(throttle.getStats().penalized).toBe(true);

    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(throttle.getStats().penalized).toBe(false);
  });

  it("uses the default penalty duration of 5 000ms when unspecified", () => {
    expect(DEFAULT_PENALTY_DURATION_MS).toBe(5_000);
  });

  it("getStats() reports tokenCount, refillRate, penalized, and pendingQueueDepth", async () => {
    let now = 0;
    const throttle = new AdaptiveThrottle({ now: () => now });
    throttle.update({ limit: 1, remaining: 0, resetAt: 10_000 });

    void throttle.acquire();
    void throttle.acquire();

    const stats = throttle.getStats();
    expect(stats).toHaveProperty("tokenCount");
    expect(stats).toHaveProperty("refillRate");
    expect(stats).toHaveProperty("penalized");
    expect(stats.pendingQueueDepth).toBe(2);
  });

  it("wrapFetch acquires a token, then updates from response headers and records 429s", async () => {
    let now = 0;
    const throttle = new AdaptiveThrottle({ now: () => now });
    const acquireSpy = vi.spyOn(throttle, "acquire");

    const fakeFetch = vi.fn().mockResolvedValue(
      new Response(null, {
        status: 429,
        headers: {
          "X-RateLimit-Limit": "5",
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": "1",
        },
      }),
    );

    const throttledFetch = throttle.wrapFetch(fakeFetch as unknown as typeof fetch);
    await throttledFetch("https://example.com");

    expect(acquireSpy).toHaveBeenCalledTimes(1);
    expect(fakeFetch).toHaveBeenCalledTimes(1);
    expect(throttle.getStats().penalized).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Exponential backoff (getBackoffMultiplier + maxBackoffMs)
// ---------------------------------------------------------------------------

import { DEFAULT_MAX_BACKOFF_MS } from "../src/throttle/AdaptiveThrottle.js";

describe("exponential backoff", () => {
  it("DEFAULT_MAX_BACKOFF_MS is 60 000", () => {
    expect(DEFAULT_MAX_BACKOFF_MS).toBe(60_000);
  });

  it("getBackoffMultiplier() returns 1 with no breaches", () => {
    const throttle = new AdaptiveThrottle();
    expect(throttle.getBackoffMultiplier()).toBe(1);
  });

  it("getBackoffMultiplier() doubles after each consecutive breach", () => {
    vi.useFakeTimers();
    let now = 0;
    const throttle = new AdaptiveThrottle({ now: () => now, penaltyDurationMs: 1_000, maxBackoffMs: 60_000 });
    throttle.update({ limit: 10, remaining: 10, resetAt: now + 1_000 });

    throttle.recordRateLimited(); // breach 1 → multiplier = 1 (2^0)
    expect(throttle.getBackoffMultiplier()).toBe(1);

    throttle.recordRateLimited(); // breach 2 → multiplier = 2 (2^1)
    expect(throttle.getBackoffMultiplier()).toBe(2);

    throttle.recordRateLimited(); // breach 3 → multiplier = 4 (2^2)
    expect(throttle.getBackoffMultiplier()).toBe(4);

    vi.useRealTimers();
  });

  it("effective window doubles with each breach", async () => {
    vi.useFakeTimers();
    let now = 0;
    const base = 1_000;
    const throttle = new AdaptiveThrottle({ now: () => now, penaltyDurationMs: base, maxBackoffMs: 60_000 });
    throttle.update({ limit: 10, remaining: 0, resetAt: now + base });

    // First breach → 1 000 ms window
    throttle.recordRateLimited();
    expect(throttle.getStats().penalized).toBe(true);

    now += base - 1;
    await vi.advanceTimersByTimeAsync(base - 1);
    expect(throttle.getStats().penalized).toBe(true);

    now += 1;
    await vi.advanceTimersByTimeAsync(1);
    expect(throttle.getStats().penalized).toBe(false);

    // Second breach → 2 000 ms window
    throttle.recordRateLimited();
    now += base; // only 1 000ms of 2 000ms elapsed
    await vi.advanceTimersByTimeAsync(base);
    expect(throttle.getStats().penalized).toBe(true);

    now += base;
    await vi.advanceTimersByTimeAsync(base);
    expect(throttle.getStats().penalized).toBe(false);

    vi.useRealTimers();
  });

  it("backoff is capped at maxBackoffMs", () => {
    vi.useFakeTimers();
    let now = 0;
    const throttle = new AdaptiveThrottle({ now: () => now, penaltyDurationMs: 1_000, maxBackoffMs: 4_000 });
    throttle.update({ limit: 5, remaining: 5, resetAt: now + 1_000 });

    // 5 breaches: 1000, 2000, 4000, (cap)4000, (cap)4000
    for (let i = 0; i < 5; i++) throttle.recordRateLimited();

    // multiplier should be capped: maxBackoffMs / penaltyDurationMs = 4
    expect(throttle.getBackoffMultiplier()).toBe(4);

    vi.useRealTimers();
  });

  it("backoff resets after a full window with no breach", async () => {
    vi.useFakeTimers();
    let now = 0;
    const base = 1_000;
    const throttle = new AdaptiveThrottle({ now: () => now, penaltyDurationMs: base, maxBackoffMs: 60_000 });
    throttle.update({ limit: 10, remaining: 10, resetAt: now + base });

    // Two breaches → multiplier 2
    throttle.recordRateLimited();
    throttle.recordRateLimited();
    expect(throttle.getBackoffMultiplier()).toBe(2);

    // Let penalty expire
    now += base * 2 + 1;
    await vi.advanceTimersByTimeAsync(base * 2 + 1);
    expect(throttle.getStats().penalized).toBe(false);

    // Calling update() after a full window with no breach resets the counter
    throttle.update({ limit: 10, remaining: 10, resetAt: now + base });
    expect(throttle.getBackoffMultiplier()).toBe(1);

    vi.useRealTimers();
  });
});
