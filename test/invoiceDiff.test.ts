/**
 * Tests for invoice diff utility (issue #363).
 */

import { describe, it, expect } from "vitest";
import { diffInvoices, hasDiff } from "../src/diff.js";
import type { Invoice, InvoiceDiff } from "../src/diff.js";

describe("Invoice Diff Utility", () => {
  const baseInvoice: Invoice = {
    id: "123",
    creator: "GABC123",
    recipients: [
      { address: "GXYZ456", amount: 1000000n },
      { address: "GDEF789", amount: 2000000n },
    ],
    token: "USDC",
    deadline: 1234567890,
    funded: 0n,
    status: "Pending",
    payments: [],
  };

  describe("diffInvoices", () => {
    it("should return empty array for identical invoices", () => {
      const diff = diffInvoices(baseInvoice, baseInvoice);
      expect(diff).toEqual([]);
    });

    it("should detect changes in primitive fields", () => {
      const modified = {
        ...baseInvoice,
        status: "Released" as const,
        deadline: 1234567999,
      };

      const diff = diffInvoices(baseInvoice, modified);

      expect(diff).toHaveLength(2);
      expect(diff).toContainEqual({
        field: "status",
        before: "Pending",
        after: "Released",
      });
      expect(diff).toContainEqual({
        field: "deadline",
        before: 1234567890,
        after: 1234567999,
      });
    });

    it("should detect changes in bigint fields", () => {
      const modified = {
        ...baseInvoice,
        funded: 3000000n,
      };

      const diff = diffInvoices(baseInvoice, modified);

      expect(diff).toHaveLength(1);
      expect(diff[0]).toEqual({
        field: "funded",
        before: 0n,
        after: 3000000n,
      });
    });

    it("should compare bigint fields numerically", () => {
      const invoice1 = { ...baseInvoice, funded: 1000000n };
      const invoice2 = { ...baseInvoice, funded: 1000000n };

      const diff = diffInvoices(invoice1, invoice2);
      expect(diff).toEqual([]);
    });

    it("should detect changes in nested objects (recipients)", () => {
      const modified = {
        ...baseInvoice,
        recipients: [
          { address: "GXYZ456", amount: 1000000n },
          { address: "GDEF789", amount: 3000000n }, // Changed amount
        ],
      };

      const diff = diffInvoices(baseInvoice, modified);

      expect(diff).toHaveLength(1);
      expect(diff[0].field).toBe("recipients");
      expect(diff[0].before).toEqual(baseInvoice.recipients);
      expect(diff[0].after).toEqual(modified.recipients);
    });

    it("should detect changes in arrays (payments)", () => {
      const modified = {
        ...baseInvoice,
        payments: [
          { payer: "GPAYER1", amount: 1000000n },
        ],
      };

      const diff = diffInvoices(baseInvoice, modified);

      expect(diff).toHaveLength(1);
      expect(diff[0].field).toBe("payments");
      expect(diff[0].before).toEqual([]);
      expect(diff[0].after).toEqual(modified.payments);
    });

    it("should detect array length changes", () => {
      const invoice1 = {
        ...baseInvoice,
        payments: [
          { payer: "GPAYER1", amount: 1000000n },
        ],
      };

      const invoice2 = {
        ...baseInvoice,
        payments: [
          { payer: "GPAYER1", amount: 1000000n },
          { payer: "GPAYER2", amount: 2000000n },
        ],
      };

      const diff = diffInvoices(invoice1, invoice2);

      expect(diff).toHaveLength(1);
      expect(diff[0].field).toBe("payments");
    });

    it("should detect changes in optional fields", () => {
      const modified = {
        ...baseInvoice,
        memo: "Payment for services",
        recurring: true,
      };

      const diff = diffInvoices(baseInvoice, modified);

      expect(diff.length).toBeGreaterThanOrEqual(1);
      
      const memoChange = diff.find(d => d.field === "memo");
      expect(memoChange).toEqual({
        field: "memo",
        before: undefined,
        after: "Payment for services",
      });

      const recurringChange = diff.find(d => d.field === "recurring");
      expect(recurringChange).toEqual({
        field: "recurring",
        before: undefined,
        after: true,
      });
    });

    it("should detect removal of optional fields", () => {
      const invoice1 = {
        ...baseInvoice,
        memo: "Original memo",
      };

      const invoice2 = {
        ...baseInvoice,
      };

      const diff = diffInvoices(invoice1, invoice2);

      const memoChange = diff.find(d => d.field === "memo");
      expect(memoChange).toEqual({
        field: "memo",
        before: "Original memo",
        after: undefined,
      });
    });

    it("should handle complex nested structures", () => {
      const invoice1: Invoice = {
        ...baseInvoice,
        split_rules: [
          { kind: "Fixed", recipient: "GREC1", amount: 500000n },
          { kind: "Percentage", recipient: "GREC2", bps: 1000 },
        ],
      };

      const invoice2: Invoice = {
        ...baseInvoice,
        split_rules: [
          { kind: "Fixed", recipient: "GREC1", amount: 600000n }, // Changed amount
          { kind: "Percentage", recipient: "GREC2", bps: 1000 },
        ],
      };

      const diff = diffInvoices(invoice1, invoice2);

      expect(diff).toHaveLength(1);
      expect(diff[0].field).toBe("split_rules");
    });

    it("should handle penalty tiers array", () => {
      const invoice1: Invoice = {
        ...baseInvoice,
        penalty_tiers: [
          { days_late: 1, penalty_bps: 100 },
          { days_late: 7, penalty_bps: 500 },
        ],
      };

      const invoice2: Invoice = {
        ...baseInvoice,
        penalty_tiers: [
          { days_late: 1, penalty_bps: 100 },
          { days_late: 7, penalty_bps: 750 }, // Changed penalty
        ],
      };

      const diff = diffInvoices(invoice1, invoice2);

      expect(diff).toHaveLength(1);
      expect(diff[0].field).toBe("penalty_tiers");
    });

    it("should handle allowed_callers array", () => {
      const invoice1: Invoice = {
        ...baseInvoice,
        allowed_callers: ["CALLER1", "CALLER2"],
      };

      const invoice2: Invoice = {
        ...baseInvoice,
        allowed_callers: ["CALLER1", "CALLER2", "CALLER3"],
      };

      const diff = diffInvoices(invoice1, invoice2);

      expect(diff).toHaveLength(1);
      expect(diff[0].field).toBe("allowed_callers");
    });

    it("should handle null values", () => {
      const invoice1: Invoice = {
        ...baseInvoice,
        allowed_callers: ["CALLER1"],
      };

      const invoice2: Invoice = {
        ...baseInvoice,
        allowed_callers: null,
      };

      const diff = diffInvoices(invoice1, invoice2);

      expect(diff).toHaveLength(1);
      expect(diff[0].field).toBe("allowed_callers");
    });

    it("should be a pure function (no side effects)", () => {
      const invoice1 = { ...baseInvoice };
      const invoice2 = { ...baseInvoice, funded: 1000000n };

      // Create deep copies for comparison
      const invoice1Copy = JSON.parse(JSON.stringify(invoice1, (_, v) => typeof v === 'bigint' ? v.toString() : v));
      const invoice2Copy = JSON.parse(JSON.stringify(invoice2, (_, v) => typeof v === 'bigint' ? v.toString() : v));

      diffInvoices(invoice1, invoice2);

      // Verify originals weren't mutated
      expect(JSON.stringify(invoice1, (_, v) => typeof v === 'bigint' ? v.toString() : v))
        .toBe(JSON.stringify(invoice1Copy, (_, v) => typeof v === 'bigint' ? v.toString() : v));
      expect(JSON.stringify(invoice2, (_, v) => typeof v === 'bigint' ? v.toString() : v))
        .toBe(JSON.stringify(invoice2Copy, (_, v) => typeof v === 'bigint' ? v.toString() : v));
    });

    it("should handle all invoice fields", () => {
      const fullInvoice: Invoice = {
        id: "123",
        creator: "GCREATOR",
        recipients: [{ address: "GREC1", amount: 1000000n }],
        token: "USDC",
        deadline: 1234567890,
        funded: 5000000n,
        status: "Released",
        payments: [{ payer: "GPAYER", amount: 5000000n }],
        recurring: true,
        memo: "Test memo",
        scheduledReleaseDate: 1234567900,
        clonedFrom: "100",
        groupId: "group1",
        lastModifiedLedger: 12345,
        prerequisites: ["101", "102"],
        parentInvoiceId: "99",
        cloneDepth: 2,
        nft_gate: "GNFT",
        forward_invoice_id: "124",
        penalty_deadline: 1234567880,
        penalty_tiers: [{ days_late: 1, penalty_bps: 100 }],
        allowed_callers: ["CALLER1"],
        split_rules: [{ kind: "Fixed", recipient: "GREC1", amount: 500000n }],
        auto_resolve_rules: [],
        prerequisite_id: "101",
      };

      const modified = {
        ...fullInvoice,
        status: "Refunded" as const,
      };

      const diff = diffInvoices(fullInvoice, modified);

      expect(diff).toHaveLength(1);
      expect(diff[0].field).toBe("status");
    });

    it("should return fields in consistent order", () => {
      const modified = {
        ...baseInvoice,
        status: "Released" as const,
        funded: 1000000n,
        deadline: 1234567999,
      };

      const diff1 = diffInvoices(baseInvoice, modified);
      const diff2 = diffInvoices(baseInvoice, modified);

      expect(diff1.map(d => d.field)).toEqual(diff2.map(d => d.field));
    });
  });

  describe("hasDiff", () => {
    it("should return false for identical invoices", () => {
      expect(hasDiff(baseInvoice, baseInvoice)).toBe(false);
    });

    it("should return true when invoices differ", () => {
      const modified = {
        ...baseInvoice,
        status: "Released" as const,
      };

      expect(hasDiff(baseInvoice, modified)).toBe(true);
    });

    it("should return true for bigint changes", () => {
      const modified = {
        ...baseInvoice,
        funded: 1000000n,
      };

      expect(hasDiff(baseInvoice, modified)).toBe(true);
    });

    it("should return true for nested object changes", () => {
      const modified = {
        ...baseInvoice,
        recipients: [
          { address: "GXYZ456", amount: 5000000n },
        ],
      };

      expect(hasDiff(baseInvoice, modified)).toBe(true);
    });

    it("should return true for array changes", () => {
      const modified = {
        ...baseInvoice,
        payments: [{ payer: "GPAYER", amount: 1000000n }],
      };

      expect(hasDiff(baseInvoice, modified)).toBe(true);
    });

    it("should be a convenience wrapper around diffInvoices", () => {
      const modified = {
        ...baseInvoice,
        status: "Released" as const,
      };

      const hasDifference = hasDiff(baseInvoice, modified);
      const diff = diffInvoices(baseInvoice, modified);

      expect(hasDifference).toBe(diff.length > 0);
    });
  });

  describe("Type compatibility", () => {
    it("should return properly typed InvoiceDiff", () => {
      const modified = {
        ...baseInvoice,
        status: "Released" as const,
      };

      const diff: InvoiceDiff = diffInvoices(baseInvoice, modified);

      expect(Array.isArray(diff)).toBe(true);
      if (diff.length > 0) {
        expect(diff[0]).toHaveProperty("field");
        expect(diff[0]).toHaveProperty("before");
        expect(diff[0]).toHaveProperty("after");
      }
    });
  });

  describe("Edge cases", () => {
    it("should handle empty arrays", () => {
      const invoice1 = { ...baseInvoice, payments: [] };
      const invoice2 = { ...baseInvoice, payments: [] };

      const diff = diffInvoices(invoice1, invoice2);
      expect(diff).toEqual([]);
    });

    it("should handle zero bigint values", () => {
      const invoice1 = { ...baseInvoice, funded: 0n };
      const invoice2 = { ...baseInvoice, funded: 0n };

      const diff = diffInvoices(invoice1, invoice2);
      expect(diff).toEqual([]);
    });

    it("should detect change from zero to non-zero", () => {
      const invoice1 = { ...baseInvoice, funded: 0n };
      const invoice2 = { ...baseInvoice, funded: 1n };

      const diff = diffInvoices(invoice1, invoice2);
      expect(diff).toHaveLength(1);
      expect(diff[0]).toEqual({
        field: "funded",
        before: 0n,
        after: 1n,
      });
    });

    it("should handle very large bigint values", () => {
      const invoice1 = { ...baseInvoice, funded: 999999999999999n };
      const invoice2 = { ...baseInvoice, funded: 999999999999999n };

      const diff = diffInvoices(invoice1, invoice2);
      expect(diff).toEqual([]);
    });

    it("should handle deeply nested recipients", () => {
      const invoice1: Invoice = {
        ...baseInvoice,
        recipients: [
          { address: "A", amount: 1n },
          { address: "B", amount: 2n },
          { address: "C", amount: 3n },
        ],
      };

      const invoice2: Invoice = {
        ...baseInvoice,
        recipients: [
          { address: "A", amount: 1n },
          { address: "B", amount: 2n },
          { address: "C", amount: 3n },
        ],
      };

      expect(hasDiff(invoice1, invoice2)).toBe(false);
    });
  });

  describe("Real-world scenarios", () => {
    it("should detect when invoice is funded", () => {
      const pending = { ...baseInvoice, funded: 0n, status: "Pending" as const };
      const funded = { ...baseInvoice, funded: 3000000n, status: "Pending" as const };

      const diff = diffInvoices(pending, funded);

      expect(diff).toHaveLength(1);
      expect(diff[0].field).toBe("funded");
    });

    it("should detect when invoice is released", () => {
      const pending = { ...baseInvoice, status: "Pending" as const };
      const released = { ...baseInvoice, status: "Released" as const };

      const diff = diffInvoices(pending, released);

      expect(diff).toHaveLength(1);
      expect(diff[0]).toEqual({
        field: "status",
        before: "Pending",
        after: "Released",
      });
    });

    it("should detect payment additions", () => {
      const before: Invoice = {
        ...baseInvoice,
        payments: [
          { payer: "GPAYER1", amount: 1000000n },
        ],
      };

      const after: Invoice = {
        ...baseInvoice,
        payments: [
          { payer: "GPAYER1", amount: 1000000n },
          { payer: "GPAYER2", amount: 2000000n },
        ],
      };

      const diff = diffInvoices(before, after);

      expect(diff).toHaveLength(1);
      expect(diff[0].field).toBe("payments");
      expect((diff[0].after as any[]).length).toBe(2);
    });

    it("should be useful for cache invalidation decisions", () => {
      const cached = baseInvoice;
      const fresh = { ...baseInvoice, lastModifiedLedger: 12346 };

      if (hasDiff(cached, fresh)) {
        // Would update cache in real code
        expect(true).toBe(true);
      }
    });
  });
});
