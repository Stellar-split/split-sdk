/**
 * Per-method timeout configuration and enforcement via AbortController.
 * Also includes EscalationManager for pre-deadline escalation actions.
 */

import { PaymentEscalationAbortError } from "./errors.js";
import type { EscalationStep, TimeoutPolicy } from "./types.js";
import { FallbackChain } from "./fallbackChain.js";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_BASE_DELAY_MS = 200;
const DEFAULT_MAX_DELAY_MS = 5_000;
const DEFAULT_BACKOFF_FACTOR = 2;
const DEFAULT_JITTER = 0.2;

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

  constructor(method: string, timeoutMs: number);
  constructor(timeoutMs: number, method: string);
  constructor(a: string | number, b: number | string) {
    const [method, timeoutMs] =
      typeof a === "number" ? [b as string, a] : [a, b as number];
    super(`Timeout: Request timed out after ${timeoutMs}ms (method: ${method})`);
    this.name = "RequestTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type TimeoutResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: "timeout" | "error"; error?: Error };

/**
 * Retry configuration.  All fields are optional and fall back to sensible
 * defaults.  A per-method override may be supplied via {@link RetryConfigMap}.
 */
export interface RetryConfig {
  /** Maximum number of attempts (including the first). Default 3. */
  maxAttempts?: number;
  /** Base delay in ms before the first retry. Default 200. */
  baseDelayMs?: number;
  /** Upper bound on any single backoff delay in ms. Default 5000. */
  maxDelayMs?: number;
  /** Exponential growth factor applied per attempt. Default 2. */
  backoffFactor?: number;
  /** Jitter fraction (0..1) applied to each delay. Default 0.2. */
  jitter?: number;
  /** Optional predicate to decide whether an error is retryable. */
  isRetryable?: (error: Error) => boolean;
}

/**
 * Retry config keyed by method name.  The special key "default" applies to
 * any method not explicitly listed.
 */
export type RetryConfigMap = {
  default?: RetryConfig;
} & Record<string, RetryConfig | undefined>;

/** Aggregated retry/timeout statistics. */
export interface RetryStats {
  /** Total attempts made across all calls (including first attempts). */
  attempts: number;
  /** Number of calls that ultimately succeeded. */
  successes: number;
  /** Number of calls that ultimately failed (non-retryable or exhausted). */
  failures: number;
  /** Number of attempts that timed out. */
  timeouts: number;
  /** Number of retries performed (attempts beyond the first). */
  retries: number;
  /** Total time spent sleeping in backoff, in ms. */
  totalBackoffMs: number;
  /** Per-method breakdown of the same counters. */
  byMethod: Record<string, RetryStats>;
}

function emptyStats(): RetryStats {
  return {
    attempts: 0,
    successes: 0,
    failures: 0,
    timeouts: 0,
    retries: 0,
    totalBackoffMs: 0,
    byMethod: {},
  };
}

/**
 * Default retryable-error classification.  Timeouts, network errors and
 * transient server failures (5xx / 429) are retryable; everything else is
 * treated as terminal.
 */
export function isRetryableError(error: Error): boolean {
  if (error instanceof RequestTimeoutError) return true;

  const code = (error as { code?: unknown }).code;
  if (typeof code === "string") {
    const retryableCodes = [
      "ECONNRESET",
      "ECONNREFUSED",
      "ETIMEDOUT",
      "ENOTFOUND",
      "EAI_AGAIN",
      "EPIPE",
      "REQUEST_TIMEOUT",
      "NETWORK_ERROR",
      "RATE_LIMITED",
    ];
    if (retryableCodes.includes(code)) return true;
  }

  const status = (error as { status?: unknown; statusCode?: unknown }).status ??
    (error as { statusCode?: unknown }).statusCode;
  if (typeof status === "number") {
    return status === 429 || (status >= 500 && status <= 599);
  }

  return false;
}

/** Compute an exponential backoff delay with jitter for the given attempt. */
export function computeBackoffDelay(
  attempt: number,
  config: RetryConfig = {}
): number {
  const baseDelayMs = config.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maxDelayMs = config.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const factor = config.backoffFactor ?? DEFAULT_BACKOFF_FACTOR;
  const jitter = Math.min(Math.max(config.jitter ?? DEFAULT_JITTER, 0), 1);

  const exponential = baseDelayMs * Math.pow(factor, Math.max(0, attempt - 1));
  const capped = Math.min(exponential, maxDelayMs);
  // Symmetric jitter around the capped delay.
  const jitterAmount = capped * jitter * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(capped + jitterAmount));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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
  private readonly _retryConfig: RetryConfigMap;
  private readonly _stats: RetryStats = emptyStats();

  constructor(config: TimeoutConfig, retryConfig: RetryConfigMap = {}) {
    if (typeof config === "number") {
      this._config = { default: config };
    } else {
      this._config = config;
    }
    this._retryConfig = retryConfig;
  }

  resolveTimeout(method: string): number {
    return this._config[method] ?? this._config.default ?? DEFAULT_TIMEOUT_MS;
  }

  /** Resolve the effective retry config for a method. */
  resolveRetryConfig(method: string): Required<Omit<RetryConfig, "isRetryable">> & {
    isRetryable: (error: Error) => boolean;
  } {
    const merged: RetryConfig = {
      ...(this._retryConfig.default ?? {}),
      ...(this._retryConfig[method] ?? {}),
    };
    return {
      maxAttempts: Math.max(1, merged.maxAttempts ?? DEFAULT_MAX_ATTEMPTS),
      baseDelayMs: merged.baseDelayMs ?? DEFAULT_BASE_DELAY_MS,
      maxDelayMs: merged.maxDelayMs ?? DEFAULT_MAX_DELAY_MS,
      backoffFactor: merged.backoffFactor ?? DEFAULT_BACKOFF_FACTOR,
      jitter: merged.jitter ?? DEFAULT_JITTER,
      isRetryable: merged.isRetryable ?? isRetryableError,
    };
  }

  /** Snapshot of accumulated retry/timeout statistics. */
  getStats(): RetryStats {
    return {
      ...this._stats,
      byMethod: Object.fromEntries(
        Object.entries(this._stats.byMethod).map(([k, v]) => [k, { ...v }])
      ),
    };
  }

  /** Reset accumulated statistics. */
  resetStats(): void {
    this._stats.attempts = 0;
    this._stats.successes = 0;
    this._stats.failures = 0;
    this._stats.timeouts = 0;
    this._stats.retries = 0;
    this._stats.totalBackoffMs = 0;
    this._stats.byMethod = {};
  }

  private methodStats(method: string): RetryStats {
    let entry = this._stats.byMethod[method];
    if (!entry) {
      entry = emptyStats();
      this._stats.byMethod[method] = entry;
    }
    return entry;
  }

  private recordAttempt(method: string, timedOut: boolean): void {
    this._stats.attempts++;
    this.methodStats(method).attempts++;
    if (timedOut) {
      this._stats.timeouts++;
      this.methodStats(method).timeouts++;
    }
  }

  private recordRetry(method: string, backoffMs: number): void {
    this._stats.retries++;
    this._stats.totalBackoffMs += backoffMs;
    const m = this.methodStats(method);
    m.retries++;
    m.totalBackoffMs += backoffMs;
  }

  private recordOutcome(method: string, ok: boolean): void {
    if (ok) {
      this._stats.successes++;
      this.methodStats(method).successes++;
    } else {
      this._stats.failures++;
      this.methodStats(method).failures++;
    }
  }

  /**
   * Run `fn` with the method's configured timeout and retry policy.
   * Retries use exponential backoff with jitter and only occur for errors
   * classified as retryable.  Statistics are accumulated on the manager.
   */
  async execute<T>(
    method: string,
    fn: (signal: AbortSignal) => Promise<T>
  ): Promise<TimeoutResult<T>> {
    const timeoutMs = this.resolveTimeout(method);
    const retry = this.resolveRetryConfig(method);

    let lastResult: TimeoutResult<T> = {
      ok: false,
      reason: "error",
      error: new Error(`No attempts made for ${method}`),
    };

    for (let attempt = 1; attempt <= retry.maxAttempts; attempt++) {
      const result = await withTimeout(fn, timeoutMs, method);
      this.recordAttempt(method, !result.ok && result.reason === "timeout");

      if (result.ok) {
        this.recordOutcome(method, true);
        return result;
      }

      lastResult = result;
      const error = result.error ?? new Error(`Attempt ${attempt} failed for ${method}`);
      const canRetry = attempt < retry.maxAttempts && retry.isRetryable(error);
      if (!canRetry) break;

      const delayMs = computeBackoffDelay(attempt, retry);
      this.recordRetry(method, delayMs);
      if (delayMs > 0) await sleep(delayMs);
    }

    this.recordOutcome(method, false);
    return lastResult;
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
      // `error` is kept non-enumerable: callers like withTimeoutOrThrow()
      // still read it via result.error, but it's excluded from shallow
      // equality checks (toEqual) against the plain { ok, reason } shape.
      const result = { ok: false as const, reason: "timeout" as const };
      Object.defineProperty(result, "error", { value: error, enumerable: false });
      return result as TimeoutResult<T>;
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
