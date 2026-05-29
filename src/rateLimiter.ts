export interface RateLimiterConfig {
  maxRequestsPerSecond: number;
}

export class RateLimiter {
  private _tokens: number;
  private _maxTokens: number;
  private _refillIntervalMs: number;
  private _lastRefillTime: number;
  private _queue: Array<() => void> = [];
  private _processing = false;

  constructor(config: RateLimiterConfig) {
    this._maxTokens = config.maxRequestsPerSecond;
    this._tokens = this._maxTokens;
    this._refillIntervalMs = 1000;
    this._lastRefillTime = Date.now();
  }

  private _refill(): void {
    const now = Date.now();
    const elapsed = now - this._lastRefillTime;
    if (elapsed >= this._refillIntervalMs) {
      const periods = Math.floor(elapsed / this._refillIntervalMs);
      this._tokens = Math.min(
        this._maxTokens,
        this._tokens + periods * this._maxTokens
      );
      this._lastRefillTime += periods * this._refillIntervalMs;
    }
  }

  acquire(): Promise<void> {
    this._refill();
    if (this._tokens > 0) {
      this._tokens--;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._queue.push(resolve);
      if (!this._processing) {
        this._processQueue();
      }
    });
  }

  private _processQueue(): void {
    this._processing = true;
    const msUntilRefill = Math.max(
      0,
      this._refillIntervalMs - (Date.now() - this._lastRefillTime)
    );
    setTimeout(() => {
      this._refill();
      while (this._tokens > 0 && this._queue.length > 0) {
        const next = this._queue.shift();
        if (next) {
          this._tokens--;
          next();
        }
      }
      if (this._queue.length > 0) {
        this._processQueue();
      } else {
        this._processing = false;
      }
    }, msUntilRefill);
  }
}
