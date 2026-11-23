import { describe, it, expect } from "vitest";
import { CircuitBreaker } from "../src/circuitBreaker.js";

describe("CircuitBreaker.execute / getStats", () => {
  it("tracks stats and rejects when open", async () => {
    const cb = new CircuitBreaker({ failureThreshold: 2, resetTimeoutMs: 60_000 });
    await expect(cb.execute(async () => 1)).resolves.toBe(1);
    for (let i = 0; i < 2; i++) {
      await expect(cb.execute(async () => { throw new Error("x"); })).rejects.toThrow("x");
    }
    await expect(cb.execute(async () => 1)).rejects.toThrow("Circuit breaker is open");
    expect(cb.getStats()).toEqual({ state: "open", successes: 1, failures: 2, rejected: 1 });
    cb.reset();
  });
});
