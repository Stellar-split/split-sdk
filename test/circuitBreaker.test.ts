import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { CircuitBreaker, DEFAULT_CIRCUIT_BREAKER_CONFIG } from "../src/circuitBreaker.js";

describe("circuitBreaker (src/circuitBreaker.ts)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("uses default config and merges overrides", () => {
    expect(new CircuitBreaker().config).toEqual(DEFAULT_CIRCUIT_BREAKER_CONFIG);
    expect(new CircuitBreaker({ failureThreshold: 2 }).config).toEqual({
      failureThreshold: 2,
      resetTimeoutMs: 30_000,
    });
  });

  describe("threshold", () => {
    it("stays closed below the threshold and opens exactly at it", () => {
      const cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 1000 });
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.state).toBe("closed");
      expect(cb.canExecute()).toBe(true);
      cb.recordFailure();
      expect(cb.state).toBe("open");
      expect(cb.canExecute()).toBe(false);
    });

    it("a success resets the consecutive failure count", () => {
      const cb = new CircuitBreaker({ failureThreshold: 3 });
      cb.recordFailure();
      cb.recordFailure();
      cb.recordSuccess();
      expect(cb.failureCount).toBe(0);
      expect(cb.lastFailureTime).toBeNull();
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.state).toBe("closed");
    });
  });

  describe("state transitions and events", () => {
    it("emits stateChange and circuit events through the full cycle", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100 });
      const changes: Array<[string, string]> = [];
      const seen: string[] = [];
      cb.on("stateChange", (e) => changes.push([e.from, e.to]));
      cb.on("circuit:open", () => seen.push("open"));
      cb.on("circuit:half-open", () => seen.push("half-open"));
      cb.on("circuit:close", () => seen.push("close"));

      cb.recordFailure();
      vi.advanceTimersByTime(100);
      expect(cb.state).toBe("half-open");
      cb.recordSuccess();

      expect(changes).toEqual([
        ["closed", "open"],
        ["open", "half-open"],
        ["half-open", "closed"],
      ]);
      expect(seen).toEqual(["open", "half-open", "close"]);
    });

    it("recordFailure while open does not change state", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
      cb.recordFailure();
      cb.recordFailure();
      expect(cb.state).toBe("open");
      expect(cb.failureCount).toBe(2);
    });
  });

  describe("timeout", () => {
    it("rejects calls until resetTimeoutMs elapses, then allows a probe", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
      cb.recordFailure();
      vi.setSystemTime(Date.now() + 999);
      expect(cb.canExecute()).toBe(false);
      vi.setSystemTime(Date.now() + 1);
      expect(cb.canExecute()).toBe(true);
      expect(cb.state).toBe("half-open");
    });

    it("moves to half-open automatically via timer", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 500 });
      cb.recordFailure();
      vi.advanceTimersByTime(499);
      expect(cb.state).toBe("open");
      vi.advanceTimersByTime(1);
      expect(cb.state).toBe("half-open");
    });
  });

  describe("recovery", () => {
    it("closes after a successful probe", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100 });
      cb.recordFailure();
      vi.advanceTimersByTime(100);
      cb.recordSuccess();
      expect(cb.state).toBe("closed");
      expect(cb.failureCount).toBe(0);
      expect(cb.canExecute()).toBe(true);
    });

    it("re-opens after a failed probe and restarts the cooldown", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100 });
      cb.recordFailure();
      vi.advanceTimersByTime(100);
      expect(cb.state).toBe("half-open");
      cb.recordFailure();
      expect(cb.state).toBe("open");
      vi.advanceTimersByTime(100);
      expect(cb.state).toBe("half-open");
    });

    it("reset() forces closed and cancels the pending timer", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 100 });
      const onChange = vi.fn();
      cb.recordFailure();
      cb.on("stateChange", onChange);
      cb.reset();
      expect(cb.state).toBe("closed");
      vi.advanceTimersByTime(1000);
      expect(cb.state).toBe("closed");
      expect(onChange).toHaveBeenCalledTimes(1);
      cb.reset();
      expect(onChange).toHaveBeenCalledTimes(1);
    });
  });

  describe("integration (health check)", () => {
    it("reports healthy, unhealthy, and degraded and emits health:check", () => {
      const cb = new CircuitBreaker({ failureThreshold: 1, resetTimeoutMs: 1000 });
      const onHealth = vi.fn();
      cb.on("health:check", onHealth);

      expect(cb.healthCheck().status).toBe("healthy");

      cb.recordFailure();
      const open = cb.healthCheck();
      expect(open.status).toBe("unhealthy");
      expect(open.msUntilReset).toBe(1000);

      vi.advanceTimersByTime(1000);
      const half = cb.healthCheck();
      expect(half.status).toBe("degraded");
      expect(half.state).toBe("half-open");
      expect(onHealth).toHaveBeenCalledTimes(3);
    });
  });
});
