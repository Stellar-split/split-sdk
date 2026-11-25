import { describe, expect, it, vi } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { RateLimiter, RateLimitExceededError, RateLimitStore } from "../src/rateLimiter.js";
import type { RateLimiterConfig } from "../src/rateLimiter.js";
import { StellarSplitClient } from "../src/client.js";

describe("RateLimiter", () => {
  it("enforces per-key limits while preserving the global limit", async () => {
    vi.useFakeTimers();

    const limiter = new RateLimiter({ maxRequestsPerSecond: 3, perKeyLimit: 2 });

    await limiter.acquire("alice");
    await limiter.acquire("alice");
    await limiter.acquire("bob");

    const blockedAlice = limiter.acquire("alice");
    const blockedBob = limiter.acquire("bob");

    let aliceResolved = false;
    let bobResolved = false;
    void blockedAlice.then(() => {
      aliceResolved = true;
    });
    void blockedBob.then(() => {
      bobResolved = true;
    });

    await vi.advanceTimersByTimeAsync(999);
    expect(aliceResolved).toBe(false);
    expect(bobResolved).toBe(false);

    await vi.advanceTimersByTimeAsync(1);
    await blockedAlice;
    await blockedBob;

    expect(aliceResolved).toBe(true);
    expect(bobResolved).toBe(true);

    vi.useRealTimers();
  });
});

// ---------------------------------------------------------------------------
// Checks and fail-fast acquisition (#1058)
// ---------------------------------------------------------------------------

describe("RateLimiter — checks and configuration", () => {
  it("check() reports capacity without consuming slots", () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 3, perKeyLimit: 2 });
      const first = limiter.check("alice");
      const second = limiter.check("alice");
      expect(first.allowed).toBe(true);
      expect(second.allowed).toBe(true);
      expect(first.remaining).toBe(2);
      expect(second.remaining).toBe(2);
      // Slots were never consumed by check().
      expect(limiter.tryAcquire("alice").allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("tryAcquire consumes only when allowed and never blocks", () => {
    const limiter = new RateLimiter({ maxRequestsPerSecond: 2, perKeyLimit: 1 });

    const first = limiter.tryAcquire("alice");
    expect(first.allowed).toBe(true);
    expect(first.retryAfterMs).toBe(0);

    const second = limiter.tryAcquire("alice");
    expect(second.allowed).toBe(false); // per-key budget exhausted
    expect(second.retryAfterMs).toBeGreaterThan(0);

    const bob = limiter.tryAcquire("bob");
    expect(bob.allowed).toBe(true); // global budget still has a slot

    const global = limiter.tryAcquire();
    expect(global.allowed).toBe(false); // global budget exhausted
    expect(global.retryAfterMs).toBeGreaterThan(0);
  });

  it("refills after the configured window (windowMs)", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 2, windowMs: 100 });
      expect(limiter.windowMs).toBe(100);
      expect(limiter.tryAcquire().allowed).toBe(true);
      expect(limiter.tryAcquire().allowed).toBe(true);
      expect(limiter.tryAcquire().allowed).toBe(false);
      await vi.advanceTimersByTimeAsync(100);
      expect(limiter.tryAcquire().allowed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid configuration with RangeError", () => {
    expect(() => new RateLimiter({ maxRequestsPerSecond: 0 })).toThrow(RangeError);
    expect(() => new RateLimiter({ maxRequestsPerSecond: -1 })).toThrow(RangeError);
    expect(() => new RateLimiter({ maxRequestsPerSecond: Number.NaN })).toThrow(
      RangeError,
    );
    expect(
      () => new RateLimiter({ maxRequestsPerSecond: undefined as unknown as number }),
    ).toThrow(RangeError);
    expect(
      () => new RateLimiter({ maxRequestsPerSecond: 10, perKeyLimit: 0 }),
    ).toThrow(RangeError);
    expect(
      () => new RateLimiter({ maxRequestsPerSecond: 10, windowMs: 0 }),
    ).toThrow(RangeError);
    expect(
      () => new RateLimiter({ maxRequestsPerSecond: 10, maxTrackedKeys: 0 }),
    ).toThrow(RangeError);
  });

  it("exposes per-key storage on the limiter", () => {
    const limiter = new RateLimiter({ maxRequestsPerSecond: 5, perKeyLimit: 2 });
    limiter.tryAcquire("alice");
    expect(limiter.store.size).toBe(1);
    expect(limiter.store.peek("alice", 2, limiter.windowMs).remaining).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// RateLimitStore storage (#1058)
// ---------------------------------------------------------------------------

describe("RateLimitStore", () => {
  it("enforces per-key budgets with peek (observe) and consume (take)", () => {
    const store = new RateLimitStore();
    const now = 1_000;
    expect(store.consume("k", 2, 1_000, now)).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    });
    // peek never consumes.
    expect(store.peek("k", 2, 1_000, now)).toEqual({
      allowed: true,
      remaining: 1,
      retryAfterMs: 0,
    });
    expect(store.consume("k", 2, 1_000, now)).toEqual({
      allowed: true,
      remaining: 0,
      retryAfterMs: 0,
    });
    const denied = store.consume("k", 2, 1_000, now);
    expect(denied.allowed).toBe(false);
    expect(denied.remaining).toBe(0);
    expect(denied.retryAfterMs).toBe(1_000);
  });

  it("rolls the window over after windowMs", () => {
    const store = new RateLimitStore();
    expect(store.consume("k", 1, 1_000, 1_000).allowed).toBe(true);
    expect(store.consume("k", 1, 1_000, 1_500).allowed).toBe(false);
    expect(store.consume("k", 1, 1_000, 2_000).allowed).toBe(true);
  });

  it("evicts least-recently-used keys beyond maxKeys", () => {
    const store = new RateLimitStore(2);
    store.consume("a", 5, 1_000, 0);
    store.consume("b", 5, 1_000, 0);
    store.peek("a", 5, 1_000, 0); // touch "a" → most recently used
    store.consume("c", 5, 1_000, 0); // evicts "b"
    expect(store.size).toBe(2);
    // "b" was forgotten, so its budget starts fresh.
    expect(store.consume("b", 1, 1_000, 0).allowed).toBe(true);
  });

  it("prune drops expired windows; clear resets everything", () => {
    const store = new RateLimitStore();
    store.consume("stale", 5, 1_000, 1_000);
    store.consume("fresh", 5, 1_000, 5_000);
    expect(store.prune(1_000, 5_500)).toBe(1);
    expect(store.size).toBe(1);
    store.clear();
    expect(store.size).toBe(0);
  });

  it("validates maxKeys", () => {
    expect(() => new RateLimitStore(0)).toThrow(RangeError);
    expect(() => new RateLimitStore(1.5)).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Client configuration wiring (#1058)
// ---------------------------------------------------------------------------

describe("StellarSplitClient rateLimit configuration", () => {
  function makeClient(rateLimit?: RateLimiterConfig): StellarSplitClient {
    return new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
      ...(rateLimit ? { rateLimit } : {}),
    });
  }

  function limiterOf(client: StellarSplitClient): RateLimiter | null {
    return (client as unknown as { _rateLimiter: RateLimiter | null })._rateLimiter;
  }

  it("creates a configured rate limiter when rateLimit is provided", () => {
    const client = makeClient({
      maxRequestsPerSecond: 5,
      perKeyLimit: 2,
      windowMs: 500,
    });
    const limiter = limiterOf(client);
    expect(limiter).toBeInstanceOf(RateLimiter);
    expect(limiter!.windowMs).toBe(500);
    expect(limiter!.tryAcquire("alice").allowed).toBe(true);
  });

  it("leaves rate limiting disabled by default", () => {
    expect(limiterOf(makeClient())).toBeNull();
  });

  it("surfaces invalid rateLimit configuration at construction", () => {
    expect(() => makeClient({ maxRequestsPerSecond: 0 })).toThrow(RangeError);
  });
});

// ---------------------------------------------------------------------------
// Backoff and tracking (#1349)
// ---------------------------------------------------------------------------

describe("RateLimiter — backoff and tracking", () => {
  it("tracks allowed and denied decisions by scope", () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 3, perKeyLimit: 1 });
      limiter.tryAcquire("alice");
      limiter.tryAcquire("alice");
      limiter.tryAcquire("bob");
      limiter.tryAcquire();
      limiter.tryAcquire();
      limiter.check();

      expect(limiter.getStats()).toEqual({
        allowed: 3,
        denied: 2,
        deniedByScope: { global: 1, method: 0, user: 0, key: 1 },
        backoffRetries: 0,
      });

      limiter.resetStats();
      expect(limiter.getStats().allowed).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("executeWithBackoff waits for capacity before running the function", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 1, backoff: { baseDelayMs: 100 } });
      const fn = vi.fn(() => "done");

      await expect(limiter.executeWithBackoff("pay", fn)).resolves.toBe("done");

      const pending = limiter.executeWithBackoff("pay", fn);
      await vi.advanceTimersByTimeAsync(999);
      expect(fn).toHaveBeenCalledTimes(1);

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBe("done");
      expect(fn).toHaveBeenCalledTimes(2);
      expect(limiter.getStats().backoffRetries).toBe(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("executeWithBackoff gives up after maxRetries", async () => {
    vi.useFakeTimers();
    try {
      const limiter = new RateLimiter({ maxRequestsPerSecond: 1, backoff: { maxRetries: 0 } });
      await limiter.executeWithBackoff("pay", () => undefined);
      const fn = vi.fn();

      await expect(limiter.executeWithBackoff("pay", fn)).rejects.toBeInstanceOf(RateLimitExceededError);
      expect(fn).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects invalid backoff configuration", () => {
    expect(() => new RateLimiter({ maxRequestsPerSecond: 1, backoff: { baseDelayMs: -1 } })).toThrow(RangeError);
    expect(() => new RateLimiter({ maxRequestsPerSecond: 1, backoff: { maxRetries: Number.NaN } })).toThrow(
      RangeError,
    );
  });
});
