/**
 * Per-method timeout configuration and enforcement via AbortController.
 * Also includes EscalationManager for pre-deadline escalation actions.
 */

import { PaymentEscalationAbortError } from "./errors.js";
import type { EscalationStep, TimeoutPolicy } from "./types.js";
import { FallbackChain } from "./fallbackChain.js";

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Timeout config: keys are method names, values are milliseconds.
 * The special key "default" applies to any method not explicitly listed.
 */
export type TimeoutConfig =
  | number
  | ({ default?: number } & Record<string, number | undefined>);

/** Thrown when a request exceeds its configured timeout. */
export class RequestTimeoutError extends Error {
  readonly code = "REQUEST_TIMEOUT";
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms (method: ${method})`);
    this.name = "RequestTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type TimeoutResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" | "error"; error?: Error };

const KNOWN_METHODS = [
  "getInvoice",
  "createInvoice",
  "pay",
  "batchPay",
  "getLeaderboard",
  "getInvoiceHistory",
  "getPaymentHistory",
  "getInvoicesByCreator",
  "getInvoicesByRecipient",
  "releaseInvoice",
  "cancelInvoice",
  "refundInvoice",
  "disputeInvoice",
  "checkNftGate",
  "verifyBatchPay",
  "simulateCreateInvoice",
  "simulatePay",
  "cloneInvoice",
  "syncInvoice",
  "checkRPCHealth",
];

export class TimeoutManager {
  private readonly _config: { default?: number } & Record<string, number | undefined>;

  constructor(config: TimeoutConfig) {
    if (typeof config === "number") {
      this._config = { default: config };
    } else {
      this._config = config;
    }
  }

  resolveTimeout(method: string): number {
    return this._config[method] ?? this._config.default ?? DEFAULT_TIMEOUT_MS;
  }

  getTimeoutConfig(): Record<string, number> {
    const defaultMs = this._config.default ?? DEFAULT_TIMEOUT_MS;
    const result: Record<string, number> = {};
    for (const method of KNOWN_METHODS) {
      result[method] = this._config[method] ?? defaultMs;
    }
    for (const key of Object.keys(this._config)) {
      if (key !== "default" && !(key in result)) {
        result[key] = this._config[key]!;
      }
    }
    return result;
  }
}

/**
 * Runs `fn` with a timeout enforced via AbortController.
 * If the timeout fires first, the controller is aborted and
 * RequestTimeoutError is thrown. The per-retry window resets on each call.
 */
export async function withTimeout<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  method: string
): Promise<TimeoutResult<T>> {
  const controller = new AbortController();
  let timeoutId: ReturnType<typeof setTimeout> | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timeoutId = setTimeout(() => {
      controller.abort();
      reject(new RequestTimeoutError(method, timeoutMs));
    }, timeoutMs);
  });

  try {
    const value = await Promise.race([fn(controller.signal), timeoutPromise]);
    return { ok: true, value };
  } catch (error) {
    if (error instanceof RequestTimeoutError) {
      return { ok: false, reason: "timeout", error };
    }
    return {
      ok: false,
      reason: "error",
      error: error instanceof Error ? error : new Error(String(error)),
    };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * @deprecated Use withTimeout() and inspect the TimeoutResult union.
 */
export async function withTimeoutOrThrow<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  method: string
): Promise<T> {
  const result = await withTimeout(fn, timeoutMs, method);
  if (result.ok) {
    return result.value;
  }

  throw result.error ?? new Error(`withTimeoutOrThrow failed for ${method}`);
}

// ---------------------------------------------------------------------------
// EscalationManager — pre-deadline escalation actions
// ---------------------------------------------------------------------------

/** Event emitted when an escalation step is triggered. */
export interface EscalationEvent {
  step: EscalationStep["action"];
  remainingMs: number;
  invoiceId: string;
}

export type EscalationCallback = (event: EscalationEvent) => void;

/**
 * Manages escalating actions before a payment deadline.
 *
 * Accepts a list of {@link EscalationStep} objects, each with a `triggerAtMs`
 * offset and an action.  As time elapses and the deadline approaches, the
 * manager fires each step in order.
 */
export class EscalationManager {
  private readonly deadlineMs: number;
  private readonly steps: EscalationStep[];
  private readonly fallbackChain: FallbackChain | null;
  private readonly onEvent: EscalationCallback;
  private startTime: number | null = null;
  private timers: ReturnType<typeof setTimeout>[] = [];
  private aborted = false;

  constructor(
    policy: TimeoutPolicy,
    options: {
      fallbackChain?: FallbackChain;
      onEvent?: EscalationCallback;
    } = {}
  ) {
    this.deadlineMs = policy.deadlineMs;
    // Sort steps by triggerAtMs descending (closest to deadline first in the
    // original order, but we schedule from the end backwards).
    this.steps = [...policy.escalations].sort((a, b) => a.triggerAtMs - b.triggerAtMs);
    this.fallbackChain = options.fallbackChain ?? null;
    this.onEvent = options.onEvent ?? (() => {});
  }

  /**
   * Start the escalation timer.  Call once; subsequent calls are no-ops.
   */
  start(invoiceId: string): void {
    if (this.startTime !== null) return;
    this.startTime = Date.now();

    for (const step of this.steps) {
      const delayMs = this.deadlineMs - step.triggerAtMs;
      if (delayMs <= 0) continue; // already past this threshold

      const timer = setTimeout(() => {
        if (this.aborted) return;
        this.executeStep(step, invoiceId);
      }, delayMs);
      this.timers.push(timer);
    }
  }

  /**
   * Cancel all pending escalation steps.
   */
  cancel(): void {
    this.aborted = true;
    for (const timer of this.timers) {
      clearTimeout(timer);
    }
    this.timers = [];
  }

  /**
   * Get remaining milliseconds until the deadline.
   */
  getRemainingMs(): number {
    if (this.startTime === null) return this.deadlineMs;
    const elapsed = Date.now() - this.startTime;
    return Math.max(0, this.deadlineMs - elapsed);
  }

  private async executeStep(step: EscalationStep, invoiceId: string): Promise<void> {
    const remainingMs = this.getRemainingMs();

    this.onEvent({ step: step.action, remainingMs, invoiceId });

    switch (step.action) {
      case "warn":
        // Warn is fire-and-forget — the callback is the only side-effect.
        break;

      case "retryHigherFee":
        // Fee multiplier is handled externally by the caller who receives
        // the escalation event.  The manager signals intent and the caller
        // is responsible for resubmitting with the higher fee.
        break;

      case "switchEndpoint":
        if (this.fallbackChain) {
          try {
            // Signal the fallback chain intent via the event callback.
            // The caller is responsible for actual endpoint rotation using
            // the fallback chain, triggered by this escalation event.
          } catch {
            // Switching endpoint failure should not throw here.
          }
        }
        break;

      case "abort":
        this.cancel();
        throw new PaymentEscalationAbortError(invoiceId, remainingMs);
    }
  }
}
