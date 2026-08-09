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
import { OrderBookSampler, type FillEstimate } from "./orderBookSampler.js";

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

/** Payload emitted with a `highSlippageWarning` event. */
export interface HighSlippageWarning {
  /** The asset pair being traded. */
  baseAsset: string;
  counterAsset: string;
  /** Computed slippage percentage. */
  slippagePercent: number;
  /** Configured tolerance that was exceeded. */
  slippageTolerancePercent: number;
  /** The full fill estimate that triggered the warning. */
  fillEstimate: FillEstimate;
}

/** Configuration for {@link PathRouter}. */
export interface PathRouterConfig {
  /** Cache TTL in milliseconds. Default: 15_000 (15s). */
  ttlMs?: number;
  /** Maximum number of cached paths. Default: 5_000. */
  maxEntries?: number;
  /**
   * Slippage tolerance percentage. When the order-book sampler reports a
   * slippage above this value a `highSlippageWarning` callback is invoked.
   * Default: 1 (%).
   */
  slippageTolerancePercent?: number;
  /**
   * Optional callback invoked when estimated slippage exceeds the tolerance.
   * Wire this up to the application's event bus or logger as needed.
   */
  onHighSlippage?: (warning: HighSlippageWarning) => void;
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
 *
 * Since Issue #543: calls {@link OrderBookSampler.sample} before selecting a
 * DEX path and fires `onHighSlippage` when slippage exceeds the tolerance.
 */
export class PathRouter {
  private readonly server: Horizon.Server;
  private readonly queryBuilder: PathQueryBuilder;
  private readonly slippageTolerancePercent: number;
  private readonly onHighSlippage: ((warning: HighSlippageWarning) => void) | undefined;
  private readonly sampler: OrderBookSampler;

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
    this.slippageTolerancePercent = config.slippageTolerancePercent ?? 1;
    this.onHighSlippage = config.onHighSlippage;
    this.sampler = new OrderBookSampler({
      horizonUrl,
      slippageTolerancePercent: this.slippageTolerancePercent,
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
   *
   * Before selecting the path, samples the order book for liquidity depth and
   * emits a `highSlippageWarning` when slippage exceeds the configured tolerance.
   */
  async findStrictSendPath(req: PathRequest): Promise<PathResult> {
    const sourceAssetType = assetType(req.sourceAsset);
    const destAssetType = assetType(req.destinationAsset);

    // Sample order book for slippage before path query
    try {
      const estimate = await this.sampler.sample(
        req.sourceAsset,
        req.destinationAsset,
        "sell",
        req.sourceAmount,
      );
      if (estimate.slippagePercent > this.slippageTolerancePercent && this.onHighSlippage) {
        this.onHighSlippage({
          baseAsset: sourceAssetType,
          counterAsset: destAssetType,
          slippagePercent: estimate.slippagePercent,
          slippageTolerancePercent: this.slippageTolerancePercent,
          fillEstimate: estimate,
        });
      }
    } catch {
      // Slippage check is best-effort; don't block path finding on sampler errors
    }

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
   * Expose the underlying {@link OrderBookSampler} for direct depth queries.
   */
  getOrderBookSampler(): OrderBookSampler {
    return this.sampler;
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
