/**
 * CircuitBreaker — prevents cascading failures by tracking consecutive
 * RPC errors and temporarily blocking calls when a failure threshold is reached.
 *
 * States:
 *  - CLOSED:  Normal operation; requests pass through.
 *  - OPEN:    Failure threshold exceeded; requests are rejected immediately.
 *  - HALF_OPEN: Cooldown elapsed; one probe request is allowed through to test recovery.
 */

import { EventEmitter } from "events";

/** Circuit breaker configuration. */
export interface CircuitBreakerConfig {
  /** Number of consecutive failures before the circuit opens. Default: 5 */
  failureThreshold: number;
  /** Milliseconds to wait before transitioning from OPEN to HALF-OPEN. Default: 30 000 */
  resetTimeoutMs: number;
}

export const DEFAULT_CIRCUIT_BREAKER_CONFIG: CircuitBreakerConfig = {
  failureThreshold: 5,
  resetTimeoutMs: 30_000,
};

export type CircuitBreakerState = "closed" | "open" | "half-open";

/** Overall health status reported by the SDK health check. */
export type HealthStatus = "healthy" | "degraded" | "unhealthy";

/** Detailed diagnostics produced by {@link CircuitBreaker.healthCheck}. */
export interface HealthCheckDiagnostics {
  /** Aggregate health derived from the circuit state and failure count. */
  status: HealthStatus;
  /** Current circuit breaker state. */
  state: CircuitBreakerState;
  /** Number of consecutive failures recorded. */
  failureCount: number;
  /** Configured failure threshold. */
  failureThreshold: number;
  /** Configured reset timeout in milliseconds. */
  resetTimeoutMs: number;
  /** Timestamp of the last failure, or null if none recorded. */
  lastFailureTime: number | null;
  /** Milliseconds since the last failure, or null if none recorded. */
  msSinceLastFailure: number | null;
  /** Milliseconds remaining until the circuit may probe recovery, or null. */
  msUntilReset: number | null;
  /** Human-readable summary of the current health. */
  message: string;
}

/** Event map for typed circuit breaker events. */
export interface CircuitBreakerEventMap {
  "circuit:open": [];
  "circuit:close": [];
  "circuit:half-open": [];
  stateChange: [{ from: CircuitBreakerState; to: CircuitBreakerState }];
  "health:check": [HealthCheckDiagnostics];
}

/**
 * A circuit breaker that tracks consecutive failures and opens when the
 * threshold is exceeded, auto-resetting after a cooldown period.
 */
export class CircuitBreaker extends EventEmitter {
  private _state: CircuitBreakerState = "closed";
  private _failureCount = 0;
  private _lastFailureTime: number | null = null;
  private _resetTimeoutId: ReturnType<typeof setTimeout> | null = null;
  private readonly _config: CircuitBreakerConfig;
  private _totalSuccesses = 0;
  private _totalFailures = 0;
  private _totalRejected = 0;

  constructor(config?: Partial<CircuitBreakerConfig>) {
    super();
    this._config = {
      ...DEFAULT_CIRCUIT_BREAKER_CONFIG,
      ...config,
    };
  }

  get state(): CircuitBreakerState {
    return this._state;
  }

  get failureCount(): number {
    return this._failureCount;
  }

  get lastFailureTime(): number | null {
    return this._lastFailureTime;
  }

  get config(): CircuitBreakerConfig {
    return { ...this._config };
  }

  /**
   * Record a successful call.
   * In CLOSED state: resets the failure counter.
   * In HALF-OPEN state: transitions back to CLOSED (recovery confirmed).
   */
  recordSuccess(): void {
    this._totalSuccesses += 1;
    const previous = this._state;
    this._failureCount = 0;
    this._lastFailureTime = null;

    if (this._state === "half-open") {
      this._clearResetTimeout();
      this._state = "closed";
      this._emitStateChange(previous, "closed");
    }
  }

  /**
   * Record a failure.
   * In CLOSED state: increments counter; opens when threshold reached.
   * In HALF-OPEN state: re-opens the circuit (recovery probe failed).
   * In OPEN state: no-op (circuit is already open).
   */
  recordFailure(): void {
    this._totalFailures += 1;
    this._failureCount += 1;
    this._lastFailureTime = Date.now();

    if (this._state === "closed") {
      if (this._failureCount >= this._config.failureThreshold) {
        this._state = "open";
        this._emitStateChange("closed", "open");
        this._scheduleReset();
      }
    } else if (this._state === "half-open") {
      this._clearResetTimeout();
      this._state = "open";
      this._emitStateChange("half-open", "open");
      this._scheduleReset();
    }
  }

  /**
   * Check if a request should be allowed through.
   * Returns true in CLOSED and HALF-OPEN states.
   * In OPEN state, returns true only if the reset timeout has elapsed
   * (transitioning to HALF-OPEN to allow a probe request).
   */
  canExecute(): boolean {
    if (this._state === "closed") return true;
    if (this._state === "half-open") return true;

    // OPEN state — check if cooldown has elapsed
    if (
      this._lastFailureTime !== null &&
      Date.now() - this._lastFailureTime >= this._config.resetTimeoutMs
    ) {
      this._state = "half-open";
      this._emitStateChange("open", "half-open");
      return true;
    }

    return false;
  }

  /**
   * Perform a health check and return detailed diagnostics about the
   * circuit breaker's current condition. Emits a `health:check` event
   * with the produced diagnostics.
   */
  healthCheck(): HealthCheckDiagnostics {
    const now = Date.now();
    const msSinceLastFailure =
      this._lastFailureTime === null ? null : now - this._lastFailureTime;

    let msUntilReset: number | null = null;
    if (this._state === "open" && this._lastFailureTime !== null) {
      msUntilReset = Math.max(
        0,
        this._config.resetTimeoutMs - (now - this._lastFailureTime),
      );
    }

    let status: HealthStatus;
    let message: string;

    if (this._state === "closed") {
      status = "healthy";
      message = "Circuit is closed; requests are flowing normally.";
    } else if (this._state === "half-open") {
      status = "degraded";
      message = "Circuit is half-open; probing recovery with a single request.";
    } else {
      status = "unhealthy";
      message =
        msUntilReset !== null && msUntilReset > 0
          ? `Circuit is open; retry in ${msUntilReset}ms.`
          : "Circuit is open; cooldown elapsed, ready to probe recovery.";
    }

    const diagnostics: HealthCheckDiagnostics = {
      status,
      state: this._state,
      failureCount: this._failureCount,
      failureThreshold: this._config.failureThreshold,
      resetTimeoutMs: this._config.resetTimeoutMs,
      lastFailureTime: this._lastFailureTime,
      msSinceLastFailure,
      msUntilReset,
      message,
    };

    this.emit("health:check", diagnostics);
    return diagnostics;
  }

  /** Cumulative call statistics (not cleared by reset()). */
  getStats(): { state: CircuitBreakerState; successes: number; failures: number; rejected: number } {
    return {
      state: this._state,
      successes: this._totalSuccesses,
      failures: this._totalFailures,
      rejected: this._totalRejected,
    };
  }

  /**
   * Run `fn` guarded by the breaker. Rejects without calling `fn` when the
   * circuit is open; records success/failure otherwise.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.canExecute()) {
      this._totalRejected += 1;
      throw new Error("Circuit breaker is open");
    }
    try {
      const result = await fn();
      this.recordSuccess();
      return result;
    } catch (err) {
      this.recordFailure();
      throw err;
    }
  }

  /**
   * Force-reset the circuit breaker to the CLOSED state.
   * Useful for manual recovery or testing.
   */
  reset(): void {
    this._clearResetTimeout();
    const previous = this._state;
    this._state = "closed";
    this._failureCount = 0;
    this._lastFailureTime = null;
    if (previous !== "closed") {
      this._emitStateChange(previous, "closed");
    }
  }

  private _scheduleReset(): void {
    this._clearResetTimeout();
    this._resetTimeoutId = setTimeout(() => {
      if (this._state === "open") {
        this._state = "half-open";
        this._emitStateChange("open", "half-open");
      }
      this._resetTimeoutId = null;
    }, this._config.resetTimeoutMs);
  }

  private _clearResetTimeout(): void {
    if (this._resetTimeoutId !== null) {
      clearTimeout(this._resetTimeoutId);
      this._resetTimeoutId = null;
    }
  }

  private _emitStateChange(from: CircuitBreakerState, to: CircuitBreakerState): void {
    this.emit("stateChange", { from, to });
    if (to === "open") {
      this.emit("circuit:open");
    } else if (to === "closed") {
      this.emit("circuit:close");
    } else if (to === "half-open") {
      this.emit("circuit:half-open");
    }
  }
}
