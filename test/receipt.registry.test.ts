import { describe, it, expect, beforeEach } from "vitest";
import {
  registerReceipt,
  getReceiptByTxHash,
  getAllReceipts,
  clearReceipts,
} from "../src/receipt.js";
import type { PaymentReceipt as ChainPaymentReceipt } from "../src/types/receipts.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReceipt(
  overrides: Partial<ChainPaymentReceipt> = {},
): ChainPaymentReceipt {
  return {
    invoiceId: "invoice-1",
    paymentId: "payment-1",
    amount: "1000000",
    recipientId: "GABC123",
    txHash: "abc123hash",
    ledger: 1000,
    timestamp: 1_700_000_000_000,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("receipt registry", () => {
  // Always start each test with an empty registry.
  beforeEach(() => {
    clearReceipts();
  });

  describe("registerReceipt / getReceiptByTxHash", () => {
    it("stores a receipt and retrieves it by txHash", () => {
      const receipt = makeReceipt({ txHash: "tx-aaa" });
      registerReceipt(receipt);

      const retrieved = getReceiptByTxHash("tx-aaa");
      expect(retrieved).toEqual(receipt);
    });

    it("returns null for an unknown txHash", () => {
      const result = getReceiptByTxHash("nonexistent-hash");
      expect(result).toBeNull();
    });

    it("overwrites a receipt with the same txHash", () => {
      const first = makeReceipt({ txHash: "tx-dup", amount: "100" });
      const second = makeReceipt({ txHash: "tx-dup", amount: "200" });

      registerReceipt(first);
      registerReceipt(second);

      const retrieved = getReceiptByTxHash("tx-dup");
      expect(retrieved?.amount).toBe("200");
    });

    it("stores multiple distinct receipts independently", () => {
      const r1 = makeReceipt({ txHash: "tx-1" });
      const r2 = makeReceipt({ txHash: "tx-2" });

      registerReceipt(r1);
      registerReceipt(r2);

      expect(getReceiptByTxHash("tx-1")).toEqual(r1);
      expect(getReceiptByTxHash("tx-2")).toEqual(r2);
    });
  });

  describe("getAllReceipts", () => {
    it("returns an empty array when no receipts are registered", () => {
      expect(getAllReceipts()).toEqual([]);
    });

    it("returns all registered receipts", () => {
      const r1 = makeReceipt({ txHash: "tx-1" });
      const r2 = makeReceipt({ txHash: "tx-2" });

      registerReceipt(r1);
      registerReceipt(r2);

      const all = getAllReceipts();
      expect(all).toHaveLength(2);
    });

    it("returns receipts ordered by timestamp ascending", () => {
      const oldest = makeReceipt({ txHash: "tx-old", timestamp: 1_000 });
      const newest = makeReceipt({ txHash: "tx-new", timestamp: 3_000 });
      const middle = makeReceipt({ txHash: "tx-mid", timestamp: 2_000 });

      // Register in non-chronological order to verify sorting.
      registerReceipt(newest);
      registerReceipt(oldest);
      registerReceipt(middle);

      const all = getAllReceipts();
      expect(all.map((r) => r.txHash)).toEqual(["tx-old", "tx-mid", "tx-new"]);
    });

    it("does not mutate the internal registry order when sorted", () => {
      const a = makeReceipt({ txHash: "tx-z", timestamp: 999 });
      const b = makeReceipt({ txHash: "tx-a", timestamp: 1 });

      registerReceipt(a);
      registerReceipt(b);

      // Call twice — result should be consistent.
      const first = getAllReceipts().map((r) => r.txHash);
      const second = getAllReceipts().map((r) => r.txHash);
      expect(first).toEqual(second);
    });
  });

  describe("clearReceipts", () => {
    it("empties the registry", () => {
      registerReceipt(makeReceipt({ txHash: "tx-1" }));
      registerReceipt(makeReceipt({ txHash: "tx-2" }));

      clearReceipts();

      expect(getAllReceipts()).toHaveLength(0);
      expect(getReceiptByTxHash("tx-1")).toBeNull();
    });

    it("is idempotent — calling on an empty registry does not throw", () => {
      expect(() => clearReceipts()).not.toThrow();
    });
  });
});
