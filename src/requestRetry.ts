/**
 * Request Timeout and Retry Logic with Exponential Backoff.
 *
 * Implements configurable per-request timeouts (enforced via AbortController),
 * exponential backoff with jitter, retry limits, and robust error classification.
 *
 * Issue #1030
 */

import { isRetryableErrorCode } from "./errorRecovery";

export interface BackoffOptions {
  /** Initial delay before first retry in milliseconds. Default: 500ms. */
  baseDelayMs?: number;
  /** Maximum delay cap between retries in milliseconds. Default: 10,000ms. */
  maxDelayMs?: number;
  /** Multiplier for each subsequent attempt. Default: 2. */
  backoffMultiplier?: number;
  /**
   * Jitter configuration.
   * If true: full random jitter between 0 and calculated delay.
   * If number in [0, 1]: proportional jitter (delay +/- jitter * delay).
   * If false: no jitter (deterministic).
   * Default: true.
   */
  jitter?: boolean | number;
}

export interface RetryLimits {
  /** Maximum number of retries after initial attempt. Default: 3. */
  maxRetries?: number;
  /** Total maximum attempts (initial + retries). Overrides maxRetries if provided. */
  maxAttempts?: number;
}

export interface RequestTimeoutConfig {
  /** Default timeout in milliseconds for requests. Default: 10,000ms. */
  defaultTimeoutMs?: number;
  /** Per-method timeout overrides in milliseconds. */
  methodTimeouts?: Record<string, number>;
}

export interface RequestRetryConfig extends BackoffOptions, RetryLimits, RequestTimeoutConfig {
  /** Method name for per-method timeout/logging resolution. */
  methodName?: string;
  /** Custom predicate to determine whether an error should trigger a retry. */
  retryIf?: (error: unknown, attempt: number) => boolean;
  /** Callback fired prior to waiting for a retry delay. */
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  /** Callback fired when a request attempt times out. */
  onTimeout?: (attempt: number, timeoutMs: number, method?: string) => void;
}

/**
 * Thrown when an operation exceeds its configured deadline.
 */
export class RequestTimeoutError extends Error {
  readonly code = "REQUEST_TIMEOUT";
  readonly method?: string;
  readonly timeoutMs: number;

  constructor(timeoutMs: number, method?: string) {
    const msg = method
      ? `Request timed out after ${timeoutMs}ms (method: ${method})`
      : `Request timed out after ${timeoutMs}ms`;
    super(msg);
    this.name = "RequestTimeoutError";
    this.timeoutMs = timeoutMs;
    this.method = method;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when an operation has exhausted all configured retry attempts.
 */
export class MaxRetriesExceededError extends Error {
  readonly code = "MAX_RETRIES_EXCEEDED";
  readonly attempts: number;
  readonly lastError: unknown;

  constructor(attempts: number, lastError: unknown) {
    const reason = lastError instanceof Error ? lastError.message : String(lastError);
    super(`Operation failed after ${attempts} attempts. Last error: ${reason}`);
    this.name = "MaxRetriesExceededError";
    this.attempts = attempts;
    this.lastError = lastError;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Calculate delay using exponential backoff with optional jitter.
 */
export function calculateBackoffDelay(
  attempt: number,
  options: BackoffOptions = {},
): number {
  const base = Math.max(0, options.baseDelayMs ?? 500);
  const max = Math.max(base, options.maxDelayMs ?? 10_000);
  const multiplier = Math.max(1, options.backoffMultiplier ?? 2);
  const jitter = options.jitter ?? true;

  // attempt is 1-based retry count (attempt 1 = first retry after initial failure)
  const expFactor = Math.pow(multiplier, Math.max(0, attempt - 1));
  const rawDelay = Math.min(base * expFactor, max);

  if (jitter === false) {
    return Math.floor(rawDelay);
  }

  if (typeof jitter === "number") {
    const factor = Math.max(0, Math.min(1, jitter));
    const variation = (Math.random() * 2 - 1) * factor * rawDelay;
    return Math.floor(Math.min(max, Math.max(0, rawDelay + variation)));
  }

  // Full random jitter: random between 0 and rawDelay
  return Math.floor(Math.random() * rawDelay);
}

/**
 * Determine if an error is considered transient and retryable.
 *
 * Consults the centralized error-code classification first (when the error
 * carries a code), then falls back to HTTP-status and message heuristics so
 * request retries stay consistent with the SDK-wide recovery strategy.
 */
export function isRetryableError(error: unknown): boolean {
  if (!error) return false;

  if (error instanceof RequestTimeoutError) return true;

  if (typeof error === "object") {
    const rec = error as Record<string, unknown>;

    // Centralized error-code classification takes precedence.
    const code = rec.code;
    if (typeof code === "string" && code.length > 0) {
      const classified = isRetryableErrorCode(code);
      if (classified !== undefined) {
        return classified;
      }
    }

    // HTTP status codes
    const status = Number(rec.status ?? rec.statusCode ?? rec.code);
    if ([408, 429, 500, 502, 503, 504].includes(status)) {
      return true;
    }

    // Client/validation errors are NOT retryable
    if ([400, 401, 403, 404, 409, 422].includes(status)) {
      return false;
    }
  }

  if (error instanceof Error) {
    if (error.name === "AbortError") return true;

    const msg = error.message.toLowerCase();
    // Non-retryable indicators
    if (
      msg.includes("validation") ||
      msg.includes("not found") ||
      msg.includes("unauthorized") ||
      msg.includes("forbidden") ||
      msg.includes("invalid argument")
    ) {
      return false;
    }

    // Transient / network error indicators
    return /timeout|timed out|network|connection|connect|econnreset|econnrefused|enotfound|eai_again|etimedout|socket hang up|fetch failed|rate limit|too many requests|503|502|504|429/i.test(
      msg,
    );
  }

  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Execute an asynchronous operation with an individual timeout per attempt
 * and exponential backoff retry logic.
 */
export async function executeWithTimeoutAndRetry<T>(
  fn: (signal: AbortSignal) => Promise<T>,
  config: RequestRetryConfig = {},
): Promise<T> {
  const maxAttempts = config.maxAttempts ?? ((config.maxRetries ?? 3) + 1);
  const defaultTimeout = config.defaultTimeoutMs ?? 10_000;
  const timeoutMs = config.methodName && config.methodTimeouts?.[config.methodName] !== undefined
    ? config.methodTimeouts[config.methodName]!
    : defaultTimeout;

  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | null = null;
    let didTimeout = false;

    const timeoutPromise = new Promise<never>((_, reject) => {
      if (timeoutMs > 0 && timeoutMs < Number.POSITIVE_INFINITY) {
        timer = setTimeout(() => {
          didTimeout = true;
          controller.abort();
          config.onTimeout?.(attempt, timeoutMs, config.methodName);
          reject(new RequestTimeoutError(timeoutMs, config.methodName));
        }, timeoutMs);
      }
    });

    try {
      const result = await Promise.race([fn(controller.signal), timeoutPromise]);
      if (timer) clearTimeout(timer);
      return result;
    } catch (err) {
      if (timer) clearTimeout(timer);
      lastError = err;

      const isLastAttempt = attempt >= maxAttempts;
      if (isLastAttempt) {
        break;
      }

      // Check retry eligibility
      let shouldRetry = isRetryableError(err);
      if (config.retryIf) {
        shouldRetry = config.retryIf(err, attempt);
      }

      if (!shouldRetry) {
        throw err;
      }

      // Calculate backoff delay
      const delayMs = calculateBackoffDelay(attempt, config);
      config.onRetry?.(attempt, err, delayMs);

      if (delayMs > 0) {
        await sleep(delayMs);
      }
    }
  }

  // Tag exhausted error if possible
  if (lastError && typeof lastError === "object") {
    try {
      (lastError as Record<string, unknown>).retryExhausted = true;
    } catch {
      // ignore sealed/frozen objects
    }
  }

  throw new MaxRetriesExceededError(maxAttempts, lastError);
}

/**
 * Manager class for configuring and coordinating request timeouts and retries across an application.
 */
export class RequestRetryManager {
  private readonly config: RequestRetryConfig;

  constructor(config: RequestRetryConfig = {}) {
    this.config = {
      defaultTimeoutMs: 10_000,
      maxRetries: 3,
      baseDelayMs: 500,
      maxDelayMs: 10_000,
      backoffMultiplier: 2,
      jitter: true,
      ...config,
    };
  }

  /**
   * Get the configured timeout for a method name.
   */
  getTimeout(methodName?: string): number {
    if (methodName && this.config.methodTimeouts?.[methodName] !== undefined) {
      return this.config.methodTimeouts[methodName]!;
    }
    return this.config.defaultTimeoutMs ?? 10_000;
  }

  /**
   * Get retry limits.
   */
  getLimits(): { maxRetries: number; maxAttempts: number } {
    const maxRetries = this.config.maxRetries ?? 3;
    const maxAttempts = this.config.maxAttempts ?? (maxRetries + 1);
    return { maxRetries, maxAttempts };
  }

  /**
   * Execute an operation with this manager's configuration, optionally merged with per-call overrides.
   */
  async execute<T>(
    fn: (signal: AbortSignal) => Promise<T>,
    overrides?: Partial<RequestRetryConfig> | string,
  ): Promise<T> {
    const mergedConfig: RequestRetryConfig = typeof overrides === "string"
      ? { ...this.config, methodName: overrides }
      : { ...this.config, ...overrides };

    return executeWithTimeoutAndRetry(fn, mergedConfig);
  }
}
