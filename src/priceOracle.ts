/**
 * Default PriceOracleAdapter implementation backed by CoinGecko's public
 * `/simple/price` REST endpoint. Callers needing a different provider can
 * supply their own PriceOracleAdapter (see types.ts) instead.
 */

import { PriceOracleFetchError, RateLimitError } from "./errors.js";
import { RateCache } from "./rateCache.js";
import type { PriceOracleAdapter } from "./types.js";

/** Default asset-code -> CoinGecko coin-id mapping for common Stellar assets. */
const DEFAULT_COIN_IDS: Record<string, string> = {
  XLM: "stellar",
  USDC: "usd-coin",
};

export interface CoinGeckoPriceOracleOptions {
  /** Override the CoinGecko API base URL (e.g. for a proxy). Default: the public API. */
  apiBaseUrl?: string;
  /** Additional or overriding asset-code -> CoinGecko coin-id mappings. */
  coinIds?: Record<string, string>;
  /** Cache used to avoid redundant requests. Defaults to a private RateCache. */
  cache?: RateCache;
}

/**
 * Fetches fiat/asset conversion rates from CoinGecko's public price API,
 * caching results via {@link RateCache}.
 */
export class CoinGeckoPriceOracle implements PriceOracleAdapter {
  private readonly apiBaseUrl: string;
  private readonly coinIds: Record<string, string>;
  private readonly cache: RateCache;

  constructor(options: CoinGeckoPriceOracleOptions = {}) {
    this.apiBaseUrl = options.apiBaseUrl ?? "https://api.coingecko.com/api/v3";
    this.coinIds = { ...DEFAULT_COIN_IDS, ...options.coinIds };
    this.cache = options.cache ?? new RateCache();
  }

  /**
   * Resolve the price of one unit of `base` denominated in `quote`.
   * `base` may be any key in `coinIds` (defaults include "XLM", "USDC") or a
   * raw CoinGecko coin id; `quote` is a CoinGecko vs_currency code (e.g. "USD").
   */
  async getPrice(base: string, quote: string): Promise<number> {
    const cached = this.cache.get(base, quote);
    if (cached !== undefined) return cached;

    const coinId = this.coinIds[base.toUpperCase()] ?? base.toLowerCase();
    const vsCurrency = quote.toLowerCase();
    const url = `${this.apiBaseUrl}/simple/price?ids=${encodeURIComponent(coinId)}&vs_currencies=${encodeURIComponent(vsCurrency)}`;

    const response = await fetch(url);

    if (response.status === 429) {
      const retryAfterHeader = response.headers.get("retry-after");
      throw new RateLimitError(
        `CoinGecko rate limit exceeded fetching ${base}/${quote}`,
        retryAfterHeader ? Number(retryAfterHeader) : undefined,
      );
    }
    if (!response.ok) {
      throw new PriceOracleFetchError(
        `CoinGecko request failed with status ${response.status} fetching ${base}/${quote}`,
      );
    }

    const payload = (await response.json()) as Record<string, Record<string, number>>;
    const rate = payload?.[coinId]?.[vsCurrency];
    if (typeof rate !== "number") {
      throw new PriceOracleFetchError(`CoinGecko response missing rate for ${base}/${quote}`);
    }

    this.cache.set(base, quote, rate);
    return rate;
  }
}
