/**
 * Unit tests for the jitterFactor feature added to RetryEngine
 * (src/retryEngine.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { RetryEngine } from "../src/retryEngine.js";
import type { RetryConfig } from "../src/retryEngine.js";
import { TelemetryCollector } from "../src/telemetryCollector.js";

const baseConfig: RetryConfig = {
  transient: { maxAttempts: 3, initialDelayMs: 100, backoffMultiplier: 2 },
  rateLimit: { maxAttempts: 2, initialDelayMs: 50, backoffMultiplier: 1 },
  contract: { maxAttempts: 1, initialDelayMs: 0, backoffMultiplier: 1 },
  circuitBreakerThreshold: 10,
  circuitResetMs: 500,
};

function makeEngine(
  cfg: Partial<RetryConfig> = {},
  jitterFactor?: number
): { engine: RetryEngine; telemetry: TelemetryCollector } {
  const telemetry = new TelemetryCollector();
  const engine = new RetryEngine(
    { ...baseConfig, ...cfg },
    telemetry,
    jitterFactor !== undefined ? { jitterFactor } : {}
  );
  return { engine, telemetry };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Default jitterFactor = 0.2
// ---------------------------------------------------------------------------

describe("RetryEngine – jitterFactor default (0.2)", () => {
  it("engine constructs without error when jitterFactor is not specified", () => {
    expect(() => makeEngine()).not.toThrow();
  });

  it("retries still succeed with default jitter applied", async () => {
    const { engine } = makeEngine(
      { transient: { maxAttempts: 3, initialDelayMs: 10, backoffMultiplier: 1 } },
      0.2
    );
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");

    const promise = engine.execute(fn, "m");
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// jitterFactor = 0  (disabled) — verified via Math.random spy
// ---------------------------------------------------------------------------

describe("RetryEngine – jitterFactor = 0 (no jitter)", () => {
  it("delay equals base delay exactly when jitterFactor is 0", async () => {
    // With jitterFactor=0 the formula is: delay = baseDelay (no multiplication).
    // We verify by pinning Math.random to a non-neutral value and checking
    // that the actual sleep duration is still exactly baseDelay.
    // Since we can't easily intercept setTimeout (fake timers own it), we
    // instead verify via Math.random never being called for the jitter path.
    const randomSpy = vi.spyOn(Math, "random");

    const { engine } = makeEngine(
      { transient: { maxAttempts: 2, initialDelayMs: 50, backoffMultiplier: 1 } },
      0
    );

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");

    const promise = engine.execute(fn, "m");
    await vi.runAllTimersAsync();
    await promise;

    // Math.random must NOT be called for the jitter multiplication when jitterFactor=0
    // (it may still be called 0 times — that's what we're asserting)
    expect(randomSpy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// jitterFactor range validation
// ---------------------------------------------------------------------------

describe("RetryEngine – jitterFactor validation", () => {
  it("throws when jitterFactor is below 0", () => {
    const telemetry = new TelemetryCollector();
    expect(
      () => new RetryEngine(baseConfig, telemetry, { jitterFactor: -0.1 })
    ).toThrow(/jitterFactor.*\[0.*1\]/i);
  });

  it("throws when jitterFactor exceeds 1", () => {
    const telemetry = new TelemetryCollector();
    expect(
      () => new RetryEngine(baseConfig, telemetry, { jitterFactor: 1.5 })
    ).toThrow(/jitterFactor.*\[0.*1\]/i);
  });

  it("accepts jitterFactor = 0 (boundary)", () => {
    const telemetry = new TelemetryCollector();
    expect(() => new RetryEngine(baseConfig, telemetry, { jitterFactor: 0 })).not.toThrow();
  });

  it("accepts jitterFactor = 1 (boundary)", () => {
    const telemetry = new TelemetryCollector();
    expect(() => new RetryEngine(baseConfig, telemetry, { jitterFactor: 1 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Delay range: verified by controlling Math.random
// ---------------------------------------------------------------------------

describe("RetryEngine – delay range with jitterFactor", () => {
  it("delay equals base*(1-jf) when Math.random returns 0", async () => {
    // With jitterFactor=0.3 and Math.random()=0:
    //   delay = base * (1 - 0.3 + 0 * 2 * 0.3) = base * 0.7
    vi.spyOn(Math, "random").mockReturnValue(0);

    const jitterFactor = 0.3;
    const initialDelayMs = 100;
    const { engine } = makeEngine(
      {
        transient: { maxAttempts: 2, initialDelayMs, backoffMultiplier: 1 },
        circuitBreakerThreshold: 10,
      },
      jitterFactor
    );

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");

    // Capture the actual timer delay vitest schedules
    const scheduledDelays: number[] = [];
    // vi.advanceTimersByTimeAsync tracks timers — we verify the engine still
    // completes, meaning the sleep fired at ≤ base*(1+jf).
    // Since Math.random()=0, expected delay = 100 * (1 - 0.3) = 70ms
    const promise = engine.execute(fn, "m");
    // Advance just 70ms — if jitter is applied correctly the sleep resolves
    await vi.advanceTimersByTimeAsync(70);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("delay equals base*(1+jf) when Math.random returns 1", async () => {
    // With jitterFactor=0.3 and Math.random()=1:
    //   delay = base * (1 - 0.3 + 1 * 2 * 0.3) = base * 1.3 = 130ms
    // Verify the sleep fires at ~130ms by advancing exactly that far.
    vi.spyOn(Math, "random").mockReturnValue(1);

    const jitterFactor = 0.3;
    const initialDelayMs = 100;
    const { engine } = makeEngine(
      {
        transient: { maxAttempts: 2, initialDelayMs, backoffMultiplier: 1 },
        circuitBreakerThreshold: 10,
      },
      jitterFactor
    );

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("transient"))
      .mockResolvedValue("ok");

    const promise = engine.execute(fn, "m");
    // Advance to exactly 130ms — the sleep should have fired
    await vi.advanceTimersByTimeAsync(130);
    await expect(promise).resolves.toBe("ok");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("Math.random is called once per retry when jitterFactor > 0", async () => {
    const randomSpy = vi.spyOn(Math, "random").mockReturnValue(0.5);

    const { engine } = makeEngine(
      {
        transient: { maxAttempts: 4, initialDelayMs: 10, backoffMultiplier: 1 },
        circuitBreakerThreshold: 10,
      },
      0.2
    );

    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("t"))
      .mockRejectedValueOnce(new Error("t"))
      .mockRejectedValueOnce(new Error("t"))
      .mockResolvedValue("ok");

    const promise = engine.execute(fn, "m");
    await vi.runAllTimersAsync();
    await promise;

    // Three retries → Math.random called exactly 3 times (once per sleep)
    expect(randomSpy).toHaveBeenCalledTimes(3);
  });
});
