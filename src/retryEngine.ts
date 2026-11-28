import { TelemetryCollector } from "./telemetryCollector.js";
import { CircuitOpenError } from "./errors.js";
import { classifyHorizonError } from "./horizonErrorClassifier.js";
import { RetryBudget } from "./retryBudget.js";

export interface RetryStrategy {
  maxAttempts: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  jitterMs?: number;
}

export interface RetryEngineOptions {
  /**
   * Multiplicative jitter applied to each computed delay.
   * Each delay is multiplied by a random value in [1 - jitterFactor, 1 + jitterFactor].
   * Must be in the range [0, 1]. Set to 0 to disable jitter entirely.
   * @default 0.2
   */
  jitterFactor?: number;
  /**
   * Optional shared retry budget. When exhausted, retries are skipped and
   * the call fails fast until the budget window resets.
   */
  retryBudget?: RetryBudget;
}

export interface RetryConfig {
  transient: RetryStrategy;
  rateLimit: RetryStrategy;
  contract: RetryStrategy;
  /** Number of consecutive transient failures before the circuit opens. */
  circuitBreakerThreshold: number;
  /** Milliseconds the circuit stays open before resetting. */
  circuitResetMs: number;
  /**
   * Unified retry policy. When provided, these values override the per-class
   * strategies for max attempts, base delay, multiplier and jitter.
   */
  policy?: RetryPolicy;
  /** @deprecated use policy.maxAttempts */
  maxRetries?: number;
  /** @deprecated use policy.baseDelayMs */
  baseDelayMs?: number;
}

export interface RetryPolicy {
  /** Maximum number of attempts (including the first). */
  maxAttempts: number;
  /** Base delay in milliseconds before the first retry. */
  baseDelayMs: number;
  /** Multiplier applied to the delay on each subsequent retry. */
  backoffMultiplier: number;
  /** Multiplicative jitter factor in [0, 1]. */
  jitterFactor?: number;
  /** Upper bound for any computed delay in milliseconds. */
  maxDelayMs?: number;
}

export interface RetryStats {
  /** Total number of attempts made across all executions. */
  attempts: number;
  /** Number of retries performed (attempts beyond the first). */
  retries: number;
  /** Number of executions that eventually succeeded. */
  successes: number;
  /** Number of executions that ultimately failed. */
  failures: number;
  /** Total time spent sleeping between retries, in milliseconds. */
  totalBackoffMs: number;
}

type ErrorClass = "transient" | "rateLimit" | "contract";

function classifyError(error: unknown): ErrorClass {
  if (!(error instanceof Error)) return "transient";
  const msg = error.message;

  // Use horizonErrorClassifier when result codes are available on the error
  const errorObj = error as unknown as Record<string, unknown>;
  if (errorObj.resultCodes) {
    const classification = classifyHorizonError(errorObj.resultCodes as string | string[]);
    if (classification.isRetryable) return "transient";
    return "contract";
  }

  if (/Error\(Contract,\s*#\d+\)/i.test(msg)) return "contract";
  if (/429|rate.?limit|too many requests/i.test(msg)) return "rateLimit";
  return "transient";
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class RetryEngine {
  private _consecutiveTransientFailures = 0;
  private _circuitOpenedAt: number | null = null;
  private readonly _jitterFactor: number;
  private readonly _policy: RetryPolicy;
  private readonly _retryBudget?: RetryBudget;
  private readonly _stats: RetryStats = {
    attempts: 0,
    retries: 0,
    successes: 0,
    failures: 0,
    totalBackoffMs: 0,
  };

  constructor(
    private readonly config: RetryConfig,
    private readonly telemetry: TelemetryCollector,
    options: RetryEngineOptions = {}
  ) {
    const jf = options.jitterFactor ?? config.policy?.jitterFactor ?? 0;
    if (jf < 0 || jf > 1) {
      throw new Error(`jitterFactor must be in [0, 1], got ${jf}`);
    }
    this._jitterFactor = jf;
    this._retryBudget = options.retryBudget;

    const base = config.policy;
    this._policy = {
      maxAttempts: base?.maxAttempts ?? config.maxRetries ?? config.transient.maxAttempts,
      baseDelayMs: base?.baseDelayMs ?? config.baseDelayMs ?? config.transient.initialDelayMs,
      backoffMultiplier: base?.backoffMultiplier ?? config.transient.backoffMultiplier,
      jitterFactor: jf,
      maxDelayMs: base?.maxDelayMs,
    };
  }

  /** Snapshot of accumulated retry statistics. */
  get stats(): Readonly<RetryStats> {
    return { ...this._stats };
  }

  /** Reset accumulated retry statistics. */
  resetStats(): void {
    this._stats.attempts = 0;
    this._stats.retries = 0;
    this._stats.successes = 0;
    this._stats.failures = 0;
    this._stats.totalBackoffMs = 0;
  }

  private _strategyFor(errorClass: ErrorClass): RetryStrategy {
    const base = this.config[errorClass];
    return {
      maxAttempts: base.maxAttempts,
      initialDelayMs: base.initialDelayMs,
      backoffMultiplier: base.backoffMultiplier,
      jitterMs: base.jitterMs,
    };
  }

  private _computeDelay(strategy: RetryStrategy, attempt: number): number {
    const exponential =
      strategy.initialDelayMs * strategy.backoffMultiplier ** (attempt - 1) +
      (strategy.jitterMs ? Math.random() * strategy.jitterMs : 0);

    const jittered =
      this._jitterFactor === 0
        ? exponential
        : exponential * (1 - this._jitterFactor + Math.random() * 2 * this._jitterFactor);

    const capped =
      this._policy.maxDelayMs !== undefined
        ? Math.min(jittered, this._policy.maxDelayMs)
        : jittered;

    return Math.max(0, capped);
  }

  get isCircuitOpen(): boolean {
    if (this._circuitOpenedAt === null) return false;
    if (Date.now() - this._circuitOpenedAt >= this.config.circuitResetMs) {
      // Auto-reset after timeout
      this._circuitOpenedAt = null;
      this._consecutiveTransientFailures = 0;
      return false;
    }
    return true;
  }

  async execute<T>(fn: () => Promise<T>, methodName: string): Promise<T> {
    if (this.isCircuitOpen) {
      throw new CircuitOpenError({ methodName });
    }

    let lastError: unknown;

    // We don't know the error class until the first failure, so we start
    // with a temporary "transient" strategy and switch on first error.
    let strategy: RetryStrategy = this.config.transient;
    let errorClass: ErrorClass | null = null;

    for (let attempt = 1; ; attempt++) {
      const start = Date.now();
      this._stats.attempts += 1;
      try {
        const result = await fn();
        const duration = Date.now() - start;
        this.telemetry.recordMethod(methodName, true, duration);
        if (errorClass === "transient") {
          this._consecutiveTransientFailures = 0;
        }
        this._stats.successes += 1;
        return result;
      } catch (error) {
        const duration = Date.now() - start;
        lastError = error;

        if (errorClass === null) {
          errorClass = classifyError(error);
          strategy = this._strategyFor(errorClass);
        }

        this.telemetry.recordMethod(methodName, false, duration);

        if (errorClass === "transient") {
          this._consecutiveTransientFailures += 1;
          if (this._consecutiveTransientFailures >= this.config.circuitBreakerThreshold) {
            this._circuitOpenedAt = Date.now();
            this._stats.failures += 1;
            throw new CircuitOpenError({ methodName });
          }
        }

        // Contract errors are never retried
        if (errorClass === "contract" || attempt >= strategy.maxAttempts) {
          break;
        }

        // Shared budget exhausted: fail fast without further retries.
        if (this._retryBudget && !this._retryBudget.hasRemaining()) {
          break;
        }

        const delay = this._computeDelay(strategy, attempt);
        this._stats.retries += 1;
        this._stats.totalBackoffMs += delay;
        this._retryBudget?.consume(delay);

        await sleep(delay);
      }
    }

    this._stats.failures += 1;
    throw lastError;
  }
}
