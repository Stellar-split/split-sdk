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
