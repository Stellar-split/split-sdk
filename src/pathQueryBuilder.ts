/**
 * Builds and executes Horizon strict-send / strict-receive path queries.
 *
 * Encapsulates query assembly and validation so callers (and tests) can work
 * with path queries independently of any particular routing strategy.
 * {@link PathRouter} (pathRouter.ts) uses this builder internally.
 */

import { Asset, Horizon } from "@stellar/stellar-sdk";
import { SimpleCache } from "./cache.js";
import { InvalidPathQueryError } from "./errors.js";
import { isValidStellarAddress } from "./utils.js";
import type { PathQuery, PathQueryResult } from "./types.js";

/** Parameters for {@link PathQueryBuilder.forStrictSend}. */
export interface StrictSendQueryParams {
  /** Asset the sender will supply. */
  sourceAsset: Asset;
  /** Amount the sender will supply, in the source asset's base unit. */
  sourceAmount: bigint;
  /** A specific destination account to query reachable assets for. */
  destinationAccount?: string;
  /** A fixed list of acceptable destination assets. */
  destinationAssets?: Asset[];
}

/** Parameters for {@link PathQueryBuilder.forStrictReceive}. */
export interface StrictReceiveQueryParams {
  /** Asset the recipient should receive. */
  destinationAsset: Asset;
  /** Amount the recipient should receive, in the destination asset's base unit. */
  destinationAmount: bigint;
  /** A specific source account to query spendable assets for. */
  sourceAccount?: string;
  /** A fixed list of acceptable source assets. */
  sourceAssets?: Asset[];
}

/** Configuration for {@link PathQueryBuilder}. */
export interface PathQueryBuilderConfig {
  /** Cache TTL in milliseconds. Default: 10_000 (10s). */
  ttlMs?: number;
  /** Maximum number of cached query results. Default: 5_000. */
  maxEntries?: number;
}

export interface PathQueryStringOptions {
  sourceAssetType?: "native" | "credit_alphanum4" | "credit_alphanum12";
  [key: string]: string | number | boolean | undefined;
}

export function buildPathQuery(options: PathQueryStringOptions): string {
  if (
    options.sourceAssetType !== undefined &&
    !["native", "credit_alphanum4", "credit_alphanum12"].includes(options.sourceAssetType)
  ) {
    throw new InvalidPathQueryError(`Invalid source asset type: ${options.sourceAssetType}`);
  }

  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(options)) {
    if (value === undefined) {
      continue;
    }

    if (key === "sourceAssetType") {
      params.append("source_asset_type", String(value));
      continue;
    }

    params.append(key, String(value));
  }

  return params.toString();
}

/**
 * Assembles validated `PathQuery` objects and executes them against Horizon,
 * caching results by query parameters within a configurable TTL.
 */
export class PathQueryBuilder {
  private readonly server: Horizon.Server;
  private readonly cache: SimpleCache<PathQueryResult[]>;

  constructor(server: Horizon.Server, config: PathQueryBuilderConfig = {}) {
    this.server = server;
    this.cache = new SimpleCache<PathQueryResult[]>({
      enabled: true,
      ttlMs: config.ttlMs ?? 10_000,
      maxEntries: config.maxEntries ?? 5_000,
    });
  }

  /**
   * Build a strict-send query: `sourceAmount` is fixed, the destination
   * amount is estimated. Requires either `destinationAccount` or a non-empty
   * `destinationAssets` list.
   */
  forStrictSend(params: StrictSendQueryParams): PathQuery {
    if (!(params.sourceAmount > 0n)) {
      throw new InvalidPathQueryError("sourceAmount must be greater than 0", {
        sourceAmount: params.sourceAmount.toString(),
      });
    }
    if (params.destinationAccount === undefined && (!params.destinationAssets || params.destinationAssets.length === 0)) {
      throw new InvalidPathQueryError("Either destinationAccount or destinationAssets is required");
    }
    if (params.destinationAccount !== undefined && !isValidStellarAddress(params.destinationAccount)) {
      throw new InvalidPathQueryError(`Invalid destination account: ${params.destinationAccount}`, {
        destinationAccount: params.destinationAccount,
      });
    }

    return {
      kind: "strictSend",
      sourceAsset: params.sourceAsset,
      sourceAmount: params.sourceAmount,
      destination: params.destinationAccount ?? params.destinationAssets!,
    };
  }

  /**
   * Build a strict-receive query: `destinationAmount` is fixed, the source
   * amount is estimated. Requires either `sourceAccount` or a non-empty
   * `sourceAssets` list.
   */
  forStrictReceive(params: StrictReceiveQueryParams): PathQuery {
    if (!(params.destinationAmount > 0n)) {
      throw new InvalidPathQueryError("destinationAmount must be greater than 0", {
        destinationAmount: params.destinationAmount.toString(),
      });
    }
    if (params.sourceAccount === undefined && (!params.sourceAssets || params.sourceAssets.length === 0)) {
      throw new InvalidPathQueryError("Either sourceAccount or sourceAssets is required");
    }
    if (params.sourceAccount !== undefined && !isValidStellarAddress(params.sourceAccount)) {
      throw new InvalidPathQueryError(`Invalid source account: ${params.sourceAccount}`, {
        sourceAccount: params.sourceAccount,
      });
    }

    return {
      kind: "strictReceive",
      source: params.sourceAccount ?? params.sourceAssets!,
      destinationAsset: params.destinationAsset,
      destinationAmount: params.destinationAmount,
    };
  }

  /**
   * Submit `query` to Horizon and return every matching path, sorted by
   * best rate (highest destination amount for strict-send, lowest source
   * amount for strict-receive). Cached by query parameters within the TTL.
   */
  async execute(query: PathQuery): Promise<PathQueryResult[]> {
    const cacheKey = this.cacheKey(query);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    const records =
      query.kind === "strictSend"
        ? await this.server.strictSendPaths(query.sourceAsset, query.sourceAmount.toString(), query.destination).call()
        : await this.server.strictReceivePaths(query.source, query.destinationAsset, query.destinationAmount.toString()).call();

    const results: PathQueryResult[] = records.records.map((record) => ({
      path: record.path,
      sourceAmount: BigInt(record.source_amount),
      destinationAmount: BigInt(record.destination_amount),
    }));

    results.sort((a, b) => {
      if (query.kind === "strictSend") {
        return a.destinationAmount === b.destinationAmount ? 0 : a.destinationAmount > b.destinationAmount ? -1 : 1;
      }
      return a.sourceAmount === b.sourceAmount ? 0 : a.sourceAmount < b.sourceAmount ? -1 : 1;
    });

    this.cache.set(cacheKey, results);
    return results;
  }

  /** Clear all cached query results. */
  clearCache(): void {
    this.cache.clear();
  }

  private cacheKey(query: PathQuery): string {
    if (query.kind === "strictSend") {
      const dest = Array.isArray(query.destination)
        ? query.destination.map(assetKey).join(",")
        : query.destination;
      return `strictSend:${assetKey(query.sourceAsset)}:${query.sourceAmount}:${dest}`;
    }
    const src = Array.isArray(query.source) ? query.source.map(assetKey).join(",") : query.source;
    return `strictReceive:${src}:${assetKey(query.destinationAsset)}:${query.destinationAmount}`;
  }
}

function assetKey(asset: Asset): string {
  return asset.isNative() ? "native" : `${asset.getCode()}:${asset.getIssuer()}`;
}
