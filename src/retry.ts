/**
 * Tracks cumulative retry time across calls within a rolling window.
 * Once the budget is exhausted, further retries should fail fast until
 * the window resets.
 */
export class RetryBudget {
  private consumedMs = 0;
  private windowStart: number;

  constructor(
    private readonly maxRetryMs: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now
  ) {
    this.windowStart = this.now();
  }

  private maybeReset(): void {
    if (this.now() - this.windowStart >= this.windowMs) {
      this.consumedMs = 0;
      this.windowStart = this.now();
    }
  }

  /** Records time spent retrying. */
  consume(retryDurationMs: number): void {
    this.maybeReset();
    this.consumedMs += Math.max(0, retryDurationMs);
  }

  /** Returns true if any budget remains in the current window. */
  hasRemaining(): boolean {
    this.maybeReset();
    return this.consumedMs < this.maxRetryMs;
  }
}

/**
 * Retry an asynchronous operation with exponential backoff.
 * If a RetryBudget is supplied, retries stop once it is exhausted.
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  maxAttempts: number,
  baseDelayMs: number,
  budget?: RetryBudget
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
      if (budget && !budget.hasRemaining()) {
        break;
      }
      const delayMs = computeBackoffDelay(attempt, { baseDelayMs });
      const start = Date.now();
      await sleep(delayMs);
      budget?.consume(Date.now() - start);
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