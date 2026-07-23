import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { Keypair } from "@stellar/stellar-sdk";
import {
  formatAmount,
  parseAmount,
  isValidStellarAddress,
  deadlineFromDays,
  isExpired,
  truncateAddress,
} from "../src/utils.js";
import type { InvoiceStatus } from "../src/types.js";

const STATUSES: InvoiceStatus[] = ["Pending", "Released", "Refunded", "Cancelled"];
const VALID_ADDRESSES = Array.from({ length: 50 }, () => Keypair.random().publicKey());

describe("StellarSplitClient sequential call invariants (property-based)", () => {
  it("parseAmount is inverse of formatAmount for all valid stroops", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 50_000_000_000_000n }),
        (stroops) => {
          const formatted = formatAmount(stroops);
          const parsed = parseAmount(formatted);
          expect(parsed).toBe(stroops);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("formatAmount(parseAmount(s)) is idempotent for 7-decimal strings", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 1_000_000_000_000n }),
        (stroops) => {
          const formatted = formatAmount(stroops);
          const reformatted = formatAmount(parseAmount(formatted));
          expect(reformatted).toBe(formatted);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("isValidStellarAddress is consistent across repeated calls", () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_ADDRESSES), (address) => {
        const first = isValidStellarAddress(address);
        const second = isValidStellarAddress(address);
        expect(second).toBe(first);
      }),
      { numRuns: 500 },
    );
  });

  it("truncateAddress preserves prefix and suffix", () => {
    fc.assert(
      fc.property(
        fc.constantFrom(...VALID_ADDRESSES),
        fc.integer({ min: 1, max: 10 }),
        (address, chars) => {
          const truncated = truncateAddress(address, chars);
          expect(truncated.startsWith(address.slice(0, chars))).toBe(true);
          expect(truncated.endsWith(address.slice(-chars))).toBe(true);
          expect(truncated).toContain("...");
        },
      ),
      { numRuns: 500 },
    );
  });

  it("truncateAddress returns original string if too short", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 10 }),
        fc.integer({ min: 1, max: 10 }),
        (short, chars) => {
          fc.pre(short.length <= chars * 2 + 3);
          expect(truncateAddress(short, chars)).toBe(short);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("deadlineFromDays is deterministic for same input", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3650 }),
        (days) => {
          const first = deadlineFromDays(days);
          const second = deadlineFromDays(days);
          expect(second).toBe(first);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("isExpired is consistent: if deadline < now, always expired", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3650 }),
        (daysAgo) => {
          const now = Math.floor(Date.now() / 1000);
          const past = now - daysAgo * 86400;
          expect(isExpired(past)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("all invoice statuses are valid string literals", () => {
    for (const status of STATUSES) {
      expect(typeof status).toBe("string");
      expect(["Pending", "Released", "Refunded", "Cancelled"]).toContain(status);
    }
  });

  it("formatAmount output length is consistent across inputs", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 0n, max: 10_000_000_000n }),
        (stroops) => {
          const formatted = formatAmount(stroops);
          const dotIndex = formatted.indexOf(".");
          expect(dotIndex).toBeGreaterThan(0);
          expect(formatted.length - dotIndex - 1).toBe(7);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("parseAmount of negative-looking string returns negative bigint", () => {
    fc.assert(
      fc.property(
        fc.bigInt({ min: 1n, max: 1_000_000_000n }),
        (positive) => {
          const negativeStr = `-${positive}`;
          const result = parseAmount(negativeStr);
          expect(result).toBeLessThan(0n);
        },
      ),
      { numRuns: 500 },
    );
  });
});
