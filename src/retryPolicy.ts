import {
  InvoiceNotFoundError,
  ValidationError,
  WalletNotConnectedError,
  RpcError,
} from "./errors.js";

export interface RetryOptions {
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  onRetry?: (attempt: number, error: unknown, delayMs: number) => void;
}

export type PerMethodRetryOptions = Partial<RetryOptions>;

export function isRetryable(error: unknown): boolean {
  if (error instanceof InvoiceNotFoundError) return false;
  if (error instanceof ValidationError) return false;
  if (error instanceof WalletNotConnectedError) return false;

  if (error instanceof RpcError) {
    return error.statusCode === 429 || error.statusCode === 503;
  }

  if (!(error instanceof Error)) return false;

  const msg = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    /timeout|timed out|network|failed to fetch|connection|connect|econnreset|econnrefused|eai_again|enotfound|429|503/.test(
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

  let lastError: unknown;
  let attemptsExhausted = false;

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;

      const isLast = attempt === maxAttempts - 1;
      if (!isRetryable(error)) break;
      if (isLast) {
        attemptsExhausted = true;
        break;
      }

      const jitter = Math.random() * baseDelayMs;
      const delayMs = Math.min(baseDelayMs * 2 ** attempt + jitter, maxDelayMs);
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
