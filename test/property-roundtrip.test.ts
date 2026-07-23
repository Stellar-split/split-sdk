import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { formatAmount, parseAmount } from "../src/utils.js";

const STROOPS_PER_UNIT = 10_000_000n;

describe("parseAmount / formatAmount roundtrip (property-based)", () => {
  it("parseAmount(formatAmount(s)) === s for all non-negative bigint stroops", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 100_000_000_000_000n }),
        (stroops) => {
          const formatted = formatAmount(stroops);
          const parsed = parseAmount(formatted);
          expect(parsed).toBe(stroops);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("formatAmount always produces exactly 7 decimal places", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        (stroops) => {
          const formatted = formatAmount(stroops);
          const parts = formatted.split(".");
          expect(parts).toHaveLength(2);
          expect(parts[1]).toHaveLength(7);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("formatAmount produces a valid number string", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        (stroops) => {
          const formatted = formatAmount(stroops);
          expect(Number(formatted)).not.toBeNaN();
          expect(Number(formatted)).toBeGreaterThanOrEqual(0);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("parseAmount of formatAmount with trailing zeros roundtrips", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000_000_000n }),
        fc.integer({ min: 0, max: 6 }),
        (stroops, extraZeros) => {
          const formatted = formatAmount(stroops);
          const withZeros = formatted + "0".repeat(extraZeros);
          const parsed = parseAmount(withZeros);
          expect(parsed).toBe(stroops);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("parseAmount of integer string equals stroops", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000_000n }),
        (whole) => {
          const parsed = parseAmount(whole.toString());
          expect(parsed).toBe(whole * STROOPS_PER_UNIT);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("parseAmount of '0' always returns 0n", () => {
    expect(parseAmount("0")).toBe(0n);
    expect(parseAmount("0.0")).toBe(0n);
    expect(parseAmount("0.0000000")).toBe(0n);
  });

  it("formatAmount(0n) is '0.0000000'", () => {
    expect(formatAmount(0n)).toBe("0.0000000");
  });

  it("formatAmount is monotonic for positive stroops", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 50_000_000_000n }),
        (stroops) => {
          const a = formatAmount(stroops);
          const b = formatAmount(stroops + 1n);
          expect(Number(a)).toBeLessThan(Number(b));
        },
      ),
      { numRuns: 500 },
    );
  });
});
