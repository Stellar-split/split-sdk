/**
 * Invoice split calculator — Issue #590
 *
 * Derives per-recipient stroop amounts from an invoice total and a set of
 * ratio-based split lines, then runs {@link auditSplitRounding} to guarantee
 * that the computed amounts sum exactly to the total.
 *
 * This is the entry-point callers should use; `rounding.ts` is the low-level
 * auditor that can also be called standalone.
 */

import { auditSplitRounding, RoundingOverflowError } from "./rounding.js";
import { SdkError, SdkErrorCode } from "../errors.js";
import type { SplitLine, AuditedSplitResult } from "../types.js";

// Re-export the error so callers can import it from the calculator.
export { RoundingOverflowError };

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute per-recipient stroop amounts from `total` and `splits`, applying
 * the largest-remainder correction so the results sum exactly to `total`.
 *
 * @param total  - Invoice total in stroops (bigint).
 * @param splits - Array of `{ recipientId, ratio }` pairs. Ratios should sum
 *                 to 1.0; small deviations are tolerated and corrected.
 * @returns {@link AuditedSplitResult} containing:
 *   - `amounts`     — final per-recipient stroop amounts (sum === `total`)
 *   - `adjustments` — log of every +/−1 stroop correction applied
 *   - `total`       — the original total passed in
 *
 * @throws {RoundingOverflowError} When the total adjustment exceeds
 *   `ceil(splits.length / 2)` stroops, indicating severely inconsistent
 *   input ratios.
 *
 * @example
 * ```ts
 * import { calculateSplitAmounts } from "./calculator.js";
 *
 * const result = calculateSplitAmounts(100n, [
 *   { recipientId: "GABC", ratio: 0.6 },
 *   { recipientId: "GDEF", ratio: 0.4 },
 * ]);
 * // result.amounts → { GABC: 60n, GDEF: 40n }
 * // result.adjustments → []
 * ```
 */
export function calculateSplitAmounts(
  total: bigint,
  splits: SplitLine[],
): AuditedSplitResult {
  return auditSplitRounding(total, splits);
}

/**
 * Convenience wrapper: returns only the flat `amounts` map without the
 * adjustment log. Useful when callers do not need to log rounding details.
 *
 * @throws {RoundingOverflowError} Same conditions as {@link calculateSplitAmounts}.
 */
export function computeAmounts(
  total: bigint,
  splits: SplitLine[],
): Record<string, bigint> {
  return calculateSplitAmounts(total, splits).amounts;
}

// ---------------------------------------------------------------------------
// Formatting helpers
// ---------------------------------------------------------------------------

/** Basis points per whole unit (1.0 = 10000 bps). */
const BASIS_POINTS_PER_UNIT = 10000n;

/**
 * Format a basis-point value as a human-readable percentage string.
 *
 * @param basisPoints - Integer value in basis points (0–10000).
 * @param opts.decimals - Number of decimal places to display (default 2, range 0–4).
 * @returns Percentage string such as `"33.33%"` or `"100.00%"`.
 *
 * @throws {SdkError} When `basisPoints` is outside the 0–10000 range.
 * @throws {RangeError} When `opts.decimals` is outside the 0–4 range.
 *
 * @example
 * ```ts
 * formatSplitPercentage(3333n); // "33.33%"
 * formatSplitPercentage(1n);    // "0.01%"
 * formatSplitPercentage(3333n, { decimals: 0 }); // "33%"
 * ```
 */
export function formatSplitPercentage(
  basisPoints: bigint,
  opts?: { decimals?: number },
): string {
  const decimals = opts?.decimals ?? 2;

  if (decimals < 0 || decimals > 4 || !Number.isInteger(decimals)) {
    throw new RangeError(`decimals must be an integer between 0 and 4, got ${decimals}`);
  }

  if (basisPoints < 0n || basisPoints > BASIS_POINTS_PER_UNIT) {
    throw new SdkError(
      `basisPoints must be between 0 and 10000, got ${basisPoints.toString()}`,
      SdkErrorCode.INVALID_RECIPIENT,
      { basisPoints: basisPoints.toString() },
    );
  }

  if (decimals === 0) {
    // Integer percentage, with standard rounding.
    const scaled = basisPoints + BASIS_POINTS_PER_UNIT / 2n;
    const whole = scaled / BASIS_POINTS_PER_UNIT;
    return `${whole.toString()}%`;
  }

  // Compute whole and fractional parts without floating point.
  const whole = basisPoints / BASIS_POINTS_PER_UNIT;
  const remainder = basisPoints % BASIS_POINTS_PER_UNIT;

  // Scale remainder to the requested number of decimal places.
  // e.g. decimals=2: remainder * 100 / 10000 = remainder / 100
  const divisor = 10n ** BigInt(4 - decimals);
  let fractional = remainder / divisor;
  const remainderMod = remainder % divisor;

  // Round to nearest at the last displayed decimal place.
  const halfDivisor = divisor / 2n;
  if (remainderMod >= halfDivisor) {
    fractional += 1n;
  }

  // Handle carry-over that turns fractional into a whole unit (e.g. 99.995 → 100.00).
  const maxFractional = 10n ** BigInt(decimals) - 1n;
  if (fractional > maxFractional) {
    return `${(whole + 1n).toString()}.${"0".repeat(decimals)}%`;
  }

  const fractionalStr = fractional.toString().padStart(decimals, "0");
  return `${whole.toString()}.${fractionalStr}%`;
}
