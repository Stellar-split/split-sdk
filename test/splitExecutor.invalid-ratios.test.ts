import { afterEach, describe, expect, it, vi } from "vitest";
import { checkSubentryCapacity } from "../src/account/subentryGuard.js";
import {
  splitExecutor,
  SplitRatioSumError,
  SPLIT_RATIO_TOLERANCE,
  validateSplitRatioSum,
  type SplitRecipient,
} from "../src/payments/splitExecutor.js";

vi.mock("../src/account/subentryGuard.js", () => ({
  checkSubentryCapacity: vi.fn().mockResolvedValue({ available: 1, limit: 1 }),
  SubentryCapacityGuardError: class SubentryCapacityGuardError extends Error {},
}));

const A = "GABC00000000000000000000000000000000000000000000000000AA";
const B = "GDEF00000000000000000000000000000000000000000000000000BB";

const r = (address: string, ratio?: unknown): SplitRecipient => ({
  address,
  amount: 1_000_000n,
  ...(ratio === undefined ? {} : { ratio: ratio as number }),
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("validateSplitRatioSum hostile runtime inputs", () => {
  it("rejects out-of-range ratios even when their aggregate equals 1", () => {
    expect(() => validateSplitRatioSum([r(A, -1), r(B, 2)])).toThrow(
      SplitRatioSumError,
    );
  });

  it.each([
    ["NaN", Number.NaN, 1],
    ["positive infinity", Number.POSITIVE_INFINITY, 0],
    ["opposing infinities", Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY],
  ])("rejects non-finite %s ratios", (_label, a, b) => {
    expect(() => validateSplitRatioSum([r(A, a), r(B, b)])).toThrow(
      SplitRatioSumError,
    );
  });

  it.each([
    ["explicit null", null, 1],
    ["numeric string", "0.5", 0.5],
    ["boolean", true, 0],
  ])("rejects %s instead of treating it as an omitted numeric ratio", (_label, a, b) => {
    expect(() => validateSplitRatioSum([r(A, a), r(B, b)])).toThrow(
      SplitRatioSumError,
    );
  });

  it("accepts zero and one at the allowed boundaries", () => {
    expect(validateSplitRatioSum([r(A, 0), r(B, 1)])).toBe(1);
  });

  it("preserves omitted-ratio contribution as zero once ratio mode is active", () => {
    expect(validateSplitRatioSum([r(A, 1), r(B)])).toBe(1);
  });

  it("preserves the floating-point tolerance", () => {
    const actual = validateSplitRatioSum([
      r(A, 0.7),
      r(B, 0.2),
      r("GC", 0.1),
    ]);

    expect(Math.abs(actual - 1)).toBeLessThanOrEqual(SPLIT_RATIO_TOLERANCE);
  });

  it("preserves SplitRatioSumError fields for an under-allocated split", () => {
    try {
      validateSplitRatioSum([r(A, 0.5), r(B, 0.4)]);
      throw new Error("expected ratio validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SplitRatioSumError);
      expect(error).toMatchObject({
        code: "SPLIT_RATIO_SUM_INVALID",
        actualSum: 0.9,
        expectedSum: 1,
        tolerance: SPLIT_RATIO_TOLERANCE,
      });
    }
  });

  it("reports NaN actualSum for a malformed runtime ratio that has no numeric total", () => {
    try {
      validateSplitRatioSum([r(A, null), r(B, 1)]);
      throw new Error("expected runtime ratio validation to fail");
    } catch (error) {
      expect(error).toBeInstanceOf(SplitRatioSumError);
      expect(Number.isNaN((error as SplitRatioSumError).actualSum)).toBe(true);
    }
  });
});

describe("splitExecutor ratio pre-flight", () => {
  it.each([
    ["out-of-range aggregate", -1, 2],
    ["explicit null", null, 1],
    ["numeric string", "0.5", 0.5],
    ["NaN", Number.NaN, 1],
  ])("rejects %s before capacity work", async (_label, a, b) => {
    await expect(splitExecutor([r(A, a), r(B, b)])).rejects.toBeInstanceOf(
      SplitRatioSumError,
    );
    expect(checkSubentryCapacity).not.toHaveBeenCalled();
  });

  it("leaves amount-only splits unaffected", async () => {
    const result = await splitExecutor([r(A), r(B)], {
      skipCapacityCheck: true,
    });

    expect(result.success).toBe(true);
    expect(checkSubentryCapacity).not.toHaveBeenCalled();
  });
});
