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

  // Check against max ratio threshold
  const ratio = Number(amountIn) / Number(reserveIn);
  if (ratio > maxRatio) {
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

  if (owned <= 0n) {
    return {
      shareOfAssetA: "0",
      shareOfAssetB: "0",
      assetA: pool.reserves[0].asset,
      assetB: pool.reserves[1].asset,
      totalShares: totalShares.toString(),
      sharesOwned: "0",
      ownershipPercent: "0.00",
    };
  }

  const reserveA = BigInt(pool.reserves[0].amount);
  const reserveB = BigInt(pool.reserves[1].amount);

  // Proportional share: (owned / totalShares) * reserve
  const shareOfAssetA = (reserveA * owned) / totalShares;
  const shareOfAssetB = (reserveB * owned) / totalShares;

  const ownershipPercent = computeOwnershipPercent(owned, totalShares);

  return {
    shareOfAssetA: shareOfAssetA.toString(),
    shareOfAssetB: shareOfAssetB.toString(),
    assetA: pool.reserves[0].asset,
    assetB: pool.reserves[1].asset,
    totalShares: totalShares.toString(),
    sharesOwned: owned.toString(),
    ownershipPercent,
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function computeSpotPrice(reserveIn: bigint, reserveOut: bigint): string {
  // spotPrice = reserveOut / reserveIn as a decimal string
  if (reserveIn === 0n) return "0";
  return formatRatio(reserveOut, reserveIn);
}

function computeEffectivePrice(outputAmount: bigint, inputAmount: bigint): string {
  if (inputAmount === 0n) return "0";
  return formatRatio(outputAmount, inputAmount);
}

function computePriceImpact(spotPrice: string, effectivePrice: string): string {
  // Parse the decimal strings safely by treating them as fractional strings.
  // Since formatRatio now outputs exact decimal strings, we parse them as
  // pairs of (integer, fractional) parts for high precision.
  const parseDecimal = (s: string): { int: bigint; frac: bigint; scale: bigint } => {
    const dot = s.indexOf(".");
    if (dot === -1) return { int: BigInt(s), frac: 0n, scale: 1n };
    const intPart = BigInt(s.slice(0, dot));
    const fracPartStr = s.slice(dot + 1).padEnd(12, "0");
    const scale = 10n ** BigInt(fracPartStr.length);
    return { int: intPart, frac: BigInt(fracPartStr), scale };
  };

  const spot = parseDecimal(spotPrice);
  const effective = parseDecimal(effectivePrice);
  
  const spotScaled = spot.int * spot.scale + spot.frac;
  const effectiveScaled = effective.int * effective.scale + effective.frac;

  if (spotScaled === 0n) return "0.00";

  // (spot - effective) / spot * 100 with 4 decimal places of precision
  const SCALE = 10000n;
  const numerator = (spotScaled - effectiveScaled) * SCALE * 100n;
  const denominator = spotScaled;

  if (numerator <= 0n) return "0.00";

  const result = numerator / denominator;
  const intPart = result / SCALE;
  const fracPart = result % SCALE;
  const fracStr = fracPart.toString().padStart(4, "0").slice(0, 2);
  return `${intPart}.${fracStr}`;
}

function computeOwnershipPercent(owned: bigint, total: bigint): string {
  if (total === 0n) return "0.00";
  // (owned / total) * 100 with 2 decimal places using BigInt
  const SCALE = 10000n; // 100 * 100 for 2 decimal places
  const scaled = (owned * SCALE * 100n) / total;
  const intPart = scaled / SCALE;
  const fracPart = scaled % SCALE;
  const fracStr = fracPart.toString().padStart(4, "0").slice(0, 2);
  return `${intPart}.${fracStr}`;
}

function formatRatio(numerator: bigint, denominator: bigint): string {
  if (denominator === 0n) return "0";
  // Use BigInt-safe decimal division with up to 12 decimal places.
  // Multiply numerator by 10^12 before division, then insert decimal point.
  const SCALE = 10n ** 12n;
  const scaled = (numerator * SCALE) / denominator;
  const intPart = scaled / SCALE;
  const fracPart = scaled % SCALE;
  const fracStr = fracPart.toString().padStart(12, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${intPart}.${fracStr}` : intPart.toString();
}
