import { describe, it, expect } from "vitest";
import { createHash } from "crypto";
import {
  compilePaymentReceipt,
  generatePaymentReceipt,
  serializePaymentReceipt,
  deserializePaymentReceipt,
} from "../src/receipt.js";
import type { Invoice } from "../src/types.js";

const mockInvoice: Invoice = {
  id: "inv_99",
  creator: "GCREATOR123",
  recipients: [{ address: "GRECIPIENT123", amount: 100000000n }],
  token: "USDC",
  totalAmount: 100000000n,
  amountPaid: 70000000n,
  deadline: 1800000000,
  isPaid: false,
  status: "active",
  payments: [
    {
      payer: "GPAYER_A",
      amount: 40000000n,
      timestamp: 1700000100,
      ledger: 1001,
    },
    {
      payer: "GPAYER_B",
      amount: 30000000n,
      timestamp: 1700000150,
      ledger: 1005,
    },
    {
      payer: "GPAYER_A",
      amount: 30000000n,
      timestamp: 1700000200,
      ledger: 1010,
    },
  ],
};

describe("generatePaymentReceipt", () => {
  it("compiles correct receipt for a payer with multiple payments", () => {
    const receipt = compilePaymentReceipt(mockInvoice, "GPAYER_A");

    expect(receipt.invoiceId).toBe("inv_99");
    expect(receipt.payer).toBe("GPAYER_A");
    expect(receipt.totalPaid).toBe(70000000n);
    expect(receipt.payments).toHaveLength(2);
    expect(receipt.ledgerTimestamp).toBe(1700000200);

    const expectedPayload = "inv_99GPAYER_A700000001700000200";
    const expectedHash = createHash("sha256").update(expectedPayload).digest("hex");
    expect(receipt.proofHash).toBe(expectedHash);
  });

  it("handles in-progress invoice partial payments", () => {
    const receipt = compilePaymentReceipt(mockInvoice, "GPAYER_B");

    expect(receipt.totalPaid).toBe(30000000n);
    expect(receipt.payments).toHaveLength(1);
    expect(receipt.ledgerTimestamp).toBe(1700000150);

    const expectedPayload = "inv_99GPAYER_B300000001700000150";
    const expectedHash = createHash("sha256").update(expectedPayload).digest("hex");
    expect(receipt.proofHash).toBe(expectedHash);
  });

  it("handles payer with no payments", () => {
    const receipt = compilePaymentReceipt(mockInvoice, "GPAYER_C");

    expect(receipt.totalPaid).toBe(0n);
    expect(receipt.payments).toHaveLength(0);
    expect(receipt.ledgerTimestamp).toBe(1800000000); // Fallback to deadline

    const expectedPayload = "inv_99GPAYER_C01800000000";
    const expectedHash = createHash("sha256").update(expectedPayload).digest("hex");
    expect(receipt.proofHash).toBe(expectedHash);
  });

  it("works with client getInvoice interface via async generatePaymentReceipt", async () => {
    const mockClient = {
      getInvoice: async (id: string) => {
        if (id === "inv_99") return mockInvoice;
        throw new Error("Not found");
      },
    };

    const receipt = await generatePaymentReceipt(mockClient, "inv_99", "GPAYER_A");
    expect(receipt.invoiceId).toBe("inv_99");
    expect(receipt.totalPaid).toBe(70000000n);
  });

  it("serializes to JSON cleanly without BigInt TypeError and deserializes back accurately", () => {
    const receipt = compilePaymentReceipt(mockInvoice, "GPAYER_A");
    
    // Should not throw BigInt TypeError
    const jsonStr = serializePaymentReceipt(receipt);
    expect(jsonStr).toContain('"totalPaid": "70000000"');

    const deserialized = deserializePaymentReceipt(jsonStr);
    expect(deserialized.invoiceId).toBe(receipt.invoiceId);
    expect(deserialized.payer).toBe(receipt.payer);
    expect(deserialized.totalPaid).toBe(receipt.totalPaid);
    expect(deserialized.proofHash).toBe(receipt.proofHash);
    expect(deserialized.payments).toHaveLength(2);
    expect(deserialized.payments[0]!.amount).toBe(40000000n);
  });
});
