import { describe, expect, it } from "vitest";
import { validateSplitTotal, normalizeSplits } from "../src/validators/splitRatioValidator.js";
import { StellarSplitError } from "../src/errors.js";

describe("validateSplitTotal", () => {
  it("passes when splits sum to the default total (10000n)", () => {
    expect(() => validateSplitTotal([5000n, 3000n, 2000n])).not.toThrow();
  });

  it("passes when splits sum to a custom total", () => {
    expect(() => validateSplitTotal([1000n, 2000n, 3000n], 6000n)).not.toThrow();
  });

  it("throws when splits do not sum to the expected total", () => {
    expect(() => validateSplitTotal([5000n, 3000n, 1999n])).toThrow(StellarSplitError);
  });

  it("throws with INVALID_RECIPIENT code when sum mismatches", () => {
    try {
      validateSplitTotal([5000n, 3000n, 1999n]);
      expect.unreachable("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(StellarSplitError);
      expect((e as StellarSplitError).code).toBe("INVALID_RECIPIENT");
      expect((e as StellarSplitError).message).toContain("splits must sum to 10000 basis points");
    }
  });

  it("throws when given an empty array", () => {
    expect(() => validateSplitTotal([])).toThrow(StellarSplitError);
  });
});

describe("normalizeSplits", () => {
  it("returns a copy when amounts already sum to total", () => {
    const amounts = [3000n, 4000n, 3000n];
    const result = normalizeSplits(amounts, 10000n);
    expect(result).toEqual([3000n, 4000n, 3000n]);
    // Should not mutate the original
    expect(result).not.toBe(amounts);
  });

  it("distributes remainder to the last element", () => {
    const amounts = [3333n, 3333n, 3333n];
    const result = normalizeSplits(amounts, 10000n);
    // Last element gets the remainder: 3333 + (10000 - 9999) = 3334
    expect(result).toEqual([3333n, 3333n, 3334n]);
    expect(result.reduce((a, b) => a + b, 0n)).toBe(10000n);
  });

  it("handles negative remainder (over-sum)", () => {
    const amounts = [5000n, 5000n, 1000n];
    const result = normalizeSplits(amounts, 10000n);
    // Last element gets the remainder: 1000 + (10000 - 11000) = 0
    expect(result).toEqual([5000n, 5000n, 0n]);
    expect(result.reduce((a, b) => a + b, 0n)).toBe(10000n);
  });

  it("round-trip: normalizeSplits always sums to total", () => {
    for (const amounts of [
      [1n, 2n, 3n],
      [100n, 200n, 300n, 400n],
      [9999n, 1n],
      [5000n, 5000n],
    ]) {
      const result = normalizeSplits(amounts, 10000n);
      const sum = result.reduce((a, b) => a + b, 0n);
      expect(sum).toBe(10000n);
    }
  });
});