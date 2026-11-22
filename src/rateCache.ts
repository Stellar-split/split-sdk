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
  /** Maximum number of cached pairs retained before the oldest entry is evicted. */
  maxSize?: number;
}

/** Snapshot of {@link RateCache} usage statistics. */
export interface RateCacheStats {
  /** Number of cache reads that returned a live (non-expired) entry. */
  hits: number;
  /** Number of cache reads that found no entry or an expired entry. */
  misses: number;
  /** Number of times the oracle function was invoked (foreground + background). */
  oracleFetches: number;
  /** Number of entries evicted due to the `maxSize` limit. */
  evictions: number;
  /** Number of entries removed because they were found expired on read. */
  expirations: number;
  /** Current number of cached asset pairs. */
  size: number;
}

const DEFAULT_TTL_MS = 60_000;
const DEFAULT_MAX_SIZE = Number.POSITIVE_INFINITY;

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
  private readonly oracle?: RateOracleFn<TRate>;
  private readonly ttlMs: number;
  private readonly maxSize: number;
  private refreshTimer: ReturnType<typeof setInterval> | null = null;
  private _running = false;
  private _hits = 0;
  private _misses = 0;
  private _oracleFetches = 0;
  private _evictions = 0;
  private _expirations = 0;

  constructor(
    oracleOrConfig?: RateOracleFn<TRate> | RateCacheConfig,
    config?: RateCacheConfig,
  ) {
    if (typeof oracleOrConfig === "function") {
      this.oracle = oracleOrConfig;
      this.ttlMs = config?.ttlMs ?? DEFAULT_TTL_MS;
      this.maxSize = config?.maxSize ?? DEFAULT_MAX_SIZE;
    } else {
      this.oracle = undefined;
      const cfg = oracleOrConfig ?? config ?? {};
      this.ttlMs = cfg.ttlMs ?? DEFAULT_TTL_MS;
      this.maxSize = cfg.maxSize ?? DEFAULT_MAX_SIZE;
    }
  }

  /** Whether background refresh is currently running. */
  get running(): boolean {
    return this._running;
  }

  /** Current number of cached asset pairs. */
  get size(): number {
    return this.store.size;
  }

  /** The cached rate for `from`/`to`, or undefined if absent or expired. */
  get(from: string, to: string): TRate | undefined {
    const key = cacheKey(from, to);
    const entry = this.store.get(key);
    if (!entry) {
      this._misses++;
      return undefined;
    }
    if (Date.now() - entry.fetchedAt > this.ttlMs) {
      this.store.delete(key);
      this._expirations++;
      this._misses++;
      return undefined;
    }
    this._hits++;
    return entry.rate;
  }

  /** Cache `rate` for `from`/`to`, expiring after this cache's TTL. */
  set(from: string, to: string, rate: TRate): void {
    const key = cacheKey(from, to);
    this.store.set(key, { rate, fetchedAt: Date.now() });
    this.evictOverflow();
  }

  /**
   * Get the exchange rate for `from -> to`, serving from cache when the
   * entry is younger than `ttlMs`. On a cache miss (or expired entry), calls
   * the configured oracle function and stores the result with a timestamp.
   */
  async getRate(from: string, to: string): Promise<TRate> {
    const cached = this.get(from, to);
    if (cached !== undefined) {
      return cached;
    }

    if (!this.oracle) {
      throw new Error(`No oracle function configured in RateCache for ${from}:${to}`);
    }

    this._oracleFetches++;
    const rate = await this.oracle(from, to);
    this.set(from, to, rate);
    return rate;
  }

  /** Snapshot of cache usage statistics. */
  getStats(): RateCacheStats {
    return {
      hits: this._hits,
      misses: this._misses,
      oracleFetches: this._oracleFetches,
      evictions: this._evictions,
      expirations: this._expirations,
      size: this.store.size,
    };
  }

  /** Reset all tracked statistics to zero. Cached entries are preserved. */
  resetStats(): void {
    this._hits = 0;
    this._misses = 0;
    this._oracleFetches = 0;
    this._evictions = 0;
    this._expirations = 0;
  }

  /** Remove a single `from -> to` pair from the cache. */
  invalidate(from: string, to: string): void {
    this.store.delete(cacheKey(from, to));
  }

  /** Clear the entire cache. */
  invalidateAll(): void {
    this.store.clear();
  }

  /** Remove all cached rates. Alias for invalidateAll. */
  clear(): void {
    this.invalidateAll();
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
    if (!this.oracle) return;
    for (const key of Array.from(this.store.keys())) {
      const [from, to] = key.split(":");
      if (from === undefined || to === undefined) continue;
      try {
        this._oracleFetches++;
        const rate = await this.oracle(from, to);
        this.store.set(key, { rate, fetchedAt: Date.now() });
        this.evictOverflow();
      } catch {
        // Best-effort background refresh; keep the stale entry until the next attempt.
      }
    }
  }

  private evictOverflow(): void {
    if (this.maxSize === Number.POSITIVE_INFINITY) {
      return;
    }

    while (this.store.size > this.maxSize) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey === undefined) {
        break;
      }
      this.store.delete(oldestKey);
      this._evictions++;
    }
  }
}
