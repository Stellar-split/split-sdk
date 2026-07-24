import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { deadlineFromDays, isExpired } from "../src/utils.js";

describe("deadlineFromDays (property-based)", () => {
  it("returns a timestamp in the future for positive day counts", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 36500 }),
        (days) => {
          const now = Math.floor(Date.now() / 1000);
          const deadline = deadlineFromDays(days);
          expect(deadline).toBeGreaterThan(now);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("returns approximately now + days * 86400", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3650 }),
        (days) => {
          const now = Math.floor(Date.now() / 1000);
          const deadline = deadlineFromDays(days);
          const expected = now + days * 86400;
          expect(Math.abs(deadline - expected)).toBeLessThanOrEqual(2);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("deadline is never less than now for positive days", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        (days) => {
          const deadline = deadlineFromDays(days);
          expect(deadline).toBeGreaterThanOrEqual(Math.floor(Date.now() / 1000));
        },
      ),
      { numRuns: 500 },
    );
  });

  it("isExpired returns false for deadlines in the future", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3650 }),
        (days) => {
          const deadline = deadlineFromDays(days);
          expect(isExpired(deadline)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("isExpired returns true for deadlines in the past", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 3650 }),
        (days) => {
          const now = Math.floor(Date.now() / 1000);
          const pastDeadline = now - days * 86400;
          expect(isExpired(pastDeadline)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("larger day counts produce larger deadlines", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 1, max: 1000 }),
        fc.integer({ min: 1001, max: 2000 }),
        (small, large) => {
          const deadlineSmall = deadlineFromDays(small);
          const deadlineLarge = deadlineFromDays(large);
          expect(deadlineLarge).toBeGreaterThan(deadlineSmall);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("deadline is an integer (no fractional seconds)", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 0, max: 36500 }),
        (days) => {
          const deadline = deadlineFromDays(days);
          expect(Number.isInteger(deadline)).toBe(true);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("deadlineFromDays(0) returns approximately now", () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = deadlineFromDays(0);
    expect(Math.abs(deadline - now)).toBeLessThanOrEqual(2);
  });
});
