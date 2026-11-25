/**
 * SDK price oracle integration helpers.
 *
 * Provides a small, dependency-free abstraction for fetching and parsing
 * oracle prices, plus an event emitter for price updates.
 */

export interface OraclePrice {
  /** Asset symbol, e.g. "XLM" or "USDC". */
  symbol: string;
  /** Price expressed in the oracle's quote currency. */
  price: number;
  /** Unix timestamp (ms) when the price was observed. */
  timestamp: number;
}

/**
 * Minimal shape of a raw oracle response. Real oracles vary, so we accept a
 * permissive record and normalize it in {@link parseOraclePrice}.
 */
export type RawOracleResponse = Record<string, unknown>;

/**
 * Fetches a raw price payload for a symbol. Implementations may hit an HTTP
 * endpoint, a contract, or a cache.
 */
export type OracleFetcher = (symbol: string) => Promise<RawOracleResponse>;

export type PriceUpdateListener = (price: OraclePrice) => void;

/**
 * Parse a raw oracle response into a normalized {@link OraclePrice}.
 *
 * Accepts common field aliases (`price`/`value`/`amount`, `timestamp`/`time`)
 * and throws when a usable numeric price cannot be found.
 */
export function parseOraclePrice(
  symbol: string,
  raw: RawOracleResponse,
): OraclePrice {
  const rawPrice = raw.price ?? raw.value ?? raw.amount;
  const price = typeof rawPrice === "string" ? Number(rawPrice) : rawPrice;

  if (typeof price !== "number" || !Number.isFinite(price)) {
    throw new Error(`Invalid oracle price for ${symbol}`);
  }

  const rawTimestamp = raw.timestamp ?? raw.time ?? raw.updatedAt;
  const timestamp =
    typeof rawTimestamp === "number"
      ? rawTimestamp
      : typeof rawTimestamp === "string"
        ? Date.parse(rawTimestamp)
        : Date.now();

  return {
    symbol,
    price,
    timestamp: Number.isFinite(timestamp) ? timestamp : Date.now(),
  };
}

/**
 * A named oracle provider backed by a fetcher. Multiple providers can be
 * registered on a {@link PriceOracleClient} to enable aggregation and
 * fallback.
 */
export interface OracleProvider {
  /** Human-readable provider name, used for monitoring. */
  name: string;
  /** Fetches a raw price payload for a symbol. */
  fetcher: OracleFetcher;
}

/** Options controlling aggregation, validation, rate limiting, and monitoring. */
export interface PriceOracleOptions {
  /** Minimum number of valid provider prices required to aggregate. Default: 1. */
  minProviders?: number;
  /** Maximum acceptable deviation (fraction, e.g. 0.1 = 10%) from the median. */
  maxDeviation?: number;
  /** Reject prices older than this many ms. Default: 5 minutes. */
  maxAgeMs?: number;
  /** Minimum interval between fetches per symbol in ms. Default: 0 (disabled). */
  rateLimitMs?: number;
}

/** Per-provider monitoring statistics. */
export interface OracleProviderStats {
  name: string;
  successes: number;
  failures: number;
  lastError?: string;
  lastUpdated?: number;
}

export interface PriceOracleClientInstance {
  onPriceUpdate(listener: PriceUpdateListener): () => void;
  getCachedPrice(symbol: string): OraclePrice | undefined;
  getProviderStats(): OracleProviderStats[];
  fetchPrice(symbol: string): Promise<OraclePrice>;
  fetchPrices(symbols: string[]): Promise<OraclePrice[]>;
}

export interface PriceOracleConstructor {
  new (
    fetcherOrProviders: OracleFetcher | OracleProvider[],
    options?: PriceOracleOptions,
  ): PriceOracleClientInstance;
}

/**
 * Price oracle client that fetches, parses, aggregates, and emits price
 * updates across one or more providers.
 */
export class PriceOracleClient implements PriceOracleClientInstance {
  private readonly providers: OracleProvider[];
  private readonly options: Required<PriceOracleOptions>;
  private readonly listeners = new Set<PriceUpdateListener>();
  private readonly cache = new Map<string, OraclePrice>();
  private readonly lastFetch = new Map<string, number>();
  private readonly stats = new Map<string, OracleProviderStats>();

  constructor(
    fetcherOrProviders: OracleFetcher | OracleProvider[],
    options: PriceOracleOptions = {},
  ) {
    this.providers = Array.isArray(fetcherOrProviders)
      ? fetcherOrProviders
      : [{ name: "default", fetcher: fetcherOrProviders }];
    this.options = {
      minProviders: options.minProviders ?? 1,
      maxDeviation: options.maxDeviation ?? 0.1,
      maxAgeMs: options.maxAgeMs ?? 5 * 60 * 1000,
      rateLimitMs: options.rateLimitMs ?? 0,
    };
    for (const provider of this.providers) {
      this.stats.set(provider.name, {
        name: provider.name,
        successes: 0,
        failures: 0,
      });
    }
  }

  /** Subscribe to price updates. Returns an unsubscribe function. */
  onPriceUpdate(listener: PriceUpdateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Return the last cached price for a symbol, if any. */
  getCachedPrice(symbol: string): OraclePrice | undefined {
    return this.cache.get(symbol);
  }

  /** Return monitoring statistics for each registered provider. */
  getProviderStats(): OracleProviderStats[] {
    return Array.from(this.stats.values()).map((s) => ({ ...s }));
  }

  /**
   * Fetch and parse the current price for a symbol across all providers,
   * aggregating valid results, caching the outcome, and notifying listeners.
   */
  async fetchPrice(symbol: string): Promise<OraclePrice> {
    const now = Date.now();
    const last = this.lastFetch.get(symbol);
    if (
      this.options.rateLimitMs > 0 &&
      last !== undefined &&
      now - last < this.options.rateLimitMs
    ) {
      const cached = this.cache.get(symbol);
      if (cached) return cached;
    }
    this.lastFetch.set(symbol, now);

    const results = await Promise.all(
      this.providers.map((provider) => this.fetchFromProvider(provider, symbol)),
    );

    const valid = results.filter(
      (price): price is OraclePrice => price !== undefined,
    );

    if (valid.length < this.options.minProviders) {
      const cached = this.cache.get(symbol);
      if (cached) return cached;
      throw new Error(
        `Insufficient valid oracle prices for ${symbol} (${valid.length}/${this.options.minProviders})`,
      );
    }

    const price = this.aggregate(symbol, valid);
    this.cache.set(symbol, price);
    this.emit(price);
    return price;
  }

  /** Fetch prices for multiple symbols, preserving input order. */
  async fetchPrices(symbols: string[]): Promise<OraclePrice[]> {
    return Promise.all(symbols.map((symbol) => this.fetchPrice(symbol)));
  }

  private async fetchFromProvider(
    provider: OracleProvider,
    symbol: string,
  ): Promise<OraclePrice | undefined> {
    const stats = this.stats.get(provider.name);
    try {
      const raw = await provider.fetcher(symbol);
      const price = parseOraclePrice(symbol, raw);
      if (!this.isValid(price)) {
        throw new Error(`Price validation failed for ${symbol}`);
      }
      if (stats) {
        stats.successes += 1;
        stats.lastUpdated = price.timestamp;
      }
      return price;
    } catch (error) {
      if (stats) {
        stats.failures += 1;
        stats.lastError = error instanceof Error ? error.message : String(error);
      }
      return undefined;
    }
  }

  /** Validate a single price: positive, finite, and not stale. */
  private isValid(price: OraclePrice): boolean {
    if (!Number.isFinite(price.price) || price.price <= 0) return false;
    if (Date.now() - price.timestamp > this.options.maxAgeMs) return false;
    return true;
  }

  /**
   * Aggregate valid prices using the median, discarding outliers that deviate
   * beyond `maxDeviation` from the median.
   */
  private aggregate(symbol: string, prices: OraclePrice[]): OraclePrice {
    const sorted = [...prices].sort((a, b) => a.price - b.price);
    const mid = Math.floor(sorted.length / 2);
    const median =
      sorted.length % 2 === 0
        ? (sorted[mid - 1].price + sorted[mid].price) / 2
        : sorted[mid].price;

    const inliers = sorted.filter(
      (p) => Math.abs(p.price - median) / median <= this.options.maxDeviation,
    );
    const chosen = inliers.length > 0 ? inliers : sorted;
    const avg = chosen.reduce((sum, p) => sum + p.price, 0) / chosen.length;
    const timestamp = Math.max(...chosen.map((p) => p.timestamp));

    return { symbol, price: avg, timestamp };
  }

  private emit(price: OraclePrice): void {
    for (const listener of this.listeners) {
      listener(price);
    }
  }
}

/** Value constructor for price oracle client helpers. */
export const PriceOracle: PriceOracleConstructor = PriceOracleClient;

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

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { OraclePriceError, NoReturnValueError } from "./errors.js";

/** Resolves a conversion rate between two on-chain assets. */
export interface PriceOracle {
  /**
   * Fixed-point rate (1e18 = 1.0) to convert 1 unit of `fromAsset` into
   * `toAsset`, or `undefined` when no price is available for that pair.
   */
  getRate(fromAsset: string, toAsset: string): Promise<bigint | undefined>;
}

/** Soroban contract-backed price oracle. */
export class ContractPriceOracle implements PriceOracle {
  constructor(
    private readonly server: SorobanRpc.Server,
    private readonly oracleAddress: string,
    private readonly networkPassphrase: string
  ) {}

  async getRate(fromAsset: string, toAsset: string): Promise<bigint | undefined> {
    const contract = new Contract(this.oracleAddress);
    const operation = contract.call(
      "get_price",
      nativeToScVal(fromAsset, { type: "symbol" }),
      nativeToScVal(toAsset, { type: "symbol" })
    );

    const sourceAccount = {
      accountId: () => this.oracleAddress,
      sequenceNumber: () => "0",
      incrementSequenceNumber: () => {},
    } as any;

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const result = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(result)) {
      throw new OraclePriceError(`Oracle simulation failed: ${result.error}`);
    }

    const returnValue = (result as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnValue) throw new NoReturnValueError("oracle get_price");
    return BigInt(scValToNative(returnValue));
  }
}
