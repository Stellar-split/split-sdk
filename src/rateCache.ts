/**
 * Minimal TTL cache for price oracle rates, keyed by base/quote pair.
 *
 * Used by PriceOracleAdapter implementations (see priceOracle.ts) to avoid
 * redundant upstream requests within the configured TTL window.
 */

export interface RateCacheConfig {
  /** Time-to-live for cached rates, in milliseconds. Default: 30_000 (30s). */
  ttlMs?: number;
}

interface RateEntry {
  rate: number;
  expiresAt: number;
}

export class RateCache {
  private readonly store = new Map<string, RateEntry>();
  private readonly ttlMs: number;

  constructor(config: RateCacheConfig = {}) {
    this.ttlMs = config.ttlMs ?? 30_000;
  }

  /** The cached rate for `base`/`quote`, or undefined if absent or expired. */
  get(base: string, quote: string): number | undefined {
    const key = this.key(base, quote);
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.rate;
  }

  /** Cache `rate` for `base`/`quote`, expiring after this cache's TTL. */
  set(base: string, quote: string, rate: number): void {
    this.store.set(this.key(base, quote), { rate, expiresAt: Date.now() + this.ttlMs });
  }

  /** Remove all cached rates. */
  clear(): void {
    this.store.clear();
  }

  private key(base: string, quote: string): string {
    return `${base.toUpperCase()}:${quote.toUpperCase()}`;
  }
}
