/**
 * Split rounding auditor — Issue #590
 *
 * When invoice amounts are divided among recipients using non-integer ratios,
 * floor-truncation of each share produces per-recipient amounts that may not
 * sum exactly to the invoice total. This module corrects that discrepancy
 * deterministically via the largest-remainder method and records every
 * one-stroop adjustment for downstream audit logging.
 *
 * All amounts are represented as bigint stroops throughout to avoid any
 * floating-point drift after the initial ratio multiplication.
 */

import { StellarSplitError } from "../errors.js";
import type { SplitLine, AuditedSplitResult, RoundingAdjustment } from "../types.js";

// ---------------------------------------------------------------------------
// RoundingOverflowError
// ---------------------------------------------------------------------------

/**
 * Thrown by {@link auditSplitRounding} when the total absolute adjustment
 * exceeds the acceptable threshold of `ceil(splits.length / 2)` stroops.
 *
 * A large overflow indicates unexpectedly bad input ratios (e.g. ratios that
 * do not sum anywhere close to 1.0) rather than a normal rounding artefact.
 */
export class RoundingOverflowError extends StellarSplitError {
  /** Total absolute adjustment that was computed (in stroops). */
  readonly totalAdjustmentStroops: bigint;
  /** The threshold that was exceeded (in stroops). */
  readonly thresholdStroops: bigint;
  /** Number of split lines that were passed in. */
  readonly splitCount: number;

  constructor(
    totalAdjustmentStroops: bigint,
    thresholdStroops: bigint,
    splitCount: number,
  ) {
    super(
      `Rounding adjustment of ${totalAdjustmentStroops} stroop(s) exceeds the ` +
        `acceptable threshold of ${thresholdStroops} stroop(s) for ${splitCount} recipients. ` +
        `Verify that all split ratios sum to 1.0.`,
      "ROUNDING_OVERFLOW",
      {
        totalAdjustmentStroops: totalAdjustmentStroops.toString(),
        thresholdStroops: thresholdStroops.toString(),
        splitCount,
      },
    );
    this.name = "RoundingOverflowError";
    this.totalAdjustmentStroops = totalAdjustmentStroops;
    this.thresholdStroops = thresholdStroops;
    this.splitCount = splitCount;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// auditSplitRounding
// ---------------------------------------------------------------------------

/**
 * Verify and correct per-recipient split amounts so they sum exactly to
 * `total`, using the largest-remainder method for deterministic correction.
 *
 * **Algorithm**
 * 1. For each `SplitLine`, compute the exact real-valued share:
 *    `exactShare = total × ratio`  (kept as a floating-point number for
 *    fractional-part comparison only; the floor value is converted to bigint).
 * 2. Assign each recipient their floor amount: `floor(exactShare)` stroops.
 * 3. Compute `remainder = total − sum(floorAmounts)`.
 * 4. Sort recipients by their fractional remainder descending and distribute
 *    the `remainder` whole stroops one-by-one to recipients with the largest
 *    remainders first.
 * 5. Record each +1 stroop adjustment in `AuditedSplitResult.adjustments`.
 * 6. If the total absolute adjustment exceeds `ceil(splits.length / 2)`,
 *    throw {@link RoundingOverflowError}.
 *
 * @param total  - Invoice total in stroops (bigint).
 * @param splits - Array of recipient/ratio pairs. Ratios should sum to 1.0.
 * @returns {@link AuditedSplitResult} with corrected per-recipient amounts and
 *          a log of every adjustment applied.
 *
 * @throws {RoundingOverflowError} When the correction exceeds the overflow
 *   threshold, indicating dangerously inconsistent input ratios.
 *
 * @example
 * ```ts
 * // 10 stroops split 1/3 each among 3 recipients
 * const result = auditSplitRounding(10n, [
 *   { recipientId: "A", ratio: 1/3 },
 *   { recipientId: "B", ratio: 1/3 },
 *   { recipientId: "C", ratio: 1/3 },
 * ]);
 * // result.amounts → { A: 4n, B: 3n, C: 3n }  (or similar largest-remainder order)
 * // result.adjustments → [{ recipientId: "A", delta: 1n }]
 * ```
 */
export function auditSplitRounding(
  total: bigint,
  splits: SplitLine[],
): AuditedSplitResult {
  if (splits.length === 0) {
    return { amounts: {}, adjustments: [], total };
  }

  // -------------------------------------------------------------------------
  // Step 1 & 2: Compute floor amounts and capture fractional remainders
  // -------------------------------------------------------------------------

  // We multiply total (bigint) by each ratio (float) in float space to get
  // the exact real share, then floor it to a bigint. The fractional part
  // drives the largest-remainder ranking.
  const totalFloat = Number(total);

  interface Entry {
    recipientId: string;
    floor: bigint;
    frac: number; // fractional part of the real-valued share
  }

  const entries: Entry[] = splits.map((line) => {
    const exactShare = totalFloat * line.ratio;
    const floorInt = Math.floor(exactShare);
    return {
      recipientId: line.recipientId,
      floor: BigInt(floorInt),
      frac: exactShare - floorInt,
    };
  });

  // -------------------------------------------------------------------------
  // Step 3: Compute the stroop remainder to distribute
  // -------------------------------------------------------------------------

  const floorSum = entries.reduce((acc, e) => acc + e.floor, 0n);
  const remainder = total - floorSum; // may be 0n, positive, or (rarely) negative

  // -------------------------------------------------------------------------
  // Step 6 (pre-distribution): Check overflow threshold before distributing
  // -------------------------------------------------------------------------

  const threshold = BigInt(Math.ceil(splits.length / 2));
  const absRemainder = remainder < 0n ? -remainder : remainder;

  if (absRemainder > threshold) {
    throw new RoundingOverflowError(absRemainder, threshold, splits.length);
  }

  // -------------------------------------------------------------------------
  // Step 4: Largest-remainder correction
  // -------------------------------------------------------------------------

  // Sort by fractional part descending (stable sort: ties broken by original order).
  const sorted = entries
    .map((e, originalIndex) => ({ ...e, originalIndex }))
    .sort((a, b) => {
      if (b.frac !== a.frac) return b.frac - a.frac;
      return a.originalIndex - b.originalIndex; // stable tie-break
    });

  const adjustments: RoundingAdjustment[] = [];
  const amounts: Record<string, bigint> = {};

  // Initialise all amounts to their floor values.
  for (const entry of entries) {
    amounts[entry.recipientId] = entry.floor;
  }

  if (remainder > 0n) {
    // Distribute +1 stroop to the top-|remainder| fractional recipients.
    for (let i = 0n; i < remainder; i++) {
      const entry = sorted[Number(i)];
      if (!entry) break;
      amounts[entry.recipientId] = (amounts[entry.recipientId] ?? 0n) + 1n;
      adjustments.push({ recipientId: entry.recipientId, delta: 1n });
    }
  } else if (remainder < 0n) {
    // Rare case: floor amounts over-sum (can happen when ratios sum > 1).
    // Remove 1 stroop from the top-|remainder| fractional recipients.
    const overCount = -remainder;
    for (let i = 0n; i < overCount; i++) {
      const entry = sorted[Number(i)];
      if (!entry) break;
      amounts[entry.recipientId] = (amounts[entry.recipientId] ?? 0n) - 1n;
      adjustments.push({ recipientId: entry.recipientId, delta: -1n });
    }
  }

  return { amounts, adjustments, total };
}
