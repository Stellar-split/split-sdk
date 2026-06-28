import { TelemetryCollector } from "./telemetryCollector.js";
import { CircuitOpenError } from "./errors.js";

export interface RetryStrategy {
  maxAttempts: number;
  initialDelayMs: number;
  backoffMultiplier: number;
  jitterMs?: number;
}

export interface RetryConfig {
  transient: RetryStrategy;
  rateLimit: RetryStrategy;
  contract: RetryStrategy;
  /** Number of consecutive transient failures before the circuit opens. */
  circuitBreakerThreshold: number;
  /** Milliseconds the circuit stays open before resetting. */
  circuitResetMs: number;
  maxRetries?: number;
  baseDelayMs?: number;
}

type ErrorClass = "transient" | "rateLimit" | "contract";

function classifyError(error: unknown): ErrorClass {
  if (!(error instanceof Error)) return "transient";
  const msg = error.message;
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

  constructor(
    private readonly config: RetryConfig,
    private readonly telemetry: TelemetryCollector
  ) {}

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
      try {
        const result = await fn();
        const duration = Date.now() - start;
        this.telemetry.recordMethod(methodName, true, duration);
        if (errorClass === "transient") {
          this._consecutiveTransientFailures = 0;
        }
        return result;
      } catch (error) {
        const duration = Date.now() - start;
        lastError = error;

        if (errorClass === null) {
          errorClass = classifyError(error);
          strategy = this.config[errorClass];
        }

        this.telemetry.recordMethod(methodName, false, duration);

        if (errorClass === "transient") {
          this._consecutiveTransientFailures += 1;
          if (this._consecutiveTransientFailures >= this.config.circuitBreakerThreshold) {
            this._circuitOpenedAt = Date.now();
            throw new CircuitOpenError({ methodName });
          }
        }

        // Contract errors are never retried
        if (errorClass === "contract" || attempt >= strategy.maxAttempts) {
          break;
        }

        const delay =
          strategy.initialDelayMs * strategy.backoffMultiplier ** (attempt - 1) +
          (strategy.jitterMs ? Math.random() * strategy.jitterMs : 0);

        await sleep(delay);
      }
    }

    throw lastError;
  }
}
