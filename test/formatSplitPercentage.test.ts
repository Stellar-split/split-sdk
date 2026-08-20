/**
 * Tests for formatSplitPercentage — Issue #620
 *
 * Acceptance criteria covered:
 *  AC-1: formatSplitPercentage(basisPoints, opts?) exported from src/invoice/calculator.ts
 *  AC-2: Converts basis points to percentage: 3333n → "33.33%", 10000n → "100.00%", 1n → "0.01%"
 *  AC-3: opts.decimals controls decimal places (default: 2); must be 0–4 inclusive
 *  AC-4: Out-of-range basisPoints (< 0n or > 10000n) throws StellarSplitError with INVALID_RECIPIENT code
 *  AC-5: Out-of-range decimals throws RangeError
 *  AC-6: Exported from src/index.ts
 *  AC-7: Unit tests: 3333n → "33.33%", 10000n → "100.00%", 1n → "0.01%", 0 decimals → "33%",
 *        negative throws, >10000 throws
 */

import { describe, it, expect } from "vitest";
import { formatSplitPercentage } from "../src/invoice/calculator.js";
import { formatSplitPercentage as formatSplitPercentageIndex } from "../src/index.js";
import { StellarSplitError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// AC-1: exported from calculator.ts
// ---------------------------------------------------------------------------

describe("formatSplitPercentage — basics (AC-1, AC-2)", () => {
  it("returns a string with % suffix", () => {
    expect(typeof formatSplitPercentage(5000n)).toBe("string");
    expect(formatSplitPercentage(5000n).endsWith("%")).toBe(true);
  });

  it("converts basis points to percentage — 3333n → 33.33%", () => {
    expect(formatSplitPercentage(3333n)).toBe("33.33%");
  });

  it("converts basis points to percentage — 10000n → 100.00%", () => {
    expect(formatSplitPercentage(10000n)).toBe("100.00%");
  });

  it("converts basis points to percentage — 1n → 0.01%", () => {
    expect(formatSplitPercentage(1n)).toBe("0.01%");
  });

  it("converts basis points to percentage — 0n → 0.00%", () => {
    expect(formatSplitPercentage(0n)).toBe("0.00%");
  });

  it("converts basis points to percentage — 5000n → 50.00%", () => {
    expect(formatSplitPercentage(5000n)).toBe("50.00%");
  });

  it("rounds fractional part correctly — 9999n → 99.99%", () => {
    expect(formatSplitPercentage(9999n)).toBe("99.99%");
  });
});

// ---------------------------------------------------------------------------
// AC-3: decimals option (0–4, default 2)
// ---------------------------------------------------------------------------

describe("formatSplitPercentage — decimals option (AC-3)", () => {
  it("uses 2 decimal places by default", () => {
    expect(formatSplitPercentage(3333n)).toBe("33.33%");
  });

  it("supports 0 decimals — 3333n → 33%", () => {
    expect(formatSplitPercentage(3333n, { decimals: 0 })).toBe("33%");
  });

  it("supports 1 decimal — 3333n → 33.3%", () => {
    expect(formatSplitPercentage(3333n, { decimals: 1 })).toBe("33.3%");
  });

  it("supports 3 decimals — 3333n → 33.330%", () => {
    expect(formatSplitPercentage(3333n, { decimals: 3 })).toBe("33.330%");
  });

  it("supports 4 decimals — 3333n → 33.3300%", () => {
    expect(formatSplitPercentage(3333n, { decimals: 4 })).toBe("33.3300%");
  });

  it("supports 0 decimals on a round percentage — 10000n → 100%", () => {
    expect(formatSplitPercentage(10000n, { decimals: 0 })).toBe("100%");
  });

  it("supports 0 decimals on a tiny percentage — 1n → 0%", () => {
    expect(formatSplitPercentage(1n, { decimals: 0 })).toBe("0%");
  });
});

// ---------------------------------------------------------------------------
// AC-4: out-of-range basisPoints throws StellarSplitError
// ---------------------------------------------------------------------------

describe("formatSplitPercentage — range validation (AC-4)", () => {
  it("throws StellarSplitError for negative basis points", () => {
    expect(() => formatSplitPercentage(-1n)).toThrow(StellarSplitError);
  });

  it("throws StellarSplitError with INVALID_RECIPIENT code for negative basis points", () => {
    try {
      formatSplitPercentage(-1n);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StellarSplitError);
      expect((err as StellarSplitError).code).toBe("INVALID_RECIPIENT");
    }
  });

  it("throws StellarSplitError for basis points above 10000", () => {
    expect(() => formatSplitPercentage(10001n)).toThrow(StellarSplitError);
  });

  it("throws StellarSplitError with INVALID_RECIPIENT code for > 10000", () => {
    try {
      formatSplitPercentage(10001n);
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(StellarSplitError);
      expect((err as StellarSplitError).code).toBe("INVALID_RECIPIENT");
    }
  });

  it("accepts boundary values 0n and 10000n without throwing", () => {
    expect(() => formatSplitPercentage(0n)).not.toThrow();
    expect(() => formatSplitPercentage(10000n)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-5: out-of-range decimals throws RangeError
// ---------------------------------------------------------------------------

describe("formatSplitPercentage — decimals validation (AC-5)", () => {
  it("throws RangeError for decimals < 0", () => {
    expect(() => formatSplitPercentage(3333n, { decimals: -1 })).toThrow(RangeError);
  });

  it("throws RangeError for decimals > 4", () => {
    expect(() => formatSplitPercentage(3333n, { decimals: 5 })).toThrow(RangeError);
  });

  it("does not throw for decimals = 4", () => {
    expect(() => formatSplitPercentage(3333n, { decimals: 4 })).not.toThrow();
  });

  it("does not throw for decimals = 0", () => {
    expect(() => formatSplitPercentage(3333n, { decimals: 0 })).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// AC-6: exported from public API (src/index.ts)
// ---------------------------------------------------------------------------

describe("formatSplitPercentage — public API export (AC-6)", () => {
  it("is exported from src/index.ts", () => {
    expect(typeof formatSplitPercentageIndex).toBe("function");
  });

  it("behaves identically through the public API", () => {
    expect(formatSplitPercentageIndex(3333n)).toBe("33.33%");
    expect(formatSplitPercentageIndex(10000n)).toBe("100.00%");
    expect(formatSplitPercentageIndex(1n)).toBe("0.01%");
  });
});