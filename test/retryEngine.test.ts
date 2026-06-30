import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RetryEngine } from "../src/retryEngine.js";
import type { RetryConfig } from "../src/retryEngine.js";
import { TelemetryCollector } from "../src/telemetryCollector.js";

const baseConfig: RetryConfig = {
  transient: { maxAttempts: 3, initialDelayMs: 10, backoffMultiplier: 2 },
  rateLimit: { maxAttempts: 2, initialDelayMs: 10, backoffMultiplier: 1 },
  contract: { maxAttempts: 1, initialDelayMs: 0, backoffMultiplier: 1 },
  circuitBreakerThreshold: 3,
  circuitResetMs: 500,
};

function makeEngine(cfg: Partial<RetryConfig> = {}): { engine: RetryEngine; telemetry: TelemetryCollector } {
  const telemetry = new TelemetryCollector();
  const engine = new RetryEngine({ ...baseConfig, ...cfg }, telemetry);
  return { engine, telemetry };
}

function transientError() {
  return new Error("network timeout");
}

function contractError() {
  return new Error("Error(Contract, #4)");
}

function rateLimitError() {
  return new Error("429 rate limit exceeded");
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("RetryEngine", () => {
  it("succeeds on first attempt with no retries needed", async () => {
    const { engine, telemetry } = makeEngine();
    const fn = vi.fn().mockResolvedValue("ok");

    const result = await engine.execute(fn, "testMethod");

    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(telemetry.getReport().methods["testMethod"]?.calls).toBe(1);
    expect(telemetry.getReport().methods["testMethod"]?.errors).toBe(0);
  });

  it("retries transient errors up to maxAttempts and succeeds", async () => {
    const { engine } = makeEngine({
      transient: { maxAttempts: 3, initialDelayMs: 1, backoffMultiplier: 1 },
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(transientError())
      .mockRejectedValueOnce(transientError())
      .mockResolvedValue("done");

    const promise = engine.execute(fn, "m");
    // advance timers to skip sleeps
    await vi.runAllTimersAsync();
    const result = await promise;

    expect(result).toBe("done");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("throws after exhausting transient maxAttempts", async () => {
    const { engine } = makeEngine({
      transient: { maxAttempts: 2, initialDelayMs: 1, backoffMultiplier: 1 },
      circuitBreakerThreshold: 10, // prevent circuit from opening
    });
    const err = transientError();
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err);

    await expect(
      Promise.all([engine.execute(fn, "m"), vi.runAllTimersAsync()])
    ).rejects.toThrow(err);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does not retry contract errors", async () => {
    const { engine } = makeEngine();
    const fn = vi.fn().mockRejectedValue(contractError());

    await expect(engine.execute(fn, "m")).rejects.toThrow("Error(Contract, #4)");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("applies rateLimit strategy for 429 errors", async () => {
    const { engine } = makeEngine({
      rateLimit: { maxAttempts: 2, initialDelayMs: 1, backoffMultiplier: 1 },
      circuitBreakerThreshold: 10,
    });
    const err = rateLimitError();
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err);

    await expect(
      Promise.all([engine.execute(fn, "m"), vi.runAllTimersAsync()])
    ).rejects.toThrow("429");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("circuit opens after circuitBreakerThreshold consecutive transient failures", async () => {
    const { engine } = makeEngine({
      transient: { maxAttempts: 1, initialDelayMs: 1, backoffMultiplier: 1 },
      circuitBreakerThreshold: 3,
    });
    const fn = vi.fn().mockRejectedValue(transientError());

    // First two calls fail normally
    await expect(engine.execute(fn, "m")).rejects.toThrow();
    await expect(engine.execute(fn, "m")).rejects.toThrow();
    // Third call triggers the circuit to open
    await expect(engine.execute(fn, "m")).rejects.toThrow("Circuit breaker is open");
    // Subsequent call is blocked immediately
    await expect(engine.execute(fn, "m")).rejects.toThrow("Circuit breaker is open");
    // fn was not called on the blocked call
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("circuit resets after circuitResetMs and allows calls again", async () => {
    const { engine } = makeEngine({
      transient: { maxAttempts: 1, initialDelayMs: 1, backoffMultiplier: 1 },
      circuitBreakerThreshold: 1,
      circuitResetMs: 200,
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(transientError())
      .mockResolvedValue("recovered");

    // Open the circuit
    await expect(engine.execute(fn, "m")).rejects.toThrow("Circuit breaker is open");

    // Advance past reset window
    vi.advanceTimersByTime(201);

    const promise = engine.execute(fn, "m");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("recovered");
  });

  it("jitter produces non-deterministic delays within expected range", async () => {
    const jitterMs = 100;
    const { engine } = makeEngine({
      transient: { maxAttempts: 2, initialDelayMs: 50, backoffMultiplier: 1, jitterMs },
      circuitBreakerThreshold: 10,
    });

    const delays: number[] = [];
    const originalSetTimeout = globalThis.setTimeout;

    // Capture the delay values passed to sleep by tracking setTimeout calls
    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms: number, ...args: any[]) => {
      if (ms !== undefined && ms > 0) delays.push(ms);
      return originalSetTimeout(fn, 0, ...args);
    });

    const fn = vi.fn()
      .mockRejectedValueOnce(transientError())
      .mockResolvedValue("ok");

    const promise = engine.execute(fn, "m");
    await vi.runAllTimersAsync();
    await promise;

    spy.mockRestore();

    expect(delays.length).toBeGreaterThan(0);
    for (const d of delays) {
      expect(d).toBeGreaterThanOrEqual(50);
      expect(d).toBeLessThan(50 + jitterMs + 1); // +1 for float rounding
    }
  });

  it("records telemetry for each attempt", async () => {
    const { engine, telemetry } = makeEngine({
      transient: { maxAttempts: 3, initialDelayMs: 1, backoffMultiplier: 1 },
      circuitBreakerThreshold: 10,
    });
    const fn = vi.fn()
      .mockRejectedValueOnce(transientError())
      .mockResolvedValue("ok");

    const promise = engine.execute(fn, "op");
    await vi.runAllTimersAsync();
    await promise;

    const report = telemetry.getReport().methods["op"];
    expect(report?.calls).toBe(2);
    expect(report?.errors).toBe(1);
  });
});
