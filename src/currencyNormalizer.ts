/**
 * Currency Normalizer — translates between on-chain integer representations
 * and human-readable decimal values for every asset the SDK handles.
 *
 * Stellar assets carry asset-specific decimal precisions that differ from the
 * seven-decimal XLM base unit. This module normalises raw stroop / sub-unit
 * amounts before arithmetic to prevent silent rounding errors in invoice totals.
 */

import { Asset } from "@stellar/stellar-sdk";
import { PrecisionError } from "./errors.js";

/**
 * Well-known asset precisions keyed by canonical asset identifier.
 * Extends the built-in "native" (XLM) and SEP-41 token decimals.
 */
const ASSET_PRECISIONS: Record<string, number> = {
  native: 7, // XLM = 7 decimal places
};

/**
 * Register a custom asset's decimal precision for normalisation.
 * Called automatically by SEP-41 token metadata fetchers; callers
 * can also pre-seed known tokens to avoid a fetch.
 *
 * @param assetCode - Canonical asset identifier (contract address or "native").
 * @param decimals  - Number of decimal places (e.g., 7 for USDC on Stellar).
 */
export function registerAssetPrecision(assetCode: string, decimals: number): void {
  ASSET_PRECISIONS[assetCode] = decimals;
}

/**
 * Resolve the decimal precision for an asset.
 * Returns 7 for XLM, stored precision for registered tokens, and throws
 * for unknown assets.
 *
 * @param asset - Stellar SDK Asset instance or canonical identifier string.
 * @returns The number of decimal places for this asset.
 */
export function getAssetPrecision(asset: Asset | string): number {
  if (typeof asset === "string") {
    const precision = ASSET_PRECISIONS[asset];
    if (precision !== undefined) return precision;
    throw new PrecisionError(
      asset,
      asset,
      "Unknown asset precision; call registerAssetPrecision() first",
    );
  }

  if (asset.isNative()) {
    return 7;
  }

  const code = `${asset.getCode()}:${asset.getIssuer()}`;
  const precision = ASSET_PRECISIONS[code] ?? ASSET_PRECISIONS[asset.getCode()];
  if (precision !== undefined) return precision;

  throw new PrecisionError(
    asset.getCode(),
    code,
    "Unknown asset precision; call registerAssetPrecision() first",
  );
}

/**
 * Normalise a raw on-chain amount (string or bigint) to a display-formatted
 * string with the correct number of decimal places.
 *
 * Example: normalizeAmount(10000000n, Asset.native()) => "1.0000000"
 *
 * @param raw   - Raw on-chain amount in stroops / sub-units.
 * @param asset - Stellar Asset instance or canonical identifier.
 * @returns Decimal string with the asset-appropriate number of places.
 */
export function normalizeAmount(
  raw: string | bigint,
  asset: Asset | string,
): string {
  const precision = getAssetPrecision(asset);
  const rawValue = typeof raw === "string" ? BigInt(raw) : raw;

  if (precision === 0) return rawValue.toString();

  const divisor = 10n ** BigInt(precision);
  const intPart = rawValue / divisor;
  const fracPart = rawValue % divisor;

  // Pad fractional part to exactly `precision` digits
  const fracStr = fracPart
    .toString()
    .padStart(precision, "0")
    .replace(/0+$/, "");

  if (fracStr.length === 0) {
    return `${intPart}.${"0".repeat(precision)}`;
  }

  return `${intPart}.${fracStr.padEnd(precision, "0")}`;
}

/**
 * Convert a display-formatted decimal amount to the canonical on-chain
 * integer (stroop / sub-unit) string accepted by @stellar/stellar-sdk operations.
 *
 * Example: toOnChainAmount("1.5", Asset.native()) => "15000000"
 *
 * @param display - Human-readable decimal amount.
 * @param asset   - Stellar Asset instance or canonical identifier.
 * @returns Canonical integer string suitable for SDK operations.
 * @throws PrecisionError when the conversion would lose sub-unit precision.
 */
export function toOnChainAmount(
  display: string,
  asset: Asset | string,
): string {
  const precision = getAssetPrecision(asset);

  // Parse the decimal string
  const dotIndex = display.indexOf(".");
  if (dotIndex === -1) {
    // Whole number — multiply by 10^precision
    return (BigInt(display) * (10n ** BigInt(precision))).toString();
  }

  const intPart = display.slice(0, dotIndex).replace(/^0+(?=\d)/, "") || "0";
  let fracPart = display.slice(dotIndex + 1);

  // Validate fractional part length does not exceed precision
  if (fracPart.length > precision) {
    throw new PrecisionError(
      display,
      typeof asset === "string" ? asset : asset.getCode(),
      `Fractional part has ${fracPart.length} digits but precision is ${precision}`,
    );
  }

  // Pad fractional part to precision
  fracPart = fracPart.padEnd(precision, "0");

  const result = BigInt(intPart) * (10n ** BigInt(precision)) + BigInt(fracPart);
  return result.toString();
}

/**
 * Round-trip test: convert display to on-chain and back, verifying the
 * original display string is recovered (modulo trailing zeros).
 *
 * @param display - Human-readable decimal amount.
 * @param asset   - Stellar Asset instance or canonical identifier.
 * @returns `true` if the round-trip preserves the value.
 */
export function verifyRoundTrip(
  display: string,
  asset: Asset | string,
): boolean {
  try {
    const onChain = toOnChainAmount(display, asset);
    const back = normalizeAmount(onChain, asset);
    // Normalise both to remove trailing zeros for comparison
    const normalisedDisplay = display.includes(".")
      ? display.replace(/0+$/, "").replace(/\.$/, ".0")
      : display + ".0";
    const normalisedBack = back.replace(/0+$/, "").replace(/\.$/, ".0");
    return normalisedDisplay === normalisedBack;
  } catch {
    return false;
  }
}

/**
 * Parse a display-formatted decimal string into an exact integer mantissa
 * and scale, without any floating-point arithmetic.
 *
 * Example: parseDecimal("1.50") => { mantissa: 150n, scale: 2 }
 *
 * @param display - Human-readable decimal amount (optionally signed).
 * @returns Exact mantissa (bigint) and number of fractional digits.
 * @throws PrecisionError when the input is not a valid decimal string.
 */
export function parseDecimal(display: string): { mantissa: bigint; scale: number } {
  const trimmed = display.trim();
  if (!/^[+-]?\d*(\.\d*)?$/.test(trimmed) || trimmed === "" || trimmed === "." ||
      trimmed === "+" || trimmed === "-" || trimmed === "+." || trimmed === "-.") {
    throw new PrecisionError(display, display, "Invalid decimal string");
  }

  const negative = trimmed.startsWith("-");
  const unsigned = trimmed.replace(/^[+-]/, "");
  const dotIndex = unsigned.indexOf(".");
  const intPart = dotIndex === -1 ? unsigned : unsigned.slice(0, dotIndex);
  const fracPart = dotIndex === -1 ? "" : unsigned.slice(dotIndex + 1);

  const digits = `${intPart || "0"}${fracPart}`;
  const magnitude = BigInt(digits);
  return { mantissa: negative ? -magnitude : magnitude, scale: fracPart.length };
}

/**
 * Rescale an exact decimal (mantissa + scale) to a target number of decimal
 * places, rounding half-up when digits must be dropped. Never uses floats.
 *
 * @param mantissa - Exact integer mantissa.
 * @param scale    - Current number of fractional digits.
 * @param target   - Desired number of fractional digits.
 * @returns Mantissa rescaled to `target` decimal places.
 */
export function rescaleDecimal(
  mantissa: bigint,
  scale: number,
  target: number,
): bigint {
  if (target < 0) {
    throw new PrecisionError(String(mantissa), String(target), "Target scale must be non-negative");
  }
  if (scale === target) return mantissa;

  if (scale < target) {
    return mantissa * 10n ** BigInt(target - scale);
  }

  const divisor = 10n ** BigInt(scale - target);
  const negative = mantissa < 0n;
  const abs = negative ? -mantissa : mantissa;
  const quotient = abs / divisor;
  const remainder = abs % divisor;
  // Round half-up on the absolute value, then reapply sign.
  const rounded = remainder * 2n >= divisor ? quotient + 1n : quotient;
  return negative ? -rounded : rounded;
}

/**
 * Convert a display amount denominated in one asset into the equivalent
 * on-chain integer amount denominated in another asset, preserving exact
 * precision across differing decimal places.
 *
 * The conversion is performed entirely with bigint arithmetic: the source
 * amount is parsed exactly, rescaled to the target asset's precision, and
 * returned as a canonical integer string. No floating-point values are used,
 * so no precision is lost beyond the target asset's inherent granularity.
 *
 * Example: convertAmountPrecise("1.5", Asset.native(), usdcAsset)
 *          => on-chain USDC amount for 1.5 XLM-equivalent units.
 *
 * @param display     - Human-readable decimal amount in the source asset.
 * @param fromAsset   - Source Stellar Asset instance or canonical identifier.
 * @param toAsset     - Target Stellar Asset instance or canonical identifier.
 * @returns Canonical integer string in the target asset's sub-units.
 * @throws PrecisionError when the input is invalid or would lose precision.
 */
export function convertAmountPrecise(
  display: string,
  fromAsset: Asset | string,
  toAsset: Asset | string,
): string {
  const fromPrecision = getAssetPrecision(fromAsset);
  const toPrecision = getAssetPrecision(toAsset);

  const { mantissa, scale } = parseDecimal(display);

  // Reject inputs that carry more precision than the source asset supports.
  if (scale > fromPrecision) {
    throw new PrecisionError(
      display,
      typeof fromAsset === "string" ? fromAsset : fromAsset.getCode(),
      `Fractional part has ${scale} digits but precision is ${fromPrecision}`,
    );
  }

  const rescaled = rescaleDecimal(mantissa, scale, toPrecision);
  return rescaled.toString();
}

/**
 * Convert an on-chain integer amount denominated in one asset into a
 * display-formatted decimal string denominated in another asset, preserving
 * exact precision across differing decimal places.
 *
 * Example: convertOnChainPrecise("15000000", Asset.native(), usdcAsset)
 *          => display amount in USDC units.
 *
 * @param raw       - Raw on-chain amount in the source asset's sub-units.
 * @param fromAsset - Source Stellar Asset instance or canonical identifier.
 * @param toAsset   - Target Stellar Asset instance or canonical identifier.
 * @returns Display decimal string in the target asset's precision.
 */
export function convertOnChainPrecise(
  raw: string | bigint,
  fromAsset: Asset | string,
  toAsset: Asset | string,
): string {
  const fromPrecision = getAssetPrecision(fromAsset);
  const toPrecision = getAssetPrecision(toAsset);
  const rawValue = typeof raw === "string" ? BigInt(raw) : raw;

  const rescaled = rescaleDecimal(rawValue, fromPrecision, toPrecision);
  return normalizeAmount(rescaled, toAsset);
}
