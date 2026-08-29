export interface RateLimiterConfig {
  maxRequestsPerSecond: number;
  perKeyLimit?: number;
}

interface PendingAcquire {
  key?: string;
  resolve: () => void;
}

export class RateLimiter {
  private _tokens: number;
  private _maxTokens: number;
  private _perKeyLimit?: number;
  private _refillIntervalMs: number;
  private _lastRefillTime: number;
  private _queue: PendingAcquire[] = [];
  private _processing = false;
  private _perKeyCounts = new Map<string, number>();

  constructor(config: RateLimiterConfig) {
    this._maxTokens = config.maxRequestsPerSecond;
    this._perKeyLimit = config.perKeyLimit;
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
      this._perKeyCounts.clear();
    }
  }

  acquire(key?: string): Promise<void> {
    this._refill();
    if (this._canAcquire(key)) {
      this._consumeToken(key);
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._queue.push({ key, resolve });
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
      let index = 0;
      while (this._tokens > 0 && index < this._queue.length) {
        const next = this._queue[index];
        if (!next) {
          index++;
          continue;
        }
        if (this._canAcquire(next.key)) {
          this._queue.splice(index, 1);
          this._consumeToken(next.key);
          next.resolve();
          continue;
        }
        index++;
      }
      if (this._queue.length > 0) {
        this._processQueue();
      } else {
        this._processing = false;
      }
    }, msUntilRefill);
  }

  private _canAcquire(key?: string): boolean {
    if (this._tokens <= 0) {
      return false;
    }

    if (!key || this._perKeyLimit === undefined) {
      return true;
    }

    return (this._perKeyCounts.get(key) ?? 0) < this._perKeyLimit;
  }

  private _consumeToken(key?: string): void {
    this._tokens--;
    if (!key || this._perKeyLimit === undefined) {
      return;
    }

    this._perKeyCounts.set(key, (this._perKeyCounts.get(key) ?? 0) + 1);
  }
}
