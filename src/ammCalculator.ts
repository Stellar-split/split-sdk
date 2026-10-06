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

  // Issue #1007 — Check against max ratio threshold without coercing
  // arbitrary-size BigInts to Number. Both operands can exceed
  // Number.MAX_VALUE, where Infinity / Infinity would otherwise become NaN
  // and silently bypass this guard.
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
// Price oracle integration helpers
// ---------------------------------------------------------------------------

/**
 * A single price observation returned by a price oracle source.
 */
export interface OraclePriceObservation {
  /** Asset identifier the price refers to (e.g. "native" or "USDC:GA..."). */
  asset: string;
  /** Price expressed as a decimal string, in the oracle's quote asset. */
  price: string;
  /** Unix timestamp (seconds) at which the price was observed. */
  timestamp: number;
}

/**
 * A price oracle source that can be queried for the latest price of an asset.
 * Implementations may wrap an on-chain oracle contract, an HTTP feed, or a
 * cached in-memory source.
 */
export interface PriceOracleSource {
  /** Fetches the latest observation for the given asset. */
  getPrice(asset: string): Promise<OraclePriceObservation>;
}

/**
 * A parsed, validated oracle price ready for use in AMM calculations.
 */
export interface ParsedOraclePrice {
  asset: string;
  /** Price as a decimal string, normalized to a fixed precision. */
  price: string;
  /** Price scaled to an integer string (price * 10^decimals). */
  scaledPrice: string;
  /** Number of decimal places used for scaledPrice. */
  decimals: number;
  timestamp: number;
  /** Age of the observation in seconds relative to the provided `now`. */
  ageSeconds: number;
  /** Whether the observation is older than the staleness threshold. */
  stale: boolean;
}

/**
 * Options controlling how oracle prices are parsed and validated.
 */
export interface OraclePriceOptions {
  /** Decimal places used when scaling the price. Defaults to 7 (Stellar). */
  decimals?: number;
  /** Maximum acceptable age in seconds before a price is flagged stale. */
  maxAgeSeconds?: number;
  /** Reference time (unix seconds) used to compute age. Defaults to now. */
  now?: number;
}

const DEFAULT_ORACLE_DECIMALS = 7;
const DEFAULT_ORACLE_MAX_AGE_SECONDS = 300;

/**
 * Fetches the latest price for `asset` from the given oracle source and parses
 * it into a validated {@link ParsedOraclePrice}.
 *
 * @param source  - The oracle source to query.
 * @param asset   - The asset identifier to fetch a price for.
 * @param options - Parsing/validation options.
 * @throws Error when the source returns a malformed or non-positive price.
 */
export async function fetchOraclePrice(
  source: PriceOracleSource,
  asset: string,
  options: OraclePriceOptions = {}
): Promise<ParsedOraclePrice> {
  const observation = await source.getPrice(asset);
  return parseOraclePrice(observation, options);
}

/**
 * Parses and validates a raw {@link OraclePriceObservation} into a
 * {@link ParsedOraclePrice}, scaling the price to an integer string and
 * computing staleness relative to `options.now`.
 *
 * @param observation - The raw observation to parse.
 * @param options     - Parsing/validation options.
 * @throws Error when the price is missing, malformed, or non-positive.
 */
export function parseOraclePrice(
  observation: OraclePriceObservation,
  options: OraclePriceOptions = {}
): ParsedOraclePrice {
  const decimals = options.decimals ?? DEFAULT_ORACLE_DECIMALS;
  const maxAgeSeconds =
    options.maxAgeSeconds ?? DEFAULT_ORACLE_MAX_AGE_SECONDS;
  const now = options.now ?? Math.floor(Date.now() / 1000);

  if (!observation || typeof observation.price !== "string") {
    throw new Error("Oracle price observation is missing a price");
  }

  const price = observation.price.trim();
  if (!/^\d+(\.\d+)?$/.test(price)) {
    throw new Error(`Malformed oracle price: ${observation.price}`);
  }

  const scaledPrice = scaleDecimal(price, decimals);
  if (BigInt(scaledPrice) <= 0n) {
    throw new Error(`Oracle price must be positive: ${observation.price}`);
  }

  const ageSeconds = Math.max(0, now - observation.timestamp);

  return {
    asset: observation.asset,
    price,
    scaledPrice,
    decimals,
    timestamp: observation.timestamp,
    ageSeconds,
    stale: ageSeconds > maxAgeSeconds,
  };
}

/**
 * Computes the cross price between two assets using their oracle prices.
 *
 * Given `base` priced in quote units and `counter` priced in the same quote
 * units, returns how many `counter` units one `base` unit is worth, as a
 * decimal string with `decimals` places of precision.
 *
 * @param base     - Parsed price for the base asset.
 * @param counter  - Parsed price for the counter asset.
 * @param decimals - Output precision. Defaults to the base price decimals.
 * @throws Error when the counter price is zero.
 */
export function computeCrossPrice(
  base: ParsedOraclePrice,
  counter: ParsedOraclePrice,
  decimals: number = base.decimals
): string {
  const counterScaled = BigInt(counter.scaledPrice);
  if (counterScaled === 0n) {
    throw new Error("Cannot compute cross price with a zero counter price");
  }

  const baseScaled = BigInt(base.scaledPrice);
  const SCALE = 10n ** BigInt(decimals);
  const result = (baseScaled * SCALE) / counterScaled;

  return formatScaled(result, decimals);
}

/**
 * Subscribes to oracle price updates for a set of assets, invoking `onUpdate`
 * whenever a new observation is produced.  Returns an unsubscribe function.
 *
 * The source is polled at `intervalMs`; each poll fetches every asset and
 * emits only observations whose price or timestamp changed since the previous
 * poll.  Errors from the source are forwarded to `onError` (if provided) and
 * do not stop the subscription.
 *
 * @param source     - The oracle source to poll.
 * @param assets     - Asset identifiers to watch.
 * @param onUpdate   - Callback invoked with each changed parsed price.
 * @param options    - Polling interval, parse options, and error handler.
 * @returns A function that stops the subscription when called.
 */
export function subscribeToOraclePrices(
  source: PriceOracleSource,
  assets: string[],
  onUpdate: (price: ParsedOraclePrice) => void,
  options: OraclePriceOptions & {
    intervalMs?: number;
    onError?: (error: unknown) => void;
  } = {}
): () => void {
  const intervalMs = options.intervalMs ?? 15_000;
  const lastSeen = new Map<string, string>();
  let stopped = false;

  const poll = async (): Promise<void> => {
    for (const asset of assets) {
      if (stopped) return;
      try {
        const parsed = await fetchOraclePrice(source, asset, options);
        const fingerprint = `${parsed.price}@${parsed.timestamp}`;
        if (lastSeen.get(asset) !== fingerprint) {
          lastSeen.set(asset, fingerprint);
          onUpdate(parsed);
        }
      } catch (error) {
        options.onError?.(error);
      }
    }
  };

  void poll();
  const timer = setInterval(() => {
    void poll();
  }, intervalMs);

  return () => {
    stopped = true;
    clearInterval(timer);
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function scaleDecimal(value: string, decimals: number): string {
  const dot = value.indexOf(".");
  const intPart = dot === -1 ? value : value.slice(0, dot);
  const fracPart = dot === -1 ? "" : value.slice(dot + 1);
  const paddedFrac = fracPart.padEnd(decimals, "0").slice(0, decimals);
  return `${intPart}${paddedFrac}`.replace(/^0+(?=\d)/, "") || "0";
}

function formatScaled(value: bigint, decimals: number): string {
  const SCALE = 10n ** BigInt(decimals);
  const intPart = value / SCALE;
  const fracPart = value % SCALE;
  if (decimals === 0) return intPart.toString();
  return `${intPart}.${fracPart.toString().padStart(decimals, "0")}`;
}

// Issue #1007 — cross-multiply BigInts against the limit ratio so that
// arbitrary-size inputs (e.g. 10^400) are not coerced to Infinity and then
// NaN by Number(). This replaces the prior `Number(amountIn) / Number(reserveIn) > maxRatio`.
function ratioExceedsLimit(amount: bigint, reserve: bigint, limit: number): boolean {
  if (!Number.isFinite(limit)) {
    // Preserve the prior comparison semantics for non-finite caller values:
    // NaN/+Infinity never reject, while -Infinity rejects every positive ratio.
    return limit === -Infinity;
  }

  const [coefficient, exponentText] = limit.toString().toLowerCase().split("e");
  const [integerPart, fractionalPart = ""] = coefficient!.split(".");
  let numerator = BigInt(`${integerPart}${fractionalPart}`);
  let denominator = 10n ** BigInt(fractionalPart.length);
  const exponent = Number(exponentText ?? "0");

  if (exponent > 0) {
    numerator *= 10n ** BigInt(exponent);
  } else if (exponent < 0) {
    denominator *= 10n ** BigInt(-exponent);
  }

  return amount * denominator > reserve * numerator;
}

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
  const SCALE = 10n ** 12n;
  const scaled = (numerator * SCALE) / denominator;
  const intPart = scaled / SCALE;
  const fracPart = scaled % SCALE;
  const fracStr = fracPart.toString().padStart(12, "0").replace(/0+$/, "");
  return fracStr.length > 0 ? `${intPart}.${fracStr}` : intPart.toString();
}
