import { describe, it, expect } from "vitest";
import { deduplicateRecipients } from "../src/validators/recipientDeduplicator.js";
import { DuplicateRecipientError } from "../src/errors.js";
import type { Recipient } from "../src/types.js";

function r(address: string, amount: bigint): Recipient {
  return { address, amount };
}

describe("deduplicateRecipients", () => {
  describe("merge mode", () => {
    it("returns the same list when there are no duplicates", () => {
      const recipients = [
        r("GABC00000000000000000000000000000000000000000000000001", 100n),
        r("GABC00000000000000000000000000000000000000000000000002", 200n),
      ];
      const result = deduplicateRecipients(recipients, "merge");
      expect(result).toHaveLength(2);
      expect(result[0].address).toBe(recipients[0].address);
      expect(result[0].amount).toBe(100n);
      expect(result[1].address).toBe(recipients[1].address);
      expect(result[1].amount).toBe(200n);
    });

    it("merges duplicate addresses by summing their ratios", () => {
      const recipients = [
        r("GABC00000000000000000000000000000000000000000000000001", 100n),
        r("GABC00000000000000000000000000000000000000000000000002", 200n),
        r("GABC00000000000000000000000000000000000000000000000001", 50n),
      ];
      const result = deduplicateRecipients(recipients, "merge");
      expect(result).toHaveLength(2);

      const deduped = result.find(
        (x) => x.address === "GABC00000000000000000000000000000000000000000000000001"
      );
      expect(deduped).toBeDefined();
      expect(deduped!.amount).toBe(150n); // 100 + 50
    });

    it("preserves the first occurrence's address casing", () => {
      const recipients = [
        r("GABC00000000000000000000000000000000000000000000000001", 100n),
        r("gabc00000000000000000000000000000000000000000000000001", 50n),
      ];
      const result = deduplicateRecipients(recipients, "merge");
      expect(result).toHaveLength(1);
      // Should preserve the first occurrence's casing
      expect(result[0].address).toBe("GABC00000000000000000000000000000000000000000000000001");
      expect(result[0].amount).toBe(150n);
    });

    it("handles multiple groups of duplicates", () => {
      const recipients = [
        r("GA11111111111111111111111111111111111111111111111111", 10n),
        r("GB22222222222222222222222222222222222222222222222222", 20n),
        r("GA11111111111111111111111111111111111111111111111111", 30n),
        r("GB22222222222222222222222222222222222222222222222222", 40n),
        r("GC33333333333333333333333333333333333333333333333333", 50n),
      ];
      const result = deduplicateRecipients(recipients, "merge");
      expect(result).toHaveLength(3);

      const a = result.find((x) => x.address === "GA11111111111111111111111111111111111111111111111111");
      expect(a!.amount).toBe(40n); // 10 + 30

      const b = result.find((x) => x.address === "GB22222222222222222222222222222222222222222222222222");
      expect(b!.amount).toBe(60n); // 20 + 40

      const c = result.find((x) => x.address === "GC33333333333333333333333333333333333333333333333333");
      expect(c!.amount).toBe(50n);
    });

    it("handles empty list", () => {
      const result = deduplicateRecipients([], "merge");
      expect(result).toEqual([]);
    });

    it("is case-insensitive for Stellar account IDs", () => {
      const recipients = [
        r("GABC00000000000000000000000000000000000000000000000001", 100n),
        r("gabc00000000000000000000000000000000000000000000000001", 200n),
        r("GAbc00000000000000000000000000000000000000000000000001", 300n),
      ];
      const result = deduplicateRecipients(recipients, "merge");
      expect(result).toHaveLength(1);
      expect(result[0].amount).toBe(600n);
    });
  });

  describe("reject mode", () => {
    it("returns the same list when there are no duplicates", () => {
      const recipients = [
        r("GABC00000000000000000000000000000000000000000000000001", 100n),
        r("GABC00000000000000000000000000000000000000000000000002", 200n),
      ];
      const result = deduplicateRecipients(recipients, "reject");
      expect(result).toHaveLength(2);
      expect(result[0].address).toBe(recipients[0].address);
    });

    it("throws DuplicateRecipientError when duplicates exist", () => {
      const recipients = [
        r("GABC00000000000000000000000000000000000000000000000001", 100n),
        r("GABC00000000000000000000000000000000000000000000000002", 200n),
        r("GABC00000000000000000000000000000000000000000000000001", 50n),
      ];
      expect(() => deduplicateRecipients(recipients, "reject")).toThrow(
        DuplicateRecipientError
      );
    });

    it("includes duplicated addresses in the error", () => {
      const recipients = [
        r("GABC00000000000000000000000000000000000000000000000001", 100n),
        r("GABC00000000000000000000000000000000000000000000000001", 200n),
      ];
      try {
        deduplicateRecipients(recipients, "reject");
        expect.fail("Expected error to be thrown");
      } catch (err) {
        expect(err).toBeInstanceOf(DuplicateRecipientError);
        const dupErr = err as DuplicateRecipientError;
        expect(dupErr.duplicateAddresses.length).toBeGreaterThan(0);
      }
    });

    it("is case-insensitive for duplicate detection", () => {
      const recipients = [
        r("GABC00000000000000000000000000000000000000000000000001", 100n),
        r("gabc00000000000000000000000000000000000000000000000001", 200n),
      ];
      expect(() => deduplicateRecipients(recipients, "reject")).toThrow(
        DuplicateRecipientError
      );
    });
  });

  describe("default mode", () => {
    it("defaults to merge mode", () => {
      const recipients = [
        r("GABC00000000000000000000000000000000000000000000000001", 100n),
        r("GABC00000000000000000000000000000000000000000000000001", 50n),
      ];
      const result = deduplicateRecipients(recipients);
      expect(result).toHaveLength(1);
      expect(result[0].amount).toBe(150n);
    });
  });
});
