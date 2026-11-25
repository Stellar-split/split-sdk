/**
 * Payment flow retry and provider fallback (issue #1373).
 *
 * Wraps a payment submission in two layers of resilience:
 *
 * - **Exponential backoff retry** — transient failures (timeouts, network
 *   errors, 5xx responses) are retried against the same provider with an
 *   exponentially growing, optionally jittered delay.
 * - **Provider fallback** — when a provider exhausts its attempts or fails
 *   with a non-transient error, the next provider in the list is tried.
 *
 * Every attempt is recorded so callers can inspect exactly what happened.
 *
 * @example
 * ```ts
 * const flow = new PaymentFlowRetry([
 *   { name: "primary", execute: (p) => primaryClient.pay(p) },
 *   { name: "backup",  execute: (p) => backupClient.pay(p) },
 * ], { maxAttempts: 3, baseDelayMs: 500 });
 *
 * const { result, provider, attempts } = await flow.execute(payment);
 * ```
 */

import { StellarSplitError } from "./errors.js";
import { computeBackoffDelay, isRetryableError } from "./retry.js";

/** A payment provider that can submit a payment. */
export interface PaymentProvider<P, R> {
  /** Identifier used in attempt records and errors. */
  name: string;
  /** Submit the payment through this provider. */
  execute: (payment: P) => Promise<R>;
}

/** Configuration for {@link PaymentFlowRetry}. */
export interface PaymentFlowRetryOptions {
  /** Attempts per provider, including the first. Defaults to 3. */
  maxAttempts?: number;
  /** Delay before the first retry in milliseconds. Defaults to 500. */
  baseDelayMs?: number;
  /** Upper bound for a single retry delay in milliseconds. Defaults to 10 000. */
  maxDelayMs?: number;
  /** Jitter factor (0..1) applied to each delay. Defaults to 0. */
  jitter?: number;
  /** Decides whether an error is transient and worth retrying. Defaults to {@link isRetryableError}. */
  isTransient?: (error: unknown) => boolean;
  /** Called after every attempt with its record. */
  onAttempt?: (record: PaymentAttemptRecord) => void;
  /** Sleep implementation (injectable for tests). */
  sleep?: (ms: number) => Promise<void>;
}

/** Record of a single payment attempt. */
export interface PaymentAttemptRecord {
  /** Provider the attempt was made against. */
  provider: string;
  /** 1-based attempt number for this provider. */
  attempt: number;
  /** Whether the attempt succeeded. */
  success: boolean;
  /** Error message when the attempt failed. */
  error?: string;
  /** Whether the failure was classified as transient. */
  transient?: boolean;
  /** Backoff delay scheduled after this attempt (0 when none). */
  delayMs: number;
  /** Epoch milliseconds when the attempt started. */
  timestamp: number;
}

/** Successful outcome of {@link PaymentFlowRetry.execute}. */
export interface PaymentFlowResult<R> {
  /** Value returned by the provider. */
  result: R;
  /** Name of the provider that succeeded. */
  provider: string;
  /** Every attempt made during this execution, in order. */
  attempts: PaymentAttemptRecord[];
}

/** Thrown when every provider has failed. */
export class PaymentFlowExhaustedError extends StellarSplitError {
  public readonly attempts: PaymentAttemptRecord[];

  constructor(attempts: PaymentAttemptRecord[]) {
    super(
      `Payment failed after ${attempts.length} attempts across all providers.`,
      "PAYMENT_FLOW_EXHAUSTED",
      { attempts },
    );
    this.attempts = attempts;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Retries a payment with exponential backoff and falls back across providers. */
export class PaymentFlowRetry<P, R> {
  private readonly providers: PaymentProvider<P, R>[];
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitter: number;
  private readonly isTransient: (error: unknown) => boolean;
  private readonly onAttempt?: (record: PaymentAttemptRecord) => void;
  private readonly sleep: (ms: number) => Promise<void>;
  private lastAttempts: PaymentAttemptRecord[] = [];

  constructor(providers: PaymentProvider<P, R>[], options: PaymentFlowRetryOptions = {}) {
    if (!Array.isArray(providers) || providers.length === 0) {
      throw new RangeError("PaymentFlowRetry requires at least one provider");
    }
    const maxAttempts = options.maxAttempts ?? 3;
    if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
      throw new RangeError("maxAttempts must be an integer of at least 1");
    }

    this.providers = [...providers];
    this.maxAttempts = maxAttempts;
    this.baseDelayMs = options.baseDelayMs ?? 500;
    this.maxDelayMs = options.maxDelayMs ?? 10_000;
    this.jitter = options.jitter ?? 0;
    this.isTransient = options.isTransient ?? isRetryableError;
    this.onAttempt = options.onAttempt;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  /**
   * Submit a payment, retrying transient failures and falling back to the
   * next provider when one gives up.
   *
   * @throws {PaymentFlowExhaustedError} When every provider has failed.
   */
  async execute(payment: P): Promise<PaymentFlowResult<R>> {
    const attempts: PaymentAttemptRecord[] = [];
    this.lastAttempts = attempts;

    for (const provider of this.providers) {
      for (let attempt = 1; attempt <= this.maxAttempts; attempt++) {
        const timestamp = Date.now();
        try {
          const result = await provider.execute(payment);
          this.record(attempts, { provider: provider.name, attempt, success: true, delayMs: 0, timestamp });
          return { result, provider: provider.name, attempts: [...attempts] };
        } catch (error) {
          const transient = this.isTransient(error);
          const willRetry = transient && attempt < this.maxAttempts;
          const delayMs = willRetry
            ? computeBackoffDelay(attempt, {
                baseDelayMs: this.baseDelayMs,
                maxDelayMs: this.maxDelayMs,
                jitter: this.jitter,
              })
            : 0;
          this.record(attempts, {
            provider: provider.name,
            attempt,
            success: false,
            error: error instanceof Error ? error.message : String(error),
            transient,
            delayMs,
            timestamp,
          });
          if (!willRetry) {
            break;
          }
          await this.sleep(delayMs);
        }
      }
    }

    throw new PaymentFlowExhaustedError([...attempts]);
  }

  /** Attempts made during the most recent {@link execute} call. */
  getAttempts(): readonly PaymentAttemptRecord[] {
    return [...this.lastAttempts];
  }

  private record(attempts: PaymentAttemptRecord[], record: PaymentAttemptRecord): void {
    attempts.push(record);
    this.onAttempt?.(record);
  }
}
