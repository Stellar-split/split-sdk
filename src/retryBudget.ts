/**
 * Caps the total time spent retrying across a series of attempts, so a
 * long chain of individually-reasonable backoffs can't add up to an
 * unbounded wait.
 */

export interface RetryBudgetOptions {
  /** Maximum total retry delay allowed, in milliseconds. */
  maxTotalDelayMs: number;
}

export class RetryBudget {
  private readonly maxTotalDelayMs: number;
  private spentMs = 0;

  constructor(options: RetryBudgetOptions) {
    this.maxTotalDelayMs = options.maxTotalDelayMs;
  }

  /** Whether there's still budget left for another retry delay. */
  hasRemaining(): boolean {
    return this.spentMs < this.maxTotalDelayMs;
  }

  /** Record that a delay of `delayMs` was spent retrying. */
  consume(delayMs: number): void {
    this.spentMs += delayMs;
  }

  /** Remaining budget in milliseconds. */
  remaining(): number {
    return Math.max(0, this.maxTotalDelayMs - this.spentMs);
  }

  /** Reset the budget back to zero spent. */
  reset(): void {
    this.spentMs = 0;
  }
}
