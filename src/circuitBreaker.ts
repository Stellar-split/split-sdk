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

/** Event map for typed circuit breaker events. */
export interface CircuitBreakerEventMap {
  "circuit:open": [];
  "circuit:close": [];
  "circuit:half-open": [];
  stateChange: [{ from: CircuitBreakerState; to: CircuitBreakerState }];
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
