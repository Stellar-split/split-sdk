/**
 * ResilientRpcClient — wraps an RPC client (or SorobanRpc.Server) with
 * automatic retry (exponential backoff + jitter) and circuit breaker
 * protection for all Soroban RPC calls.
 *
 * Non-retryable errors (InvalidInput, Unauthorized, etc.) bypass retry
 * immediately and do not trip the circuit breaker.
 */

import { EventEmitter } from "events";
import {
  CircuitBreaker,
  type CircuitBreakerConfig,
  type CircuitBreakerState,
} from "./circuitBreaker.js";

// Re-export CircuitBreakerConfig so consumers don't need to import from circuitBreaker directly
export type { CircuitBreakerConfig } from "./circuitBreaker.js";
import {
  CircuitOpenError,
  StellarSplitError,
} from "./errors.js";
import type { RpcClient } from "./rpcClient.js";

// ---------------------------------------------------------------------------
// Retry configuration
// ---------------------------------------------------------------------------

export interface RetryConfig {
  /** Maximum number of retry attempts (including the initial call). Default: 3 */
  maxRetries: number;
  /** Base delay in milliseconds for exponential backoff. Default: 500 */
  baseDelayMs: number;
  /** Maximum delay cap in milliseconds. Default: 30 000 */
  maxDelayMs: number;
  /** Whether to add random jitter to the delay. Default: true */
  jitter: boolean;
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30_000,
  jitter: true,
};

// ---------------------------------------------------------------------------
// Non-retryable error code prefixes
// ---------------------------------------------------------------------------

const NON_RETRYABLE_CODES: readonly string[] = [
  "INVOICE_NOT_FOUND",
  "INVOICE_NOT_PENDING",
  "DEADLINE_PASSED",
  "INSUFFICIENT_BALANCE",
  "INVOICE_FROZEN",
  "UNAUTHORIZED",
  "VALIDATION_ERROR",
  "CONTRACT_ERROR",
  "WALLET_NOT_CONNECTED",
  "NFT_GATE_REQUIRED",
  "CO_CREATOR_APPROVAL_NOT_REQUIRED",
  "ADMIN_OPERATION_ERROR",
  "NO_PENDING_PAYOUT",
  "INVALID_ATTESTATION",
];

function isNonRetryable(error: unknown): boolean {
  if (error instanceof StellarSplitError) {
    return NON_RETRYABLE_CODES.includes(error.code);
  }
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (
      /invalid\s*input|unauthorized|forbidden|not\s*found(?!.*timeout)/.test(msg)
    ) {
      return true;
    }
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// ResilientRpcClient
// ---------------------------------------------------------------------------

export interface ResilientRpcClientEvents {
  "circuit:open": [];
  "circuit:close": [];
  "circuit:half-open": [];
}

/**
 * Wraps any object exposing Soroban RPC methods with retry and circuit
 * breaker protection. Intercepts the most common RPC calls used by
 * StellarSplitClient.
 *
 * For SorobanRpc.Server instances, all 7 core methods are wrapped.
 * For custom RpcClient implementations, the same 7 methods are wrapped.
 */
export class ResilientRpcClient extends EventEmitter {
  private readonly _inner: any;
  private readonly _retryConfig: RetryConfig;
  private readonly _circuitBreaker: CircuitBreaker;

  constructor(
    inner: any,
    retryConfig?: Partial<RetryConfig>,
    circuitBreakerConfig?: Partial<CircuitBreakerConfig>,
  ) {
    super();
    this._inner = inner;
    this._retryConfig = { ...DEFAULT_RETRY_CONFIG, ...retryConfig };
    this._circuitBreaker = new CircuitBreaker(circuitBreakerConfig);

    // Forward circuit breaker state-change events
    this._circuitBreaker.on("stateChange", (evt: { from: CircuitBreakerState; to: CircuitBreakerState }) => {
      if (evt.to === "open") this.emit("circuit:open");
      else if (evt.to === "closed") this.emit("circuit:close");
      else if (evt.to === "half-open") this.emit("circuit:half-open");
    });
  }

  get circuitBreaker(): CircuitBreaker {
    return this._circuitBreaker;
  }

  /** Access the underlying unwrapped RPC client/server. */
  get inner(): any {
    return this._inner;
  }

  // -- Wrapped RpcClient methods --------------------------------------------

  simulateTransaction(...args: Parameters<RpcClient["simulateTransaction"]>): ReturnType<RpcClient["simulateTransaction"]> {
    return this._call("simulateTransaction", args) as ReturnType<RpcClient["simulateTransaction"]>;
  }

  sendTransaction(...args: Parameters<RpcClient["sendTransaction"]>): ReturnType<RpcClient["sendTransaction"]> {
    return this._call("sendTransaction", args) as ReturnType<RpcClient["sendTransaction"]>;
  }

  getTransaction(...args: Parameters<RpcClient["getTransaction"]>): ReturnType<RpcClient["getTransaction"]> {
    return this._call("getTransaction", args) as ReturnType<RpcClient["getTransaction"]>;
  }

  getEvents(...args: Parameters<RpcClient["getEvents"]>): ReturnType<RpcClient["getEvents"]> {
    return this._call("getEvents", args) as ReturnType<RpcClient["getEvents"]>;
  }

  getLatestLedger(...args: Parameters<RpcClient["getLatestLedger"]>): ReturnType<RpcClient["getLatestLedger"]> {
    return this._call("getLatestLedger", args) as ReturnType<RpcClient["getLatestLedger"]>;
  }

  getAccount(...args: Parameters<RpcClient["getAccount"]>): ReturnType<RpcClient["getAccount"]> {
    return this._call("getAccount", args) as ReturnType<RpcClient["getAccount"]>;
  }

  getFeeStats(...args: Parameters<RpcClient["getFeeStats"]>): ReturnType<RpcClient["getFeeStats"]> {
    return this._call("getFeeStats", args) as ReturnType<RpcClient["getFeeStats"]>;
  }

  // -- Passthrough for non-RpcClient methods --------------------------------

  /** Delegate any unknown method to the inner client. */
  get [Symbol.toStringTag](): string {
    return "ResilientRpcClient";
  }

  // -- Core execution logic -------------------------------------------------

  private _call(method: string, args: unknown[]): Promise<unknown> {
    return this._executeWithResilience(
      () => (this._inner[method] as (...a: unknown[]) => Promise<unknown>)(...args),
      method,
    );
  }

  private async _executeWithResilience<T>(
    fn: () => Promise<T>,
    method: string,
  ): Promise<T> {
    // Circuit breaker: reject immediately when open
    if (!this._circuitBreaker.canExecute()) {
      throw new CircuitOpenError({ method });
    }

    const maxAttempts = Math.max(1, this._retryConfig.maxRetries);
    let lastError: unknown;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      try {
        const result = await fn();
        this._circuitBreaker.recordSuccess();
        return result;
      } catch (error) {
        lastError = error;

        // Non-retryable: fail immediately without tripping the circuit
        if (isNonRetryable(error)) {
          throw error;
        }

        const isLastAttempt = attempt === maxAttempts - 1;
        if (isLastAttempt) break;

        // In HALF-OPEN state, only allow one probe (no additional retries)
        if (this._circuitBreaker.state === "half-open") break;

        const delayMs = this._computeDelay(attempt);
        await sleep(delayMs);
      }
    }

    // Record a single failure for this operation (regardless of retry count)
    this._circuitBreaker.recordFailure();
    throw lastError;
  }

  private _computeDelay(attempt: number): number {
    const base = this._retryConfig.baseDelayMs * 2 ** attempt;
    const capped = Math.min(base, this._retryConfig.maxDelayMs);
    if (!this._retryConfig.jitter) return capped;
    return capped + Math.random() * this._retryConfig.baseDelayMs;
  }
}
