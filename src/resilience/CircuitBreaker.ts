/**
 * CircuitBreaker — wraps outbound RPC calls and fails fast once a
 * configurable failure-rate threshold is reached, instead of letting every
 * caller hang until the underlying transport times out.
 *
 * States:
 *  - CLOSED:    Normal operation; calls pass through.
 *  - OPEN:      Failure threshold exceeded; calls reject immediately with
 *               CircuitOpenError without touching the network.
 *  - HALF_OPEN: Cooling period elapsed; exactly one probe call is allowed
 *               through to test recovery before resetting to CLOSED.
 */

import { CircuitOpenError } from "../errors.js";

export type CircuitState = "CLOSED" | "OPEN" | "HALF_OPEN";

export interface CircuitBreakerOptions {
  /** Consecutive failures (in CLOSED) before the circuit opens. */
  failureThreshold: number;
  /** Consecutive successes (in HALF_OPEN) required before closing. Default: 1. */
  successThreshold?: number;
  /** Milliseconds to wait after opening before allowing a HALF_OPEN probe. */
  openDurationMs: number;
  /** Milliseconds before an in-flight HALF_OPEN probe is treated as a failure. */
  halfOpenProbeTimeoutMs: number;
  /** Number of concurrent probe requests allowed in HALF_OPEN state. Default: 1. */
  halfOpenProbeCount?: number;
}

type ResolvedCircuitBreakerOptions = Required<CircuitBreakerOptions>;

const DEFAULT_OPTIONS: ResolvedCircuitBreakerOptions = {
  failureThreshold: 5,
  successThreshold: 1,
  openDurationMs: 30_000,
  halfOpenProbeTimeoutMs: 5_000,
  halfOpenProbeCount: 1,
};

/** Structured log event emitted on every state transition. */
export interface CircuitStateChangeLogEvent {
  event: "circuit_state_change";
  from: CircuitState;
  to: CircuitState;
  at: number;
}

/** Minimal structured logger contract — compatible with `console`. */
export interface CircuitBreakerLogger {
  warn(event: CircuitStateChangeLogEvent): void;
}

export interface CircuitBreakerStateSnapshot {
  state: CircuitState;
  failureCount: number;
  lastTransitionAt: number;
}

/** Single mutable state object; every field is read/written through the
 * class's own methods only, so state transitions stay consistent even when
 * `execute()` calls overlap (no interleaved partial updates). */
interface MutableState {
  state: CircuitState;
  failureCount: number;
  successCount: number;
  lastFailureAt: number;
  lastTransitionAt: number;
  halfOpenProbesInFlight: number;
}

export class CircuitBreaker {
  private readonly options: ResolvedCircuitBreakerOptions;
  private readonly logger: CircuitBreakerLogger;
  private readonly state: MutableState;

  constructor(options: Partial<CircuitBreakerOptions> = {}, logger: CircuitBreakerLogger = console) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.logger = logger;
    const now = Date.now();
    this.state = {
      state: "CLOSED",
      failureCount: 0,
      successCount: 0,
      lastFailureAt: 0,
      lastTransitionAt: now,
      halfOpenProbesInFlight: 0,
    };
  }

  getState(): CircuitBreakerStateSnapshot {
    return {
      state: this.state.state,
      failureCount: this.state.failureCount,
      lastTransitionAt: this.state.lastTransitionAt,
    };
  }

  /**
   * Run `fn` through the breaker. Throws CircuitOpenError without invoking
   * `fn` when OPEN, or when a HALF_OPEN probe is already in flight.
   */
  async execute<T>(fn: () => Promise<T>): Promise<T> {
    this._maybeExpireOpenState();

    if (this.state.state === "OPEN") {
      throw new CircuitOpenError({ state: this.state.state });
    }

    if (this.state.state === "HALF_OPEN") {
      if (this.state.halfOpenProbesInFlight >= this.options.halfOpenProbeCount) {
        throw new CircuitOpenError({ state: this.state.state, reason: "probe_limit_reached" });
      }
      this.state.halfOpenProbesInFlight += 1;
      try {
        const result = await this._withProbeTimeout(fn);
        this._onSuccess();
        return result;
      } catch (error) {
        this._onFailure();
        throw error;
      } finally {
        this.state.halfOpenProbesInFlight -= 1;
      }
    }

    try {
      const result = await fn();
      this._onSuccess();
      return result;
    } catch (error) {
      this._onFailure();
      throw error;
    }
  }

  /** Force the breaker back to CLOSED, clearing all counters. */
  reset(): void {
    this._transition("CLOSED");
    this.state.failureCount = 0;
    this.state.successCount = 0;
    this.state.halfOpenProbesInFlight = 0;
  }

  private _withProbeTimeout<T>(fn: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        reject(new CircuitOpenError({ state: this.state.state, reason: "probe_timeout" }));
      }, this.options.halfOpenProbeTimeoutMs);
      fn().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  }

  private _maybeExpireOpenState(): void {
    if (this.state.state !== "OPEN") return;
    const elapsed = Date.now() - this.state.lastFailureAt;
    if (elapsed >= this.options.openDurationMs) {
      this.state.successCount = 0;
      this._transition("HALF_OPEN");
    }
  }

  private _onSuccess(): void {
    if (this.state.state === "HALF_OPEN") {
      this.state.successCount += 1;
      if (this.state.successCount >= this.options.successThreshold) {
        this.state.failureCount = 0;
        this.state.successCount = 0;
        this._transition("CLOSED");
      }
      return;
    }
    this.state.failureCount = 0;
  }

  private _onFailure(): void {
    this.state.lastFailureAt = Date.now();

    if (this.state.state === "HALF_OPEN") {
      this.state.successCount = 0;
      this._transition("OPEN");
      return;
    }

    this.state.failureCount += 1;
    if (this.state.failureCount >= this.options.failureThreshold) {
      this._transition("OPEN");
    }
  }

  private _transition(to: CircuitState): void {
    const from = this.state.state;
    if (from === to) return;
    this.state.state = to;
    this.state.lastTransitionAt = Date.now();
    this.logger.warn({ event: "circuit_state_change", from, to, at: this.state.lastTransitionAt });
  }
}
