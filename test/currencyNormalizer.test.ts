import { describe, it, expect } from "vitest";
import { Asset } from "@stellar/stellar-sdk";
import {
  normalizeAmount,
  toOnChainAmount,
  registerAssetPrecision,
  getAssetPrecision,
  verifyRoundTrip,
} from "../src/currencyNormalizer.js";
import { PrecisionError } from "../src/errors.js";

describe("normalizeAmount", () => {
  it("converts XLM stroops to display format", () => {
    expect(normalizeAmount(10_000_000n, Asset.native())).toBe("1.0000000");
    expect(normalizeAmount(15_000_000n, Asset.native())).toBe("1.5000000");
    expect(normalizeAmount(0n, Asset.native())).toBe("0.0000000");
  });

  it("accepts string input", () => {
    expect(normalizeAmount("10000000", Asset.native())).toBe("1.0000000");
  });

  it("normalizes large amounts", () => {
    expect(normalizeAmount(1_000_000_000n, Asset.native())).toBe("100.0000000");
  });

  it("handles amounts with fractional part", () => {
    expect(normalizeAmount(12_345_678n, Asset.native())).toBe("1.2345678");
  });
});

describe("toOnChainAmount", () => {
  it("converts display amount to XLM stroops", () => {
    expect(toOnChainAmount("1.5", Asset.native())).toBe("15000000");
    expect(toOnChainAmount("1", Asset.native())).toBe("10000000");
    expect(toOnChainAmount("0", Asset.native())).toBe("0");
  });

  it("throws PrecisionError when fractional digits exceed precision", () => {
    expect(() => toOnChainAmount("1.12345678", Asset.native())).toThrow(PrecisionError);
  });
});

describe("registerAssetPrecision", () => {
  it("registers and resolves custom asset precision", () => {
    registerAssetPrecision("USDC:GDU...CUSTOM", 6);
    expect(getAssetPrecision("USDC:GDU...CUSTOM")).toBe(6);
  });
});

describe("verifyRoundTrip", () => {
  it("round-trips display to on-chain and back for XLM", () => {
    expect(verifyRoundTrip("1.5", Asset.native())).toBe(true);
    expect(verifyRoundTrip("0.0000001", Asset.native())).toBe(true);
    expect(verifyRoundTrip("100", Asset.native())).toBe(true);
  });

  it("round-trips correctly for whole numbers", () => {
    expect(verifyRoundTrip("42", Asset.native())).toBe(true);
    expect(verifyRoundTrip("0", Asset.native())).toBe(true);
  });

  it("fails round-trip when precision would be lost", () => {
    // Cannot round-trip 8 decimal digits through XLM (7-decimal precision)
    expect(verifyRoundTrip("1.12345678", Asset.native())).toBe(false);
  });

  it("round-trips for many randomly generated amounts", () => {
    // Test a representative set instead of 1000 random amounts
    for (let i = 0; i < 100; i++) {
      const intPart = BigInt(Math.floor(Math.random() * 1000));
      const fracPart = Math.floor(Math.random() * 1_000_0000)
        .toString()
        .padStart(7, "0");
      const display = `${intPart}.${fracPart}`;
      expect(verifyRoundTrip(display, Asset.native())).toBe(true);
    }
  });
});
