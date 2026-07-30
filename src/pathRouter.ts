/**
 * DEX pathfinding router for cross-asset split payments.
 *
 * When payer and recipients use different Stellar assets, this module queries
 * Horizon's path-payment endpoints to find the best conversion route and
 * returns the optimal path for each split leg.
 *
 * Delegates query assembly, validation, and caching to {@link PathQueryBuilder}
 * to avoid redundant Horizon calls for identical source/destination pairs
 * within the cache TTL window.
 */

import { Asset, Horizon, Operation } from "@stellar/stellar-sdk";
import { PathNotFoundError, PathRouterError } from "./errors.js";
import { PathQueryBuilder } from "./pathQueryBuilder.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single hop in a DEX conversion path. */
export interface PathHop {
  /** Asset to send (or "native" for XLM). */
  sourceAsset: string;
  /** Asset to receive (or "native" for XLM). */
  destAsset: string;
  /** Source amount in the asset's base unit (stroops for XLM). */
  sourceAmount: bigint;
  /** Estimated destination amount in the asset's base unit. */
  destAmount: bigint;
}

/** The optimal conversion path between two assets. */
export interface PathResult {
  /** Ordered list of intermediate assets forming the conversion route. */
  path: Array<{ asset_code: string; asset_issuer: string; asset_type: string }>;
  /** Amount the destination will receive (in the destination asset's base unit). */
  destinationAmount: bigint;
  /** Amount sent from the source (in the source asset's base unit). */
  sourceAmount: bigint;
}

/** Parameters for pathfinding. */
export interface PathRequest {
  /** Asset the sender will supply. */
  sourceAsset: Asset;
  /** Amount the sender will supply (in the source asset's base unit). */
  sourceAmount: bigint;
  /** Asset the recipient should receive. */
  destinationAsset: Asset;
}

/** Configuration for {@link PathRouter}. */
export interface PathRouterConfig {
  /** Cache TTL in milliseconds. Default: 15_000 (15s). */
  ttlMs?: number;
  /** Maximum number of cached paths. Default: 5_000. */
  maxEntries?: number;
}

// ---------------------------------------------------------------------------
// PathRouter
// ---------------------------------------------------------------------------

/**
 * Finds the best DEX conversion path between two Stellar assets using
 * Horizon's strict-send / strict-receive pathfinding endpoints.
 *
 * Results are cached per (sourceAsset, destAsset, sourceAmount) triple to
 * avoid redundant Horizon queries within the TTL window.
 */
export class PathRouter {
  private readonly server: Horizon.Server;
  private readonly queryBuilder: PathQueryBuilder;

  /**
   * @param horizonUrl - Horizon server URL.
   * @param config     - Optional tuning parameters.
   */
  constructor(horizonUrl: string, config: PathRouterConfig = {}) {
    this.server = new Horizon.Server(horizonUrl);
    this.queryBuilder = new PathQueryBuilder(this.server, {
      ttlMs: config.ttlMs ?? 15_000,
      maxEntries: config.maxEntries ?? 5_000,
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Find the best path to send `sourceAmount` of `sourceAsset` and receive
   * as much of `destinationAsset` as possible.
   *
   * Uses `strictSendPaths` under the hood — the source amount is fixed and
   * the destination amount is estimated.
   */
  async findStrictSendPath(req: PathRequest): Promise<PathResult> {
    const sourceAssetType = assetType(req.sourceAsset);
    const destAssetType = assetType(req.destinationAsset);

    try {
      const query = this.queryBuilder.forStrictSend({
        sourceAsset: req.sourceAsset,
        sourceAmount: req.sourceAmount,
        destinationAssets: [req.destinationAsset],
      });
      const results = await this.queryBuilder.execute(query);

      if (results.length === 0) {
        throw new PathNotFoundError(sourceAssetType, destAssetType, req.sourceAmount);
      }

      // Results are sorted best-first (highest destination amount).
      const best = results[0]!;
      return { path: best.path, destinationAmount: best.destinationAmount, sourceAmount: best.sourceAmount };
    } catch (err) {
      if (err instanceof PathNotFoundError) throw err;
      throw new PathRouterError(
        `Failed to find strict-send path: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Find the best path to receive exactly `destAmount` of `destinationAsset`
   * while spending as little of `sourceAsset` as possible.
   *
   * Uses `strictReceivePaths` under the hood — the destination amount is
   * fixed and the source amount is estimated.
   */
  async findStrictReceivePath(
    sourceAsset: Asset,
    destAmount: bigint,
    destinationAsset: Asset,
  ): Promise<PathResult> {
    const sourceAssetType = assetType(sourceAsset);
    const destAssetType = assetType(destinationAsset);

    try {
      const query = this.queryBuilder.forStrictReceive({
        sourceAssets: [sourceAsset],
        destinationAsset,
        destinationAmount: destAmount,
      });
      const results = await this.queryBuilder.execute(query);

      if (results.length === 0) {
        throw new PathNotFoundError(sourceAssetType, destAssetType, destAmount);
      }

      // Results are sorted best-first (lowest source amount).
      const best = results[0]!;
      return { path: best.path, destinationAmount: best.destinationAmount, sourceAmount: best.sourceAmount };
    } catch (err) {
      if (err instanceof PathNotFoundError) throw err;
      throw new PathRouterError(
        `Failed to find strict-receive path: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  /**
   * Build a path-payment strict-send operation for a known path.
   */
  buildPathPaymentStrictSend(
    sendAsset: Asset,
    sendAmount: string,
    destination: string,
    destAsset: Asset,
    destMin: string,
    path: Asset[],
  ): ReturnType<typeof Operation.pathPaymentStrictSend> {
    return Operation.pathPaymentStrictSend({
      sendAsset,
      sendAmount,
      destination,
      destAsset,
      destMin,
      path,
    });
  }

  /**
   * Build a path-payment strict-receive operation for a known path.
   */
  buildPathPaymentStrictReceive(
    sendAsset: Asset,
    sendMax: string,
    destination: string,
    destAsset: Asset,
    destAmount: string,
    path: Asset[],
  ): ReturnType<typeof Operation.pathPaymentStrictReceive> {
    return Operation.pathPaymentStrictReceive({
      sendAsset,
      sendMax,
      destination,
      destAsset,
      destAmount,
      path,
    });
  }

  /**
   * Return the underlying Horizon server for other queries.
   */
  getServer(): Horizon.Server {
    return this.server;
  }

  /**
   * Clear all cached paths.
   */
  clearCache(): void {
    this.queryBuilder.clearCache();
  }
}

function assetType(asset: Asset): string {
  return asset.isNative() ? "native" : `${asset.getCode()}:${asset.getIssuer()}`;
}
