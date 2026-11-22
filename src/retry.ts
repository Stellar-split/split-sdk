/**
 * Retry an asynchronous operation with exponential backoff.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number
): Promise<T> {
  const attempts = Math.max(1, maxAttempts);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn();
    } catch (error) {
      lastError = error;
      if (attempt === attempts || !isRetryableError(error)) {
        break;
      }
      const delayMs = computeBackoffDelay(attempt, { baseDelayMs });
      await sleep(delayMs);
    }
  }

  throw lastError;
}

export interface BackoffOptions {
  /** Base delay in milliseconds for the first retry. */
  baseDelayMs: number;
  /** Optional maximum delay cap in milliseconds. */
  maxDelayMs?: number;
  /** Optional jitter factor (0..1) applied to the computed delay. */
  jitter?: number;
}

/**
 * Compute the backoff delay for a given attempt using exponential backoff.
 *
 * @param attempt The attempt number (1-based) that just failed.
 * @param options Backoff configuration.
 */
export function computeBackoffDelay(
  attempt: number,
  options: BackoffOptions
): number {
  const { baseDelayMs, maxDelayMs, jitter } = options;
  const safeAttempt = Math.max(1, attempt);
  let delayMs = baseDelayMs * 2 ** (safeAttempt - 1);

  if (typeof maxDelayMs === "number" && maxDelayMs >= 0) {
    delayMs = Math.min(delayMs, maxDelayMs);
  }

  if (typeof jitter === "number" && jitter > 0) {
    const factor = Math.min(1, jitter);
    const spread = delayMs * factor;
    delayMs = delayMs - spread + Math.random() * spread * 2;
    delayMs = Math.max(0, delayMs);
  }

  return delayMs;
}

export function isRetryableError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const message = error.message.toLowerCase();
  return (
    error.name === "AbortError" ||
    /timeout|timed out|network|failed to fetch|connection|connect|econnreset|econnrefused|eai_again|enotfound|transaction not confirmed|503|502|504/.test(
      message
    )
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}