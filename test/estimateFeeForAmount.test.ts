import { describe, expect, it } from "vitest";
import { estimateFeeForAmount, type FeeStats } from "../src/feeEstimator.js";
import { StellarSplitError } from "../src/errors.js";

const defaultStats: FeeStats = {
  baseFee: 100n,
  p50Fee: 100n,
  p99Fee: 250n,
};

describe("estimateFeeForAmount", () => {
  it("calculates fee and total for a known amount", () => {
    const result = estimateFeeForAmount(10_000n, defaultStats);
    expect(result.feeLumens).toBe(100n);
    expect(result.totalWithFee).toBe(10_100n);
    expect(result.feePercent).toBeCloseTo(1, 5); // 100/10000*100 = 1%
  });

  it("keeps feeLumens as bigint", () => {
    const result = estimateFeeForAmount(10n, defaultStats);
    expect(typeof result.feeLumens).toBe("bigint");
    expect(typeof result.totalWithFee).toBe("bigint");
  });

  it("returns 0 percent for zero amount", () => {
    const result = estimateFeeForAmount(0n, defaultStats);
    expect(result.feeLumens).toBe(100n);
    expect(result.totalWithFee).toBe(100n);
    expect(result.feePercent).toBe(0);
  });

  it("throws INVALID_RECIPIENT for negative amount", () => {
    try {
      estimateFeeForAmount(-1n, defaultStats);
      expect.unreachable("expected throw");
    } catch (err) {
      expect(err).toBeInstanceOf(StellarSplitError);
      expect((err as StellarSplitError).code).toBe("INVALID_RECIPIENT");
    }
  });

  it("handles a larger base fee", () => {
    const stats: FeeStats = { baseFee: 500n, p50Fee: 400n, p99Fee: 1500n };
    const result = estimateFeeForAmount(50_000n, stats);
    expect(result.feeLumens).toBe(500n);
    expect(result.totalWithFee).toBe(50_500n);
    expect(result.feePercent).toBe(1);
  });
});