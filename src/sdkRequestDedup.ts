/** Issue #1297: Request deduplication with expiry and stats. */

export interface SdkDedupStats {
  hits: number;
  misses: number;
  expired: number;
  size: number;
}

export class SdkRequestDedup {
  private entries = new Map<string, { promise: Promise<unknown>; expiresAt: number }>();
  private hits = 0;
  private misses = 0;
  private expired = 0;

  constructor(private readonly ttlMs = 5000, private readonly now: () => number = Date.now) {}

  /** Run fn once per key within the TTL; concurrent/repeat callers share the result. */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const e = this.entries.get(key);
    if (e) {
      if (e.expiresAt > this.now()) {
        this.hits++;
        return e.promise as Promise<T>;
      }
      this.entries.delete(key);
      this.expired++;
    }
    this.misses++;
    const promise = fn();
    this.entries.set(key, { promise, expiresAt: this.now() + this.ttlMs });
    promise.catch(() => this.entries.delete(key));
    return promise;
  }

  stats(): SdkDedupStats {
    return { hits: this.hits, misses: this.misses, expired: this.expired, size: this.entries.size };
  }

  clear(): void {
    this.entries.clear();
  }
}
