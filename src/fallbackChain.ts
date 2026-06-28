import { StellarSplitError } from "./errors.js";

export interface FallbackAttemptLog {
  url: string;
  error: string;
  attemptMs: number;
}

export class FallbackExhaustedError extends StellarSplitError {
  public readonly attempts: FallbackAttemptLog[];

  constructor(attempts: FallbackAttemptLog[]) {
    super(`Fallback chain exhausted after ${attempts.length} attempts.`);
    this.attempts = attempts;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export type FallbackFailureLogger = (attempt: FallbackAttemptLog) => void;

export class FallbackChain {
  private readonly urls: string[];
  private readonly logger: FallbackFailureLogger;

  constructor(urls: string[], options?: { logger?: FallbackFailureLogger }) {
    if (!Array.isArray(urls) || urls.length === 0) {
      throw new FallbackExhaustedError([{ url: "", error: "No URLs provided", attemptMs: 0 }]);
    }

    this.urls = [...urls];
    this.logger = options?.logger ?? ((attempt) => console.error("RPC fallback attempt failed:", attempt));
  }

  public async execute<T>(operation: (url: string) => Promise<T>): Promise<T> {
    const attempts: FallbackAttemptLog[] = [];

    for (const url of this.urls) {
      const start = Date.now();

      try {
        return await operation(url);
      } catch (error) {
        const attemptMs = Date.now() - start;
        const attempt: FallbackAttemptLog = {
          url,
          error: error instanceof Error ? error.message : String(error),
          attemptMs,
        };

        attempts.push(attempt);
        this.logger(attempt);
      }
    }

    throw new FallbackExhaustedError(attempts);
  }
}
