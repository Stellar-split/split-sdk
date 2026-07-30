/**
 * DEX Order Book Liquidity Depth Sampler — Issue #543
 *
 * Queries the Horizon order book for a given asset pair and simulates a
 * market-order fill to estimate price impact and slippage before routing a
 * large split payment through the Stellar DEX.
 */

import { Asset, Horizon } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single level consumed during a simulated market-order fill.
 * Each level corresponds to one open order in the Horizon order book.
 */
export interface FilledLevel {
  /** Price at this level (counter per base). */
  price: number;
  /** Amount filled from this level (in the base asset's units). */
  amountFilled: number;
}

/**
 * Result of sampling the order book for a given amount and side.
 */
export interface OrderBookSample {
  /** Estimated total cost or proceeds in the counter asset. */
  estimatedCost: number;
  /** Slippage percentage: (worstPrice − bestPrice) / bestPrice × 100 */
  slippagePercent: number;
  /** The worst (most unfavourable) price encountered in the fill. */
  worstPrice: number;
  /** The best (most favourable) price encountered — i.e. the first level touched. */
  bestPrice: number;
  /** Individual order-book levels consumed to fill the order. */
  filledAtLevels: FilledLevel[];
  /**
   * Fraction of the requested amount that was filled [0, 1].
   * A value < 1 means the order book lacked enough liquidity at any price.
   */
  filledFraction: number;
}

/**
 * A complete fill estimate returned by {@link OrderBookSampler.sample}.
 *
 * When `filledFraction < 1` the order book could not accommodate the full
 * requested amount; `estimatedCost`, `slippagePercent`, and `worstPrice`
 * reflect only the partial fill.
 */
export type FillEstimate = OrderBookSample;

/** Configuration for {@link OrderBookSampler}. */
export interface OrderBookSamplerConfig {
  /** Horizon server URL (e.g. "https://horizon-testnet.stellar.org"). */
  horizonUrl: string;
  /**
   * Slippage tolerance percentage above which `highSlippageWarning` is emitted
   * by {@link PathRouter}.  Default: 1 (%).
   */
  slippageTolerancePercent?: number;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Samples the Horizon DEX order book for a given asset pair and simulates a
 * market-order fill to compute estimated cost and slippage.
 *
 * @example
 * ```ts
 * const sampler = new OrderBookSampler({ horizonUrl: "https://horizon.stellar.org" });
 * const estimate = await sampler.sample(
 *   Asset.native(),
 *   new Asset("USDC", "GA5ZSEJ..."),
 *   "buy",
 *   1_000_000n   // 0.1 XLM in stroops
 * );
 * console.log(estimate.slippagePercent, estimate.filledFraction);
 * ```
 */
export class OrderBookSampler {
  private readonly server: Horizon.Server;
  readonly slippageTolerancePercent: number;

  constructor(config: OrderBookSamplerConfig) {
    this.server = new Horizon.Server(config.horizonUrl);
    this.slippageTolerancePercent = config.slippageTolerancePercent ?? 1;
  }

  /**
   * Sample the order book and simulate filling `amount` of `baseAsset` on the
   * given `side`.
   *
   * - `"buy"`:  walk the **asks** (we are buying base, paying counter).
   * - `"sell"`: walk the **bids** (we are selling base, receiving counter).
   *
   * @param baseAsset    - The base asset (e.g. XLM).
   * @param counterAsset - The counter asset (e.g. USDC).
   * @param side         - `"buy"` to walk asks, `"sell"` to walk bids.
   * @param amount       - Desired fill amount **in the base asset's smallest
   *                       unit** (stroops for XLM, or the token's base unit).
   *                       Passed as `bigint` to avoid floating-point loss for
   *                       large values.
   * @returns A {@link FillEstimate} describing fill cost, slippage, and levels.
   */
  async sample(
    baseAsset: Asset,
    counterAsset: Asset,
    side: "buy" | "sell",
    amount: bigint,
  ): Promise<FillEstimate> {
    // Fetch the order book from Horizon
    const orderbook = await this.server
      .orderbook(baseAsset, counterAsset)
      .call();

    // Select the correct side (asks for buy, bids for sell)
    const levels: Array<{ price: string; amount: string }> =
      side === "buy" ? orderbook.asks : orderbook.bids;

    return simulateFill(amount, levels);
  }

  /**
   * Expose the underlying Horizon server for further queries.
   */
  getServer(): Horizon.Server {
    return this.server;
  }
}

// ---------------------------------------------------------------------------
// Pure fill simulation (also exported for unit-testing)
// ---------------------------------------------------------------------------

/**
 * Walk an ordered array of price levels and simulate consuming `amount` units
 * of the base asset.
 *
 * Exported as a named function so unit tests can call it without a live
 * Horizon connection.
 *
 * @param amount - Amount to fill in the base asset's smallest unit (bigint).
 * @param levels - Ordered price levels from the order book (best price first).
 * @returns A complete {@link FillEstimate}.
 */
export function simulateFill(
  amount: bigint,
  levels: Array<{ price: string; amount: string }>,
): FillEstimate {
  if (amount <= 0n || levels.length === 0) {
    return {
      estimatedCost: 0,
      slippagePercent: 0,
      worstPrice: 0,
      bestPrice: 0,
      filledAtLevels: [],
      filledFraction: amount <= 0n ? 1 : 0,
    };
  }

  let remaining = amount;
  let totalCost = 0;
  let bestPrice: number | null = null;
  let worstPrice = 0;
  const filledAtLevels: FilledLevel[] = [];

  for (const level of levels) {
    if (remaining <= 0n) break;

    const levelPrice = parseFloat(level.price);
    const levelAmount = parseFloat(level.amount);

    if (!isFinite(levelPrice) || !isFinite(levelAmount) || levelAmount <= 0) {
      continue;
    }

    if (bestPrice === null) {
      bestPrice = levelPrice;
    }
    worstPrice = levelPrice;

    // Convert remaining bigint to a float for arithmetic (precision adequate
    // for slippage purposes; bigint is preserved for the fraction calculation).
    const remainingFloat = Number(remaining);
    const fillBase = Math.min(remainingFloat, levelAmount);

    totalCost += fillBase * levelPrice;
    filledAtLevels.push({ price: levelPrice, amountFilled: fillBase });

    // Consume from remaining (re-use bigint arithmetic for the fraction)
    const fillBigint = BigInt(Math.floor(fillBase));
    remaining = remaining > fillBigint ? remaining - fillBigint : 0n;
  }

  const totalFilled = amount - remaining;
  const filledFraction =
    amount === 0n ? 1 : Math.min(1, Number(totalFilled) / Number(amount));

  const bp = bestPrice ?? 0;
  const slippagePercent =
    bp === 0
      ? 0
      : ((worstPrice - bp) / bp) * 100;

  return {
    estimatedCost: totalCost,
    slippagePercent,
    worstPrice,
    bestPrice: bp,
    filledAtLevels,
    filledFraction,
  };
}
