import { describe, expect, it } from "vitest";
import { formatSplitPercentage } from "../../src/invoice/calculator.js";
import { SdkError, SdkErrorCode } from "../../src/errors.js";

describe("formatSplitPercentage", () => {
  it("formats 3333 basis points as 33.33%", () => {
    expect(formatSplitPercentage(3333n)).toBe("33.33%");
  });

  it("formats 10000 basis points as 100.00%", () => {
    expect(formatSplitPercentage(10000n)).toBe("100.00%");
  });

  it("formats 1 basis point as 0.01%", () => {
    expect(formatSplitPercentage(1n)).toBe("0.01%");
  });

  it("formats 0 basis points as 0.00%", () => {
    expect(formatSplitPercentage(0n)).toBe("0.00%");
  });

  it("supports 0 decimals", () => {
    expect(formatSplitPercentage(3333n, { decimals: 0 })).toBe("33%");
  });

  it("rounds up at the last displayed decimal place", () => {
    // 6667 bps = 66.67% exactly, 66.7% with one decimal place (rounds up from 66.66...)
    expect(formatSplitPercentage(6666n, { decimals: 1 })).toBe("66.7%");
  });

  it("supports up to 4 decimal places", () => {
    expect(formatSplitPercentage(3333n, { decimals: 4 })).toBe("33.3300%");
  });

  it("throws SdkError for negative basis points", () => {
    expect(() => formatSplitPercentage(-1n)).toThrow(SdkError);
    expect(() => formatSplitPercentage(-1n)).toThrow(SdkErrorCode.INVALID_RECIPIENT);
  });

  it("throws SdkError for basis points above 10000", () => {
    expect(() => formatSplitPercentage(10001n)).toThrow(SdkError);
    expect(() => formatSplitPercentage(10001n)).toThrow(SdkErrorCode.INVALID_RECIPIENT);
  });

  it("throws RangeError for decimals below 0", () => {
    expect(() => formatSplitPercentage(3333n, { decimals: -1 })).toThrow(RangeError);
  });

  it("throws RangeError for decimals above 4", () => {
    expect(() => formatSplitPercentage(3333n, { decimals: 5 })).toThrow(RangeError);
  });

  it("throws RangeError for non-integer decimals", () => {
    expect(() => formatSplitPercentage(3333n, { decimals: 2.5 })).toThrow(RangeError);
  });
});
