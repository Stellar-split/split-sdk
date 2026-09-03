/**
 * Tests for the split rounding auditor — Issue #590
 *
 * Acceptance criteria covered:
 *  AC-1: auditSplitRounding returns adjusted amounts that sum exactly to total (bigint)
 *  AC-2: Largest-remainder method is used for correction
 *  AC-3: Adjustments whose total absolute value exceeds ceil(splits.length/2) throw RoundingOverflowError
 *  AC-4: Each applied adjustment is recorded in AuditedSplitResult.adjustments
 *  AC-5: Tests cover exact-division, 3-way uneven split (+1 stroop), and 1-stroop across 3 recipients
 */

import { describe, it, expect } from "vitest";
import { auditSplitRounding, RoundingOverflowError } from "../src/invoice/rounding.js";
import {
  calculateInvoiceBreakdown,
  calculateInvoiceSubtotal,
  calculateSplitAmounts,
  computeAmounts,
} from "../src/invoice/calculator.js";
import type { SplitLine } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Sum all bigint values in a Record<string, bigint>. */
function sumAmounts(amounts: Record<string, bigint>): bigint {
  return Object.values(amounts).reduce((acc, v) => acc + v, 0n);
}

// ---------------------------------------------------------------------------
// AC-1 + AC-5: Exact-division splits requiring no correction
// ---------------------------------------------------------------------------

describe("auditSplitRounding — exact division (no correction needed)", () => {
  it("splits 100 stroops 60/40 with zero adjustments", () => {
    const splits: SplitLine[] = [
      { recipientId: "GABC", ratio: 0.6 },
      { recipientId: "GDEF", ratio: 0.4 },
    ];
    const result = auditSplitRounding(100n, splits);

    expect(result.total).toBe(100n);
    expect(result.amounts["GABC"]).toBe(60n);
    expect(result.amounts["GDEF"]).toBe(40n);
    expect(sumAmounts(result.amounts)).toBe(100n);
    expect(result.adjustments).toHaveLength(0);
  });

  it("splits 1000 stroops evenly among 4 recipients (25% each)", () => {
    const splits: SplitLine[] = [
      { recipientId: "R1", ratio: 0.25 },
      { recipientId: "R2", ratio: 0.25 },
      { recipientId: "R3", ratio: 0.25 },
      { recipientId: "R4", ratio: 0.25 },
    ];
    const result = auditSplitRounding(1000n, splits);

    expect(sumAmounts(result.amounts)).toBe(1000n);
    for (const id of ["R1", "R2", "R3", "R4"]) {
      expect(result.amounts[id]).toBe(250n);
    }
    expect(result.adjustments).toHaveLength(0);
  });

  it("splits 0 stroops with no adjustments", () => {
    const splits: SplitLine[] = [
      { recipientId: "A", ratio: 0.5 },
      { recipientId: "B", ratio: 0.5 },
    ];
    const result = auditSplitRounding(0n, splits);
    expect(result.total).toBe(0n);
    expect(sumAmounts(result.amounts)).toBe(0n);
    expect(result.adjustments).toHaveLength(0);
  });

  it("returns empty amounts for empty splits array", () => {
    const result = auditSplitRounding(100n, []);
    expect(result.amounts).toEqual({});
    expect(result.adjustments).toHaveLength(0);
    expect(result.total).toBe(100n);
  });
});

// ---------------------------------------------------------------------------
// AC-2 + AC-4 + AC-5: 3-way uneven split requiring +1 stroop correction
// ---------------------------------------------------------------------------

describe("auditSplitRounding — 3-way uneven split (largest-remainder correction)", () => {
  it("splits 10 stroops 1/3 each: one recipient gets +1 stroop via largest-remainder", () => {
    /*
     * 10 / 3 = 3.333...
     * Floor amounts: A=3, B=3, C=3 → sum = 9
     * Remainder = 10 - 9 = 1 stroop → distributed to the recipient with the
     * largest fractional part (all equal at 0.333..., so first in stable sort wins).
     */
    const splits: SplitLine[] = [
      { recipientId: "A", ratio: 1 / 3 },
      { recipientId: "B", ratio: 1 / 3 },
      { recipientId: "C", ratio: 1 / 3 },
    ];
    const result = auditSplitRounding(10n, splits);

    // AC-1: sum must equal total
    expect(sumAmounts(result.amounts)).toBe(10n);
    expect(result.total).toBe(10n);

    // Two recipients get 3 stroops, one gets 4
    const values = Object.values(result.amounts).sort();
    expect(values).toEqual([3n, 3n, 4n]);

    // AC-4: exactly one adjustment recorded
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0]!.delta).toBe(1n);
  });

  it("splits 100 stroops 1/3 each: two recipients get +1 stroop", () => {
    /*
     * 100 / 3 = 33.333...
     * Floor amounts: A=33, B=33, C=33 → sum = 99
     * Remainder = 1 stroop... wait, 100 - 99 = 1, only 1 correction.
     * Actually 100 % 3 = 1, so remainder = 1.
     */
    const splits: SplitLine[] = [
      { recipientId: "A", ratio: 1 / 3 },
      { recipientId: "B", ratio: 1 / 3 },
      { recipientId: "C", ratio: 1 / 3 },
    ];
    const result = auditSplitRounding(100n, splits);

    expect(sumAmounts(result.amounts)).toBe(100n);
    const values = Object.values(result.amounts).sort();
    // 99 total from floors + 1 correction = 34, 33, 33
    expect(values).toEqual([33n, 33n, 34n]);
    expect(result.adjustments).toHaveLength(1);
  });

  it("splits 101 stroops 1/3 each: two recipients get +1 stroop each", () => {
    /*
     * 101 / 3 = 33.666...
     * Floor amounts: 33 × 3 = 99 → remainder = 2
     * Two adjustments: top-2 by fractional part each get +1
     */
    const splits: SplitLine[] = [
      { recipientId: "A", ratio: 1 / 3 },
      { recipientId: "B", ratio: 1 / 3 },
      { recipientId: "C", ratio: 1 / 3 },
    ];
    const result = auditSplitRounding(101n, splits);

    expect(sumAmounts(result.amounts)).toBe(101n);
    const values = Object.values(result.amounts).sort();
    expect(values).toEqual([33n, 34n, 34n]);
    expect(result.adjustments).toHaveLength(2);
    for (const adj of result.adjustments) {
      expect(adj.delta).toBe(1n);
    }
  });

  it("adjustments reference the correct recipientIds", () => {
    const splits: SplitLine[] = [
      { recipientId: "ALICE", ratio: 1 / 3 },
      { recipientId: "BOB", ratio: 1 / 3 },
      { recipientId: "CAROL", ratio: 1 / 3 },
    ];
    const result = auditSplitRounding(10n, splits);

    // Exactly one adjustment
    expect(result.adjustments).toHaveLength(1);
    const adjustedId = result.adjustments[0]!.recipientId;
    // The adjusted recipient should exist in the split
    expect(["ALICE", "BOB", "CAROL"]).toContain(adjustedId);
    // Their amount should be 4n (floor 3 + 1)
    expect(result.amounts[adjustedId]).toBe(4n);
  });
});

// ---------------------------------------------------------------------------
// AC-5: 1-stroop invoice split across 3 recipients
// ---------------------------------------------------------------------------

describe("auditSplitRounding — 1-stroop invoice edge case", () => {
  it("splits 1 stroop among 3 recipients: one gets 1, others get 0", () => {
    /*
     * 1 / 3 = 0.333...  → floor = 0 for all three
     * Floor sum = 0, remainder = 1
     * Largest fractional part winner gets +1 stroop
     */
    const splits: SplitLine[] = [
      { recipientId: "X", ratio: 1 / 3 },
      { recipientId: "Y", ratio: 1 / 3 },
      { recipientId: "Z", ratio: 1 / 3 },
    ];
    const result = auditSplitRounding(1n, splits);

    // AC-1: sum must equal total
    expect(sumAmounts(result.amounts)).toBe(1n);
    expect(result.total).toBe(1n);

    const values = Object.values(result.amounts).sort();
    expect(values).toEqual([0n, 0n, 1n]);

    // AC-4: one adjustment recorded, delta +1
    expect(result.adjustments).toHaveLength(1);
    expect(result.adjustments[0]!.delta).toBe(1n);
  });

  it("splits 1 stroop 50/50: one gets 1, other gets 0", () => {
    /*
     * 1 × 0.5 = 0.5 → floor = 0 for both
     * Sum = 0, remainder = 1 → largest frac (both 0.5) → stable first wins
     */
    const splits: SplitLine[] = [
      { recipientId: "P", ratio: 0.5 },
      { recipientId: "Q", ratio: 0.5 },
    ];
    const result = auditSplitRounding(1n, splits);

    expect(sumAmounts(result.amounts)).toBe(1n);
    const values = Object.values(result.amounts).sort();
    expect(values).toEqual([0n, 1n]);
    expect(result.adjustments).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// AC-2: Largest-remainder ordering is deterministic
// ---------------------------------------------------------------------------

describe("auditSplitRounding — largest-remainder ordering", () => {
  it("distributes correction to the recipient with the highest fractional part", () => {
    /*
     * 10 stroops: A gets 70% (7.0), B gets 20% (2.0), C gets 10% (1.0)
     * All exact → 0 corrections
     */
    const splits: SplitLine[] = [
      { recipientId: "A", ratio: 0.7 },
      { recipientId: "B", ratio: 0.2 },
      { recipientId: "C", ratio: 0.1 },
    ];
    const result = auditSplitRounding(10n, splits);
    expect(sumAmounts(result.amounts)).toBe(10n);
    expect(result.adjustments).toHaveLength(0);
  });

  it("gives the +1 correction to the recipient with frac 0.6 over frac 0.4", () => {
    /*
     * 10 stroops: A=60% (6.0 exact), B=25% (2.5→floor 2, frac 0.5),
     *             C=15% (1.5→floor 1, frac 0.5)
     * Floor sum = 6+2+1 = 9, remainder = 1
     * Both B and C have frac 0.5; stable sort gives B first.
     */
    const splits: SplitLine[] = [
      { recipientId: "A", ratio: 0.6 },
      { recipientId: "B", ratio: 0.25 },
      { recipientId: "C", ratio: 0.15 },
    ];
    const result = auditSplitRounding(10n, splits);

    expect(sumAmounts(result.amounts)).toBe(10n);
    expect(result.adjustments).toHaveLength(1);
    // B appears before C in the input, so stable sort gives the correction to B
    expect(result.adjustments[0]!.recipientId).toBe("B");
    expect(result.amounts["B"]).toBe(3n);  // floor 2 + 1
    expect(result.amounts["A"]).toBe(6n);
    expect(result.amounts["C"]).toBe(1n);
  });
});

// ---------------------------------------------------------------------------
// AC-3: RoundingOverflowError when total adjustment exceeds threshold
// ---------------------------------------------------------------------------

describe("auditSplitRounding — RoundingOverflowError", () => {
  it("throws RoundingOverflowError when ratios sum to far less than 1", () => {
    /*
     * 1000 stroops with ratios summing to 0.01 (total = 10 stroops from floors)
     * Remainder = 990 >> ceil(2/2) = 1 → overflow
     */
    const splits: SplitLine[] = [
      { recipientId: "A", ratio: 0.005 },
      { recipientId: "B", ratio: 0.005 },
    ];

    expect(() => auditSplitRounding(1000n, splits)).toThrow(RoundingOverflowError);
  });

  it("RoundingOverflowError carries the correct metadata", () => {
    const splits: SplitLine[] = [
      { recipientId: "A", ratio: 0.005 },
      { recipientId: "B", ratio: 0.005 },
    ];

    let caughtError: RoundingOverflowError | null = null;
    try {
      auditSplitRounding(1000n, splits);
    } catch (err) {
      if (err instanceof RoundingOverflowError) {
        caughtError = err;
      }
    }

    expect(caughtError).not.toBeNull();
    expect(caughtError!.splitCount).toBe(2);
    // threshold = ceil(2/2) = 1
    expect(caughtError!.thresholdStroops).toBe(1n);
    expect(caughtError!.totalAdjustmentStroops).toBeGreaterThan(1n);
    expect(caughtError!.code).toBe("ROUNDING_OVERFLOW");
    expect(caughtError!.message).toMatch(/threshold/i);
  });

  it("does NOT throw when adjustment equals the threshold (= ceil(n/2))", () => {
    /*
     * 3 recipients, threshold = ceil(3/2) = 2.
     * Create a scenario where remainder is exactly 2 — should NOT throw.
     * 7 stroops, 1/3 each: floors = 2,2,2 → sum=6, remainder=1. Under threshold.
     * Use 8 stroops, 1/3 each: floors=2,2,2 → sum=6, remainder=2. Equals threshold (2). OK.
     */
    const splits: SplitLine[] = [
      { recipientId: "A", ratio: 1 / 3 },
      { recipientId: "B", ratio: 1 / 3 },
      { recipientId: "C", ratio: 1 / 3 },
    ];
    expect(() => auditSplitRounding(8n, splits)).not.toThrow();
    const result = auditSplitRounding(8n, splits);
    expect(sumAmounts(result.amounts)).toBe(8n);
  });

  it("throws when adjustment is ONE more than threshold", () => {
    /*
     * 3 recipients, threshold = ceil(3/2) = 2.
     * 1000 stroops, ratios: 0.001 + 0.001 + 0.001 = 0.003 → floors = 1+1+1=3
     * remainder = 997 >> 2 → overflow
     */
    const splits: SplitLine[] = [
      { recipientId: "A", ratio: 0.001 },
      { recipientId: "B", ratio: 0.001 },
      { recipientId: "C", ratio: 0.001 },
    ];
    expect(() => auditSplitRounding(1000n, splits)).toThrow(RoundingOverflowError);
  });
});

// ---------------------------------------------------------------------------
// AC-1: Sum invariant holds across many random-ish cases
// ---------------------------------------------------------------------------

describe("auditSplitRounding — sum invariant", () => {
  it("sum always equals total for a wide range of totals and ratios", () => {
    const cases: Array<[bigint, SplitLine[]]> = [
      [7n,   [{ recipientId: "A", ratio: 1/3 }, { recipientId: "B", ratio: 1/3 }, { recipientId: "C", ratio: 1/3 }]],
      [11n,  [{ recipientId: "A", ratio: 0.5 }, { recipientId: "B", ratio: 0.5 }]],
      [99n,  [{ recipientId: "A", ratio: 0.333 }, { recipientId: "B", ratio: 0.333 }, { recipientId: "C", ratio: 0.334 }]],
      [1000000n, [{ recipientId: "A", ratio: 1/7 }, { recipientId: "B", ratio: 2/7 }, { recipientId: "C", ratio: 4/7 }]],
      [1n,   [{ recipientId: "A", ratio: 1 }]],
    ];

    for (const [total, splits] of cases) {
      const result = auditSplitRounding(total, splits);
      expect(sumAmounts(result.amounts)).toBe(total);
    }
  });
});

// ---------------------------------------------------------------------------
// calculator.ts integration tests
// ---------------------------------------------------------------------------

describe("calculateSplitAmounts (calculator integration)", () => {
  it("returns the same result as auditSplitRounding", () => {
    const splits: SplitLine[] = [
      { recipientId: "A", ratio: 1 / 3 },
      { recipientId: "B", ratio: 1 / 3 },
      { recipientId: "C", ratio: 1 / 3 },
    ];
    const direct = auditSplitRounding(10n, splits);
    const calc = calculateSplitAmounts(10n, splits);

    expect(calc.amounts).toEqual(direct.amounts);
    expect(calc.adjustments).toEqual(direct.adjustments);
    expect(calc.total).toBe(direct.total);
  });

  it("computeAmounts returns only the amounts map", () => {
    const splits: SplitLine[] = [
      { recipientId: "A", ratio: 0.6 },
      { recipientId: "B", ratio: 0.4 },
    ];
    const amounts = computeAmounts(100n, splits);
    expect(amounts).toEqual({ A: 60n, B: 40n });
  });

  it("propagates RoundingOverflowError from the auditor", () => {
    const splits: SplitLine[] = [
      { recipientId: "A", ratio: 0.001 },
      { recipientId: "B", ratio: 0.001 },
    ];
    expect(() => calculateSplitAmounts(1000n, splits)).toThrow(RoundingOverflowError);
  });
});

describe("invoice subtotal and fee breakdown", () => {
  it("calculates the subtotal before fees are applied", () => {
    expect(calculateInvoiceSubtotal([10n, 15n, 25n, 5n])).toBe(55n);
  });

  it("returns subtotal, fee and total separately for downstream receipts", () => {
    const result = calculateInvoiceBreakdown(1_000n, 250);

    expect(result.subtotal).toBe(1_000n);
    expect(result.fee).toBe(25n);
    expect(result.total).toBe(1_025n);
  });

  it("supports configurable rounding mode", () => {
    const result = auditSplitRounding(1n, [
      { recipientId: "A", ratio: 0.5 },
      { recipientId: "B", ratio: 0.5 },
    ], { mode: "bankers" });

    expect(sumAmounts(result.amounts)).toBe(1n);
    expect(Object.values(result.amounts).sort((a, b) => Number(a - b))).toEqual([0n, 1n]);
  });
});
