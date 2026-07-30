/**
 * DEX pathfinding router for cross-asset split payments.
 *
 * When payer and recipients use different Stellar assets, this module queries
 * Horizon's path-payment endpoints to find the best conversion route and
 * returns the optimal path for each split leg.
 *
 * Integrates with {@link SimpleCache} to avoid redundant Horizon calls for
 * identical source/destination pairs within the cache TTL window.
 *
 * Since Issue #543: calls {@link OrderBookSampler.sample} before selecting a
 * DEX path and emits a `highSlippageWarning` event when the estimated
 * slippage exceeds `slippageTolerancePercent`.
 */

import { Asset, Horizon, Operation } from "@stellar/stellar-sdk";
import { SimpleCache } from "./cache.js";
import { PathNotFoundError, PathRouterError } from "./errors.js";
import { OrderBookSampler } from "./orderBookSampler.js";
import type { FillEstimate } from "./orderBookSampler.js";

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
  private readonly cache: SimpleCache<PathResult>;
  private readonly sampler: OrderBookSampler;
  private readonly slippageTolerancePercent: number;
  private readonly onHighSlippage?: (warning: HighSlippageWarning) => void;

  /**
   * @param horizonUrl - Horizon server URL.
   * @param config     - Optional tuning parameters.
   */
  constructor(horizonUrl: string, config: PathRouterConfig = {}) {
    this.server = new Horizon.Server(horizonUrl);
    this.cache = new SimpleCache<PathResult>({
      enabled: true,
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
    // Sample order book depth first — fire warning if slippage is too high
    await this.checkSlippage(req.sourceAsset, req.destinationAsset, "buy", req.sourceAmount);

    const cacheKey = this.cacheKey("send", req);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const sourceAssetType = req.sourceAsset.isNative()
        ? "native"
        : `${req.sourceAsset.getCode()}:${req.sourceAsset.getIssuer()}`;
      const destAssetType = req.destinationAsset.isNative()
        ? "native"
        : `${req.destinationAsset.getCode()}:${req.destinationAsset.getIssuer()}`;

      const records = await this.server
        .strictSendPaths(
          req.sourceAsset,
          req.sourceAmount.toString(),
          [req.destinationAsset],
        )
        .call();

      if (records.records.length === 0) {
        throw new PathNotFoundError(
          sourceAssetType,
          destAssetType,
          req.sourceAmount,
        );
      }

      // First record is the best path (highest destination amount)
      const best = records.records[0]!;

      const result: PathResult = {
        path: best.path,
        destinationAmount: BigInt(best.destination_amount),
        sourceAmount: BigInt(best.source_amount),
      };

      this.cache.set(cacheKey, result);
      return result;
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
    const cacheKey = this.cacheKeyReceive(sourceAsset, destAmount, destinationAsset);
    const cached = this.cache.get(cacheKey);
    if (cached) return cached;

    try {
      const sourceAssetType = sourceAsset.isNative()
        ? "native"
        : `${sourceAsset.getCode()}:${sourceAsset.getIssuer()}`;
      const destAssetType = destinationAsset.isNative()
        ? "native"
        : `${destinationAsset.getCode()}:${destinationAsset.getIssuer()}`;

      const srcStr = sourceAsset.isNative()
        ? "native"
        : `${sourceAsset.getCode()}:${sourceAsset.getIssuer()}`;
      const dstStr = destinationAsset.isNative()
        ? "native"
        : `${destinationAsset.getCode()}:${destinationAsset.getIssuer()}`;

      const records = await this.server
        .strictReceivePaths(
          srcStr,
          destinationAsset,
          destAmount.toString(),
        )
        .call();

      if (records.records.length === 0) {
        throw new PathNotFoundError(
          sourceAssetType,
          destAssetType,
          destAmount,
        );
      }

      const best = records.records[0]!;

      const result: PathResult = {
        path: best.path,
        destinationAmount: BigInt(best.destination_amount),
        sourceAmount: BigInt(best.source_amount),
      };

      this.cache.set(cacheKey, result);
      return result;
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
    this.cache.clear();
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Sample the order book and fire `onHighSlippage` when slippage exceeds the
   * configured tolerance.  Errors from the sampler are caught and silently
   * ignored so that path routing continues even when the order-book query
   * fails (e.g. network partition).
   */
  private async checkSlippage(
    baseAsset: Asset,
    counterAsset: Asset,
    side: "buy" | "sell",
    amount: bigint,
  ): Promise<void> {
    if (!this.onHighSlippage) return;
    try {
      const estimate = await this.sampler.sample(baseAsset, counterAsset, side, amount);
      if (estimate.slippagePercent > this.slippageTolerancePercent) {
        const baseStr = baseAsset.isNative()
          ? "native"
          : `${baseAsset.getCode()}:${baseAsset.getIssuer()}`;
        const counterStr = counterAsset.isNative()
          ? "native"
          : `${counterAsset.getCode()}:${counterAsset.getIssuer()}`;
        this.onHighSlippage({
          baseAsset: baseStr,
          counterAsset: counterStr,
          slippagePercent: estimate.slippagePercent,
          slippageTolerancePercent: this.slippageTolerancePercent,
          fillEstimate: estimate,
        });
      }
    } catch {
      // Sampler errors are non-fatal; routing continues without a warning
    }
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  private cacheKey(kind: "send" | "receive", req: PathRequest): string {
    const src = req.sourceAsset.isNative()
      ? "native"
      : `${req.sourceAsset.getCode()}:${req.sourceAsset.getIssuer()}`;
    const dst = req.destinationAsset.isNative()
      ? "native"
      : `${req.destinationAsset.getCode()}:${req.destinationAsset.getIssuer()}`;
    return `path:${kind}:${src}:${dst}:${req.sourceAmount.toString()}`;
  }

  private cacheKeyReceive(
    sourceAsset: Asset,
    destAmount: bigint,
    destinationAsset: Asset,
  ): string {
    const src = sourceAsset.isNative()
      ? "native"
      : `${sourceAsset.getCode()}:${sourceAsset.getIssuer()}`;
    const dst = destinationAsset.isNative()
      ? "native"
      : `${destinationAsset.getCode()}:${destinationAsset.getIssuer()}`;
    return `path:receive:${src}:${dst}:${destAmount.toString()}`;
  }
}
