/**
 * AMM Calculator — constant-product pool calculations for Stellar liquidity pools.
 *
 * Provides pure calculation functions for estimating swap output, price impact,
 * and proportional pool shares from LiquidityPoolRecord data without additional
 * Horizon calls.
 */

import { InsufficientLiquidityError } from "./errors.js";
import type { PoolSwapEstimate, PoolShareResult } from "./types.js";

/**
 * Default threshold: input exceeding 30 % of pool reserves triggers
 * InsufficientLiquidityError.  Can be overridden via the optional `maxRatio`
 * parameter on estimateSwapOutput.
 */
const DEFAULT_MAX_INPUT_RATIO = 0.3;

/**
 * Estimates the output amount and price impact for a swap against a Stellar
 * constant-product (x * y = k) liquidity pool.
 *
 * @param pool        - The liquidity pool record (must include reserves).
 * @param inputAmount - The amount of the input asset, in stroops.
 * @param inputAsset  - The asset being sold into the pool (must match one of the
 *                      pool's reserve assets).
 * @param maxRatio    - Maximum allowed ratio of input to reserve.  Defaults to
 *                      0.3 (30 %).  When exceeded an InsufficientLiquidityError
 *                      is thrown.
 * @returns A PoolSwapEstimate with the expected output amount and price impact
 *          percentage string.
 */
export function estimateSwapOutput(
  pool: { reserves: { asset: string; amount: string }[] },
  inputAmount: string,
  inputAsset: string,
  maxRatio: number = DEFAULT_MAX_INPUT_RATIO
): PoolSwapEstimate {
  if (pool.reserves.length < 2) {
    throw new InsufficientLiquidityError(
      "Pool must have at least two reserve assets",
      "0",
      inputAmount
    );
  }

  // Locate the input reserve and the output reserve.
  const inputReserve = pool.reserves.find(
    (r) => r.asset === inputAsset
  );
  const outputReserve = pool.reserves.find(
    (r) => r.asset !== inputAsset
  );

  if (!inputReserve || !outputReserve) {
    throw new InsufficientLiquidityError(
      `Asset ${inputAsset} not found in pool reserves`,
      "0",
      inputAmount
    );
  }

  const reserveIn = BigInt(inputReserve.amount);
  const reserveOut = BigInt(outputReserve.amount);
  const amountIn = BigInt(inputAmount);

  if (reserveIn <= 0n || reserveOut <= 0n) {
    throw new InsufficientLiquidityError(
      "Pool has zero reserves",
      "0",
      inputAmount
    );
  }

  if (amountIn <= 0n) {
    return {
      outputAmount: "0",
      priceImpactPercent: "0.00",
      inputAsset,
      outputAsset: outputReserve.asset,
      effectivePrice: "0",
      spotPrice: computeSpotPrice(reserveIn, reserveOut),
    };
  }

  // Check against max ratio threshold without coercing arbitrary-size BigInts
  // to Number. Both operands can exceed Number.MAX_VALUE, where Infinity /
  // Infinity would otherwise become NaN and silently bypass this guard.
  if (ratioExceedsLimit(amountIn, reserveIn, maxRatio)) {
    throw new InsufficientLiquidityError(
      `Input amount exceeds ${(maxRatio * 100).toFixed(0)}% of pool reserves`,
      inputReserve.amount,
      inputAmount
    );
  }

  // Constant-product formula: Δy = (y * Δx) / (x + Δx)
  // More precisely: outputAmount = reserveOut - (k / (reserveIn + amountIn))
  // where k = reserveIn * reserveOut
  const k = reserveIn * reserveOut;
  const newReserveIn = reserveIn + amountIn;
  const newReserveOut = k / newReserveIn;
  const outputAmount = reserveOut - newReserveOut;

  // Spot price = reserveOut / reserveIn  (how many output tokens per input token)
  const spotPrice = computeSpotPrice(reserveIn, reserveOut);

  // Effective price = outputAmount / inputAmount
  const effectivePrice = computeEffectivePrice(outputAmount, amountIn);

  // Price impact = (spotPrice - effectivePrice) / spotPrice * 100
  const priceImpactPercent = computePriceImpact(spotPrice, effectivePrice);

  return {
    outputAmount: outputAmount.toString(),
    priceImpactPercent,
    inputAsset,
    outputAsset: outputReserve.asset,
    effectivePrice,
    spotPrice,
  };
}

/**
 * Calculates the proportional pool share for a given number of liquidity pool
 * shares.
 *
 * @param pool         - The liquidity pool record.
 * @param sharesOwned    - Number of pool shares owned, in stroops.
 * @returns A PoolShareResult with the proportional reserves for both assets.
 */
export function calculatePoolShare(
  pool: { reserves: { asset: string; amount: string }[]; totalShares: string },
  sharesOwned: string
): PoolShareResult {
  if (pool.reserves.length < 2) {
    throw new InsufficientLiquidityError(
      "Pool must have at least two reserve assets",
      "0",
      "0"
    );
  }

  const totalShares = BigInt(pool.totalShares);
  const owned = BigInt(sharesOwned);

  if (totalShares <= 0n) {
    throw new InsufficientLiquidityError(
      "Pool has zero total shares",
      "0",
      "0"
    );
  }

  const reserve0 = pool.reserves[0]!;
  const reserve1 = pool.reserves[1]!;

  if (owned <= 0n) {
    return {
      shareOfAssetA: "0",
      shareOfAssetB: "0",
      assetA: reserve0.asset,
      assetB: reserve1.asset,
      totalShares: totalShares.toString(),
      sharesOwned: "0",
      ownershipPercent: "0.00",
    };
  }

  const reserveA = BigInt(reserve0.amount);
  const reserveB = BigInt(reserve1.amount);

  // Proportional share: (owned / totalShares) * reserve
  const shareOfAssetA = (reserveA * owned) / totalShares;
  const shareOfAssetB = (reserveB * owned) / totalShares;

  const ownershipPercent = computeOwnershipPercent(owned, totalShares);

  return {
    shareOfAssetA: shareOfAssetA.toString(),
    shareOfAssetB: shareOfAssetB.toString(),
    assetA: reserve0.asset,
    assetB: reserve1.asset,
    totalShares: totalShares.toString(),
    sharesOwned: owned.toString(),
    ownershipPercent,
  };
}

// ---------------------------------------------------------------------------
// Liquidity provider support (deposit / withdraw)
// ---------------------------------------------------------------------------

/**
 * Result of a proportional liquidity deposit calculation.
 */
export interface DepositEstimate {
  /** Amount of asset A to deposit, in stroops. */
  amountA: string;
  /** Amount of asset B to deposit, in stroops. */
  amountB: string;
  /** Pool shares that would be minted, in stroops. */
  sharesMinted: string;
  assetA: string;
  assetB: string;
}

/**
 * Result of a proportional liquidity withdrawal calculation.
 */
export interface WithdrawEstimate {
  /** Amount of asset A returned, in stroops. */
  amountA: string;
  /** Amount of asset B returned, in stroops. */
  amountB: string;
  /** Pool shares burned, in stroops. */
  sharesBurned: string;
  assetA: string;
  assetB: string;
}

/**
 * Computes the amounts of both assets required to mint `sharesToMint` pool
 * shares, based on the current pool reserves and total shares outstanding.
 *
 * @param pool         - The liquidity pool record.
 * @param sharesToMint - Desired number of pool shares to mint, in stroops.
 * @returns A DepositEstimate with the required deposit amounts.
 */
export function calculateDeposit(
  pool: { reserves: { asset: string; amount: string }[]; totalShares: string },
  sharesToMint: string
): DepositEstimate {
  if (pool.reserves.length < 2) {
    throw new InsufficientLiquidityError(
      "Pool must have at least two reserve assets",
      "0",
      sharesToMint
    );
  }

  const totalShares = BigInt(pool.totalShares);
  const mint = BigInt(sharesToMint);

  if (totalShares <= 0n) {
    throw new InsufficientLiquidityError(
      "Pool has zero total shares",
      "0",
      sharesToMint
    );
  }

  const reserve0 = pool.reserves[0]!;
  const reserve1 = pool.reserves[1]!;
  const reserveA = BigInt(reserve0.amount);
  const reserveB = BigInt(reserve1.amount);

  if (mint <= 0n) {
    return {
      amountA: "0",
      amountB: "0",
      sharesMinted: "0",
      assetA: reserve0.asset,
      assetB: reserve1.asset,
    };
  }

  // Required deposit: (mint / totalShares) * reserve
  const amountA = (reserveA * mint) / totalShares;
  const amountB = (reserveB * mint) / totalShares;

  return {
    amountA: amountA.toString(),
    amountB: amountB.toString(),
    sharesMinted: mint.toString(),
    assetA: reserve0.asset,
    assetB: reserve1.asset,
  };
}

/**
 * Computes the amounts of both assets returned when burning `sharesToBurn`
 * pool shares, based on the current pool reserves and total shares outstanding.
 *
 * @param pool         - The liquidity pool record.
 * @param sharesToBurn - Number of pool shares to burn, in stroops.
 * @returns A WithdrawEstimate with the returned amounts.
 */
export function calculateWithdraw(
  pool: { reserves: { asset: string; amount: string }[]; totalShares: string },
  sharesToBurn: string
): WithdrawEstimate {
  if (pool.reserves.length < 2) {
    throw new InsufficientLiquidityError(
      "Pool must have at least two reserve assets",
      "0",
      sharesToBurn
    );
  }

  const totalShares = BigInt(pool.totalShares);
  const burn = BigInt(sharesToBurn);

  if (totalShares <= 0n) {
    throw new InsufficientLiquidityError(
      "Pool has zero total shares",
      "0",
      sharesToBurn
    );
  }

  const reserve0 = pool.reserves[0]!;
  const reserve1 = pool.reserves[1]!;
  const reserveA = BigInt(reserve0.amount);
  const reserveB = BigInt(reserve1.amount);

  if (burn <= 0n) {
    return {
      amountA: "0",
      amountB: "0",
      sharesBurned: "0",
      assetA: reserve0.asset,
      assetB: reserve1.asset,
    };
  }

  // Returned amount: (burn / totalShares) * reserve
  const amountA = (reserveA * burn) / totalShares;
  const amountB = (reserveB * burn) / totalShares;

  return {
    amountA: amountA.toString(),
    amountB: amountB.toString(),
    sharesBurned: burn.toString(),
    assetA: reserve0.asset,
    assetB: reserve1.asset,
  };
}

// ---------------------------------------------------------------------------
// Slippage calculation
// ---------------------------------------------------------------------------

/**
 * Computes the minimum acceptable output amount given an expected output and a
 * slippage tolerance expressed in basis points (1 bps = 0.01 %).
 *
 * @param expectedOutput - Expected output amount, in stroops.
 * @param slippageBps    - Slippage tolerance in basis points (e.g. 50 = 0.5 %).
 * @returns The minimum acceptable output amount, in stroops.
 */
export function calculateMinimumOutput(
  expectedOutput: string,
  slippageBps: number
): string {
  if (slippageBps < 0 || slippageBps > 10000) {
    throw new RangeError("slippageBps must be between 0 and 10000");
  }

  const expected = BigInt(expectedOutput);
  if (expected <= 0n) {
    return "0";
  }

  const bps = BigInt(Math.floor(slippageBps));
  const minOutput = (expected * (10000n - bps)) / 10000n;
  return minOutput.toString();
}

// ---------------------------------------------------------------------------
// Swap routing across pools
// ---------------------------------------------------------------------------

/**
 * A candidate pool for swap routing.
 */
export interface RoutingPool {
  /** Unique pool identifier (e.g. the pool id). */
  id: string;
  /** Pool reserves. */
  reserves: { asset: string; amount: string }[];
}

/**
 * A single hop in a computed swap route.
 */
export interface RouteHop {
  poolId: string;
  inputAsset: string;
  outputAsset: string;
  inputAmount: string;
  outputAmount: string;
  priceImpactPercent: string;
}

/**
 * A computed swap route across one or more pools.
 */
export interface SwapRoute {
  hops: RouteHop[];
  inputAsset: string;
  outputAsset: string;
  inputAmount: string;
  outputAmount: string;
  /** Total price impact across all hops, as a percentage string. */
  totalPriceImpactPercent: string;
}

/**
 * Finds the best single-pool route for swapping `inputAmount` of `inputAsset`
 * into `outputAsset` across the provided candidate pools.  Pools that do not
 * contain both assets are skipped.  The route with the highest output amount
 * is returned, or `null` when no pool can service the swap.
 *
 * @param pools       - Candidate pools to route through.
 * @param inputAsset  - Asset being sold.
 * @param outputAsset - Asset being bought.
 * @param inputAmount - Amount of input asset, in stroops.
 * @returns The best SwapRoute, or null if no route exists.
 */
export function findBestRoute(
  pools: RoutingPool[],
  inputAsset: string,
  outputAsset: string,
  inputAmount: string
): SwapRoute | null {
  if (inputAsset === outputAsset) {
    return null;
  }

  let best: SwapRoute | null = null;

  for (const pool of pools) {
    const hasInput = pool.reserves.some((r) => r.asset === inputAsset);
    const hasOutput = pool.reserves.some((r) => r.asset === outputAsset);
    if (!hasInput || !hasOutput) {
      continue;
    }

    let estimate: PoolSwapEstimate;
    try {
      estimate = estimateSwapOutput(pool, inputAmount, inputAsset);
    } catch {
      continue;
    }

    const outputAmount = BigInt(estimate.outputAmount);
    if (outputAmount <= 0n) {
      continue;
    }

    if (best === null || outputAmount > BigInt(best.outputAmount)) {
      best = {
        hops: [
          {
            poolId: pool.id,
            inputAsset,
            outputAsset,
            inputAmount,
            outputAmount: estimate.outputAmount,
            priceImpactPercent: estimate.priceImpactPercent,
          },
        ],
        inputAsset,
        outputAsset,
        inputAmount,
        outputAmount: estimate.outputAmount,
        totalPriceImpactPercent: estimate.priceImpactPercent,
      };
    }
  }

  return best;
}

// ---------------------------------------------------------------------------
// Pool monitoring
// ---------------------------------------------------------------------------

/**
 * A snapshot of pool health metrics used for monitoring.
 */
export interface PoolHealthSnapshot {
  poolId: string;
  /** Reserve amounts keyed by asset. */
  reserves: Record<string, string>;
  totalShares: string;
  /** Implied spot price of asset B per asset A, as a decimal string. */
  spotPrice: string;
  /** Whether either reserve is empty (pool is drained). */
  drained: boolean;
}

/**
 * Builds a monitoring snapshot for a pool, capturing reserves, total shares,
 * and the implied spot price.  Useful for periodic health checks.
 *
 * @param pool - The liquidity pool record.
 * @returns A PoolHealthSnapshot describing the pool's current state.
 */
export function buildPoolHealthSnapshot(
  pool: { id: string; reserves: { asset: string; amount: string }[]; totalShares: string }
): PoolHealthSnapshot {
  const reserves: Record<string, string> = {};
  for (const r of pool.reserves) {
    reserves[r.asset] = r.amount;
  }

  let spotPrice = "0";
  let drained = pool.reserves.length < 2;

  if (pool.reserves.length >= 2) {
    const reserveA = BigInt(pool.reserves[0]!.amount);
    const reserveB = BigInt(pool.reserves[1]!.amount);
    if (reserveA <= 0n || reserveB <= 0n) {
      drained = true;
    } else {
      spotPrice = computeSpotPrice(reserveA, reserveB);
    }
  }

  return {
    poolId: pool.id,
    reserves,
    totalShares: pool.totalShares,
    spotPrice,
    drained,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function trimTrailingZeros(value: string): string {
  if (!value.includes(".")) return value;
  const trimmed = value.replace(/0+$/, "").replace(/\.$/, "");
  return trimmed === "" || trimmed === "-" ? "0" : trimmed;
}

function computeSpotPrice(reserveIn: bigint, reserveOut: bigint): string {
  if (reserveIn <= 0n) {
    return "0";
  }
  // Scale by 1e7 to preserve precision, then format as decimal string.
  const scaled = (reserveOut * 10000000n) / reserveIn;
  return trimTrailingZeros(formatScaled(scaled, 7));
}

function computeEffectivePrice(outputAmount: bigint, inputAmount: bigint): string {
  if (inputAmount <= 0n) {
    return "0";
  }
  const scaled = (outputAmount * 10000000n) / inputAmount;
  return trimTrailingZeros(formatScaled(scaled, 7));
}

function computePriceImpact(spotPrice: string, effectivePrice: string): string {
  const spot = parseScaled(spotPrice, 7);
  const effective = parseScaled(effectivePrice, 7);
  if (spot <= 0n) {
    return "0.00";
  }
  const diff = spot - effective;
  if (diff <= 0n) {
    return "0.00";
  }
  // impact% = diff / spot * 100, scaled by 100 for two decimals.
  const impactScaled = (diff * 10000n) / spot;
  return formatScaled(impactScaled, 2);
}

function computeOwnershipPercent(owned: bigint, totalShares: bigint): string {
  if (totalShares <= 0n) {
    return "0.00";
  }
  const scaled = (owned * 10000n) / totalShares;
  return formatScaled(scaled, 2);
}

function ratioExceedsLimit(amountIn: bigint, reserveIn: bigint, maxRatio: number): boolean {
  if (reserveIn <= 0n) {
    return true;
  }
  // Compare amountIn / reserveIn > maxRatio without floating point on BigInts.
  const scaledRatio = BigInt(Math.round(maxRatio * 1000000));
  return amountIn * 1000000n > reserveIn * scaledRatio;
}

function formatScaled(value: bigint, decimals: number): string {
  const negative = value < 0n;
  const abs = negative ? -value : value;
  const factor = 10n ** BigInt(decimals);
  const whole = abs / factor;
  const frac = abs % factor;
  const fracStr = frac.toString().padStart(decimals, "0");
  const result = decimals > 0 ? `${whole}.${fracStr}` : whole.toString();
  return negative ? `-${result}` : result;
}

function parseScaled(value: string, decimals: number): bigint {
  const negative = value.startsWith("-");
  const clean = negative ? value.slice(1) : value;
  const [whole, frac = ""] = clean.split(".");
  const fracPadded = frac.padEnd(decimals, "0").slice(0, decimals);
  const scaled = BigInt(whole || "0") * 10n ** BigInt(decimals) + BigInt(fracPadded || "0");
  return negative ? -scaled : scaled;
}
