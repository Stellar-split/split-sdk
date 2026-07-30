/**
 * Exchange Rate Cache — a time-to-live cache for exchange rates fetched from
 * external oracles, so that repeated conversions within a single rendering
 * session don't re-fetch a rate that hasn't gone stale yet.
 *
 * Supports background refresh: entries are pre-warmed at `ttlMs * 0.8` so a
 * cache read never pays cold-fetch latency right after expiry.
 */

/** A single cached rate entry. */
export interface RateCacheEntry<TRate> {
  rate: TRate;
  fetchedAt: number;
}

/** A function that fetches the current exchange rate for a `from -> to` asset pair. */
export type RateOracleFn<TRate> = (from: string, to: string) => Promise<TRate>;

/** Configuration for {@link RateCache}. */
export interface RateCacheConfig {
  /** Time-to-live for a cached rate, in milliseconds. Default: 60_000 (60s). */
  ttlMs?: number;
}

const DEFAULT_TTL_MS = 60_000;

function cacheKey(from: string, to: string): string {
  return `${from}:${to}`;
}

/**
 * TTL-based cache for exchange rates, keyed by `"${fromAsset}:${toAsset}"`.
 *
 * ```ts
 * const cache = new RateCache((from, to) => oracle.getPrice(from, to));
 * const rate = await cache.getRate("USDC", "USD");
 * cache.start(); // pre-warm entries in the background before they expire
 * ```
 */
export class RateCache<TRate = number> {
  private readonly store = new Map<string, RateCacheEntry<TRate>>();
  private readonly oracle: RateOracleFn<TRate>;
  private readonly ttlMs: number;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  constructor(oracle: RateOracleFn<TRate>, config: RateCacheConfig = {}) {
    this.oracle = oracle;
    this.ttlMs = config.ttlMs ?? DEFAULT_TTL_MS;
  }

  /** Whether background refresh is currently running. */
  get running(): boolean {
    return this._running;
  }

  /**
   * Get the exchange rate for `from -> to`, serving from cache when the
   * entry is younger than `ttlMs`. On a cache miss (or expired entry), calls
   * the configured oracle function and stores the result with a timestamp.
   */
  async getRate(from: string, to: string): Promise<TRate> {
    const key = cacheKey(from, to);
    const entry = this.store.get(key);
    if (entry && Date.now() - entry.fetchedAt < this.ttlMs) {
      return entry.rate;
    }

    const rate = await this.oracle(from, to);
    this.store.set(key, { rate, fetchedAt: Date.now() });
    return rate;
  }

  /** Remove a single `from -> to` pair from the cache. */
  invalidate(from: string, to: string): void {
    this.store.delete(cacheKey(from, to));
  }

  /** Clear the entire cache. */
  invalidateAll(): void {
    this.store.clear();
  }

  /**
   * Start background refresh. Every `ttlMs * 0.8`, every currently cached
   * pair is re-fetched from the oracle and its entry updated, so a read
   * never has to pay cold-fetch latency right after expiry.
   */
  start(): void {
    if (this._running) return;
    this._running = true;
    this.refreshTimer = setInterval(() => {
      void this.refreshAll();
    }, this.ttlMs * 0.8);
  }

  /** Stop background refresh. Cached entries are preserved. */
  stop(): void {
    this._running = false;
    if (this.refreshTimer !== null) {
      clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  private async refreshAll(): Promise<void> {
    for (const key of Array.from(this.store.keys())) {
      const [from, to] = key.split(":");
      if (from === undefined || to === undefined) continue;
      try {
        const rate = await this.oracle(from, to);
        this.store.set(key, { rate, fetchedAt: Date.now() });
      } catch {
        // Best-effort background refresh; keep the stale entry until the next attempt.
      }
    }
  }
}
