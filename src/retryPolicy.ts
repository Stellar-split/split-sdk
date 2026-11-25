import {
  InvoiceNotFoundError,
  ValidationError,
  WalletNotConnectedError,
  RpcError,
  PaymentCooldownActiveError,
  RoundNotEndedError,
  WrongMilestoneError,
  NothingToClaimError,
  InvoiceExpiredError,
  PayerNotWhitelistedError,
  ContributionCapExceededError,
  ContractFrozenError,
  InvoiceFullyFundedError,
  DelegateLimitReachedError,
  InvoiceFrozenError,
  UnauthorizedError,
  CircuitOpenError,
  TransactionNotConfirmedError,
  InvalidContractAddressError,
  TransactionVerificationError,
  isRetryableErrorCode,
} from "./errors.js";
import type { RetryBudget } from "./retryBudget.js";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
  retryIf?: (error: Error) => boolean;
  /** Optional shared retry budget checked before each retry attempt. */
  budget?: RetryBudget;
}

export type PerMethodRetryOptions = Partial<RetryOptions>;

export interface TimeoutOptions {
  /** Per-attempt timeout in milliseconds. 0 or undefined disables the timeout. */
  timeoutMs?: number;
}

export interface RetryStats {
  /** Total number of calls made through the executor. */
  totalCalls: number;
  /** Calls that succeeded on the first attempt. */
  succeededFirstTry: number;
  /** Calls that succeeded after at least one retry. */
  succeededAfterRetry: number;
  /** Calls that ultimately failed (all attempts exhausted or non-retryable). */
  failed: number;
  /** Total number of retry attempts performed across all calls. */
  totalRetries: number;
  /** Number of attempts that timed out. */
  timeouts: number;
  /** Total time spent sleeping between retries, in milliseconds. */
  totalBackoffMs: number;
  /** Last error observed, if any. */
  lastError?: unknown;
}

export interface RetryPolicyOptions extends RetryOptions, TimeoutOptions {}

export interface RetryExecutor {
  /** Execute `fn` under the configured timeout + retry policy. */
  execute<T>(fn: () => Promise<T>, methodOverride?: PerMethodRetryOptions & TimeoutOptions): Promise<T>;
  /** Snapshot of the current retry statistics. */
  getStats(): RetryStats;
  /** Reset the retry statistics to their initial values. */
  resetStats(): void;
}

export class RequestTimeoutError extends Error {
  constructor(public readonly timeoutMs: number) {
    super(`Request timed out after ${timeoutMs}ms`);
    this.name = "RequestTimeoutError";
  }
}

function withTimeout<T>(fn: () => Promise<T>, timeoutMs: number | undefined): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return fn();

  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new RequestTimeoutError(timeoutMs));
    }, timeoutMs);

    fn().then(
      (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(error);
      }
    );
  });
}

function createInitialStats(): RetryStats {
  return {
    totalCalls: 0,
    succeededFirstTry: 0,
    succeededAfterRetry: 0,
    failed: 0,
    totalRetries: 0,
    timeouts: 0,
    totalBackoffMs: 0,
  };
}

/**
 * Build a configured retry executor that enforces per-attempt timeouts,
 * applies exponential backoff with jitter, and tracks retry statistics.
 */
export function createRetryExecutor(options: RetryPolicyOptions): RetryExecutor {
  const stats = createInitialStats();

  return {
    async execute<T>(
      fn: () => Promise<T>,
      methodOverride?: PerMethodRetryOptions & TimeoutOptions
    ): Promise<T> {
      const maxAttempts = Math.max(1, methodOverride?.maxAttempts ?? options.maxAttempts);
      const baseDelayMs = methodOverride?.baseDelayMs ?? options.baseDelayMs;
      const maxDelayMs = methodOverride?.maxDelayMs ?? options.maxDelayMs;
      const timeoutMs = methodOverride?.timeoutMs ?? options.timeoutMs;
      const onRetry = methodOverride?.onRetry ?? options.onRetry;
      const retryIf = methodOverride?.retryIf ?? options.retryIf;
      const budget = methodOverride?.budget ?? options.budget;

      stats.totalCalls++;

      let lastError: unknown;
      let retries = 0;
      let attemptsExhausted = false;

      for (let attempt = 0; attempt < maxAttempts; attempt++) {
        try {
          const result = await withTimeout(fn, timeoutMs);
          if (retries === 0) stats.succeededFirstTry++;
          else stats.succeededAfterRetry++;
          return result;
        } catch (error) {
          lastError = error;
          stats.lastError = error;
          if (error instanceof RequestTimeoutError) stats.timeouts++;

          const isLast = attempt === maxAttempts - 1;
          if (!isRetryable(error)) break;
          if (error instanceof Error && retryIf && !retryIf(error)) break;
          if (isLast) {
            attemptsExhausted = true;
            break;
          }
          if (budget && !budget.hasRemaining()) break;

          const jitter = Math.random() * baseDelayMs;
          const delayMs = Math.min(baseDelayMs * 2 ** attempt + jitter, maxDelayMs);
          retries++;
          stats.totalRetries++;
          stats.totalBackoffMs += delayMs;
          budget?.consume(delayMs);
          onRetry?.(attempt + 1, error, delayMs);
          await sleep(delayMs);
        }
      }

      stats.failed++;

      if (attemptsExhausted) {
        try {
          (lastError as Record<string, unknown>).retryExhausted = true;
        } catch {
          // frozen or sealed object — best-effort
        }
      }
      throw lastError;
    },

    getStats(): RetryStats {
      return { ...stats };
    },

    resetStats(): void {
      Object.assign(stats, createInitialStats());
    },
  };
}

export function isRetryable(error: unknown): boolean {
  if (error instanceof RpcError) {
    return error.statusCode === 429 || error.statusCode === 502 || error.statusCode === 503 || error.statusCode === 504;
  }

  // Prefer the centralized error-code taxonomy when the error carries a code.
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    if (typeof code === "string" && code.length > 0) {
      return isRetryableErrorCode(code);
    }
  }

  // Fallback for uncoded errors: explicit classification by error type.
  if (error instanceof PaymentCooldownActiveError) return true;
  if (error instanceof CircuitOpenError) return true;
  if (error instanceof TransactionNotConfirmedError) return true;
  if (error instanceof InvoiceNotFoundError) return false;
  if (error instanceof ValidationError) return false;
  if (error instanceof WalletNotConnectedError) return false;
  if (error instanceof InvoiceFrozenError) return false;
  if (error instanceof UnauthorizedError) return false;
  if (error instanceof RoundNotEndedError) return false;
  if (error instanceof WrongMilestoneError) return false;
  if (error instanceof NothingToClaimError) return false;
  if (error instanceof InvoiceExpiredError) return false;
  if (error instanceof PayerNotWhitelistedError) return false;
  if (error instanceof ContributionCapExceededError) return false;
  if (error instanceof ContractFrozenError) return false;
  if (error instanceof InvoiceFullyFundedError) return false;
  if (error instanceof DelegateLimitReachedError) return false;
  if (error instanceof InvalidContractAddressError) return false;
  if (error instanceof TransactionVerificationError) return false;

  if (!(error instanceof Error)) return false;

  const msg = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    /timeout|timed out|network|failed to fetch|connection|connect|econnreset|econnrefused|eai_again|enotfound|429|502|503|504/.test(
      msg
    )
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function executeWithRetry<T>(
  fn: () => Promise<T>,
  options: RetryOptions,
  methodOverride?: PerMethodRetryOptions
): Promise<T> {
  const maxAttempts = Math.max(1, methodOverride?.maxAttempts ?? options.maxAttempts);
  const baseDelayMs = methodOverride?.baseDelayMs ?? options.baseDelayMs;
  const maxDelayMs = methodOverride?.maxDelayMs ?? options.maxDelayMs;
  const onRetry = methodOverride?.onRetry ?? options.onRetry;
  const retryIf = methodOverride?.retryIf ?? options.retryIf;
  const budget = methodOverride?.budget ?? options.budget;

  let lastError: unknown;
  let attemptsExhausted = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isLast = attempt === maxAttempts - 1;
      if (!isRetryable(error)) break;
      if (error instanceof Error && retryIf && !retryIf(error)) break;
      if (isLast) {
        attemptsExhausted = true;
        break;
      }
      if (budget && !budget.hasRemaining()) break;

      const jitter = Math.random() * baseDelayMs;
      const delayMs = Math.min(baseDelayMs * 2 ** attempt + jitter, maxDelayMs);
      budget?.consume(delayMs);
      onRetry?.(attempt + 1, error, delayMs);
      await sleep(delayMs);
    }
  }

  if (attemptsExhausted) {
    try {
      (lastError as Record<string, unknown>).retryExhausted = true;
    } catch {
      // frozen or sealed object — best-effort
    }
  }
  throw lastError;
}
