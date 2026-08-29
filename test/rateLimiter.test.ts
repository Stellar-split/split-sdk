import { describe, expect, it, vi } from "vitest";
import { RateLimiter } from "../src/rateLimiter.js";

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
