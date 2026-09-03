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
      `[${SdkErrorCode.INVALID_RECIPIENT}] basisPoints must be between 0 and 10000, got ${basisPoints.toString()}`,
      SdkErrorCode.INVALID_RECIPIENT,
      { basisPoints: basisPoints.toString() },
    );
  }

  // General formula: scale basisPoints by 10^decimals, divide by 100, round.
  // basisPoints / 100 = percentage; scaling preserves decimal places.
  const scale = 10n ** BigInt(decimals);
  const numerator = basisPoints * scale;
  const quotient = numerator / 100n;
  const remainder = numerator % 100n;
  const rounded = remainder >= 50n ? quotient + 1n : quotient;

  if (decimals === 0) {
    return `${rounded}%`;
  }

  const wholePart = rounded / scale;
  const fracPart = rounded % scale;
  return `${wholePart}.${fracPart.toString().padStart(decimals, "0")}%`;
}

/**
 * Returns the sum of an array of line-item amounts (in stroops).
 * This is the invoice subtotal before any fee is applied.
 */
export function calculateInvoiceSubtotal(amounts: bigint[]): bigint {
  return amounts.reduce((acc, v) => acc + v, 0n);
}

/**
 * Breaks an invoice total into subtotal, fee, and final total.
 * @param subtotal - The pre-fee invoice amount in stroops
 * @param feeBps   - Fee in basis points (e.g. 250 = 2.5%)
 */
export function calculateInvoiceBreakdown(
  subtotal: bigint,
  feeBps: number,
): { subtotal: bigint; fee: bigint; total: bigint } {
  const fee = (subtotal * BigInt(feeBps)) / 10000n;
  return { subtotal, fee, total: subtotal + fee };
}
