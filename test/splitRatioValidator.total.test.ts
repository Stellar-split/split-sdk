import { describe, it, expect } from "vitest";
import {
  validateSplitTotal,
  normalizeSplits,
} from "../src/validators/splitRatioValidator.js";
import { SdkError, SdkErrorCode } from "../src/errors.js";

describe("validateSplitTotal", () => {
  it("passes when splits sum exactly to the default total (10000n)", () => {
    expect(() => validateSplitTotal([3000n, 3000n, 4000n])).not.toThrow();
  });

  it("passes when splits sum exactly to a custom total", () => {
    expect(() => validateSplitTotal([500n, 500n], 1000n)).not.toThrow();
  });

  it("throws SdkError with code INVALID_RECIPIENT when off by one", () => {
    expect(() => validateSplitTotal([3000n, 3000n, 3999n])).toThrow(SdkError);
    try {
      validateSplitTotal([3000n, 3000n, 3999n]);
      throw new Error("expected validateSplitTotal to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SdkError);
      expect((err as SdkError).code).toBe(SdkErrorCode.INVALID_RECIPIENT);
      expect((err as SdkError).message).toBe(
        "splits must sum to 10000 basis points",
      );
    }
  });

  it("throws SdkError with code INVALID_RECIPIENT for an empty array", () => {
    expect(() => validateSplitTotal([])).toThrow(SdkError);
    try {
      validateSplitTotal([]);
      throw new Error("expected validateSplitTotal to throw");
    } catch (err) {
      expect(err).toBeInstanceOf(SdkError);
      expect((err as SdkError).code).toBe(SdkErrorCode.INVALID_RECIPIENT);
    }
  });
});

describe("normalizeSplits", () => {
  it("round-trips: normalized amounts sum exactly to total", () => {
    const amounts = [3333n, 3333n, 3333n];
    const total = 10000n;
    const normalized = normalizeSplits(amounts, total);

    const sum = normalized.reduce((acc, v) => acc + v, 0n);
    expect(sum).toBe(total);
    expect(() => validateSplitTotal(normalized, total)).not.toThrow();
  });

  it("distributes the rounding remainder to the last recipient", () => {
    const amounts = [3333n, 3333n, 3333n];
    const normalized = normalizeSplits(amounts, 10000n);

    expect(normalized[0]).toBe(3333n);
    expect(normalized[1]).toBe(3333n);
    expect(normalized[2]).toBe(3334n);
  });

  it("returns an empty array unchanged", () => {
    expect(normalizeSplits([], 10000n)).toEqual([]);
  });
});
