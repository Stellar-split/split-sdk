/**
 * Unit tests for #545 — generateSplitDiff
 */
import { describe, it, expect } from "vitest";
import { generateSplitDiff } from "../src/splitPreview.js";
import type { SplitConfig } from "../src/validators/splitRatioValidator.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function config(...entries: Array<{ address: string; share: number }>): SplitConfig {
  return { shares: entries };
}

const ALICE = "GALIC3ABCDEFGHIJKLMNOPQRSTUVWXYZ012345678901234567";
const BOB   = "GBOBZABCDEFGHIJKLMNOPQRSTUVWXYZ012345678901234567";
const CAROL = "GCAROLABCDEFGHIJKLMNOPQRSTUVWXYZ01234567890123456";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("generateSplitDiff", () => {
  it("returns an empty diff when the configs are identical", () => {
    const original = config(
      { address: ALICE, share: 0.5 },
      { address: BOB, share: 0.5 },
    );
    const diff = generateSplitDiff(original, original);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.totalRatioDelta).toBeCloseTo(0);
  });

  it("identifies a single recipient added in the revised config", () => {
    const original = config({ address: ALICE, share: 1.0 });
    const revised = config(
      { address: ALICE, share: 0.5 },
      { address: BOB, share: 0.5 },
    );
    const diff = generateSplitDiff(original, revised);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]!.address).toBe(BOB);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.accountId).toBe(ALICE);
    expect(diff.changed[0]!.oldRatio).toBeCloseTo(1.0);
    expect(diff.changed[0]!.newRatio).toBeCloseTo(0.5);
    expect(diff.totalRatioDelta).toBeCloseTo(0);
  });

  it("identifies a single recipient removed from the original config", () => {
    const original = config(
      { address: ALICE, share: 0.6 },
      { address: BOB, share: 0.4 },
    );
    const revised = config({ address: ALICE, share: 1.0 });
    const diff = generateSplitDiff(original, revised);

    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]!.address).toBe(BOB);
    expect(diff.added).toHaveLength(0);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0]!.accountId).toBe(ALICE);
    expect(diff.changed[0]!.oldRatio).toBeCloseTo(0.6);
    expect(diff.changed[0]!.newRatio).toBeCloseTo(1.0);
    expect(diff.totalRatioDelta).toBeCloseTo(0);
  });

  it("identifies ratio rebalance (no adds or removes, only changed)", () => {
    const original = config(
      { address: ALICE, share: 0.5 },
      { address: BOB, share: 0.5 },
    );
    const revised = config(
      { address: ALICE, share: 0.7 },
      { address: BOB, share: 0.3 },
    );
    const diff = generateSplitDiff(original, revised);

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(2);

    const aliceChange = diff.changed.find((c) => c.accountId === ALICE)!;
    expect(aliceChange.oldRatio).toBeCloseTo(0.5);
    expect(aliceChange.newRatio).toBeCloseTo(0.7);

    const bobChange = diff.changed.find((c) => c.accountId === BOB)!;
    expect(bobChange.oldRatio).toBeCloseTo(0.5);
    expect(bobChange.newRatio).toBeCloseTo(0.3);

    // Valid rebalance — delta should be 0
    expect(diff.totalRatioDelta).toBeCloseTo(0);
  });

  it("handles simultaneous add and remove correctly", () => {
    const original = config(
      { address: ALICE, share: 0.5 },
      { address: BOB, share: 0.5 },
    );
    const revised = config(
      { address: ALICE, share: 0.5 },
      { address: CAROL, share: 0.5 },
    );
    const diff = generateSplitDiff(original, revised);

    expect(diff.added).toHaveLength(1);
    expect(diff.added[0]!.address).toBe(CAROL);

    expect(diff.removed).toHaveLength(1);
    expect(diff.removed[0]!.address).toBe(BOB);

    expect(diff.changed).toHaveLength(0);
    expect(diff.totalRatioDelta).toBeCloseTo(0);
  });

  it("computes correct totalRatioDelta when revised shares do not sum to 1", () => {
    const original = config({ address: ALICE, share: 1.0 });
    const revised = config(
      { address: ALICE, share: 0.6 },
      { address: BOB, share: 0.6 },
    );
    const diff = generateSplitDiff(original, revised);

    // revisedSum = 1.2, originalSum = 1.0 → delta = +0.2
    expect(diff.totalRatioDelta).toBeCloseTo(0.2);
  });

  it("returns empty diff for two empty configs", () => {
    const diff = generateSplitDiff({ shares: [] }, { shares: [] });

    expect(diff.added).toHaveLength(0);
    expect(diff.removed).toHaveLength(0);
    expect(diff.changed).toHaveLength(0);
    expect(diff.totalRatioDelta).toBeCloseTo(0);
  });
});
