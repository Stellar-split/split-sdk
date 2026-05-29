export interface DegradedRead<T> {
  data: T;
  stale: boolean;
}

export type PendingResult<T> = Promise<T>;

export interface DegradationConfig {
  enabled: boolean;
}

interface PendingEntry {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class DegradationManager {
  private _cache = new Map<string, unknown>();
  private _queue: PendingEntry[] = [];
  private _draining = false;

  async wrapRead<T>(key: string, fn: () => Promise<T>): Promise<DegradedRead<T>> {
    try {
      const data = await fn();
      this._cache.set(key, data);
      return { data, stale: false };
    } catch {
      const cached = this._cache.get(key);
      if (cached !== undefined) {
        return { data: cached as T, stale: true };
      }
      throw new Error(`RPC unavailable and no cached data for key "${key}"`);
    }
  }

  wrapWrite<T>(fn: () => Promise<T>): PendingResult<T> {
    return new Promise<T>((resolve, reject) => {
      this._queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      void this._drain();
    });
  }

  private async _drain(): Promise<void> {
    if (this._draining) return;
    this._draining = true;
    while (this._queue.length > 0) {
      const entry = this._queue[0];
      if (!entry) break;
      try {
        const result = await entry.fn();
        this._queue.shift();
        entry.resolve(result);
      } catch {
        this._draining = false;
        setTimeout(() => void this._drain(), 5000);
        return;
      }
    }
    this._draining = false;
  }
}
