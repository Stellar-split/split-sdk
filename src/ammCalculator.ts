/**
 * AMM Calculator for the Split protocol.
 *
 * This module provides functions to compute swap output amounts,
 * spot and effective prices, and price impact for trades in
 * constant-product automated market maker (AMM) pools.
 */

import type { Asset } from "./types";

/**
 * Represents a liquidity pool with reserves for two assets.
 */
export interface Pool {
  assets: [Asset, Asset];
  reserves: [string, string];
}

/**
 * Result of estimating a swap output.
 */
export interface SwapResult {
  outputAmount: string;
  spotPrice: string;
  effectivePrice: string;
  priceImpactPercent: string;
}

const FEES_PP = 9970n;
const PRECISION = 10n ** 18n;
const SCALE = 10000n;

function multiplyAndDivide(
  a: bigint,
  b: bigint,
  divisor: bigint,
): bigint {
  return (a * b) / divisor;
}

function parseDecimal(value: string): { int: bigint; frac: bigint; scale: bigint } {
  if (!value.includes(".")) {
    return { int: BigInt(value), frac: 0n, scale: 1n };
  }
  const [intPart, fracPart] = value.split(".");
  const frac = BigInt(fracPart);
  const scale = 10n ** BigInt(fracPart.length);
  return { int: BigInt(intPart), frac, scale };
}

function normalizeDecimal(value: string): string {
  const parsed = parseDecimal(value);
  const total = parsed.int * parsed.scale + parsed.frac;
  const result = total / parsed.scale;
  const remainder = total % parsed.scale;

  if (remainder === 0n) {
    return result.toString();
  }

  const decimalPart = (remainder * 10000n / parsed.scale).toString().padStart(4, "0");
  return `${result}.${decimalPart.slice(0, 4)}`;
}

function computeAmountOut(
  reserveIn: string,
  reserveOut: string,
  amountIn: string,
): string {
  const rIn = BigInt reserveIn);
  const rOut = BigInt(reserveOut);
  const aIn = BigInt(amountIn);
  const feeAdjusted = (aIn * FEES_PP) / 10000n;

  const numerator = feeAdjusted * rOut;
  const denominator = rIn * 10000n + feeAdjusted;

  return (numerator / denominator).toString();
}

function computePriceImpact(spotPrice: string, effectivePrice: string): string {
  if (spotPrice === "0" || effectivePrice === "0") {
    return "0.00";
  }

  const spot = parseDecimal(spotPrice);
  const effective = parseDecimal(effectivePrice);

  const spotScaled = spot.int * spot.scale + spot.frac;
  const effectiveScaled = effective.int * effective.scale + effective.frac;
  const commonScale = spot.scale > effective.scale ? spot.scale : effective.scale;
  const spotCommon = spotScaled * (commonScale / spot.scale);
  const effectiveCommon = effectiveScaled * (commonScale / effective.scale);

  if (spotCommon === 0n) return "0.00";

  // (spot - effective) / spot * 100 with 4 decimal places of precision
  const NUM_SCALE = 10000n;
  const numerator = (spotCommon - effectiveCommon) * NUM_SCALE * 100n;
  const denominator = spotCommon;

  if (numerator <= 0n) return "0.00";

  const impact = numerator / denominator;
  const whole = impact / 100n;
  const frac = impact % 100n;

  return `${whole}.${frac.toString().padStart(2, "0")}`;
}

function computeSpotPrice(reserves: [string, string]): string {
  const r0 = BigInt(reserves[0]);
  const r1 = BigInt(reserves[1]);
  return (r1 / r0).toString();
}

function computeEffectivePrice(outputAmount: string, inputAmount: string): string {
  const out = BigInt(outputAmount);
  const inp = BigInt(inputAmount);
  if (out === 0n || inp === 0n) {
    return "0";
  }
  return (out * PRECISION / inp).toString();
}

export function estimateSwapOutput(
  pool: Pool,
  inputAmount: string,
  inputAsset: Asset,
): SwapResult {
  const [asset0, asset1] = pool.assets;
  const [reserve0, reserve1] = pool.reserves;

  const isXToY = inputAsset === asset0;
  const reserveIn = isXToY ? reserve0 : reserve1;
  const reserveOut = isXToY ? reserve1 : reserve0;

  let outputAmount = "0";
  if (inputAmount !== "0") {
    outputAmount = computeAmountOut(reserveIn, reserveOut, inputAmount);
  }

  const spotPrice = computeSpotPrice(pool.reserves);
  const effectivePrice = computeEffectivePrice(outputAmount, inputAmount);
  const priceImpact = computePriceImpact(spotPrice, effectivePrice);

  return {
    outputAmount,
    spotPrice,
    effectivePrice,
    priceImpactPercent: priceImpact,
  };
}
