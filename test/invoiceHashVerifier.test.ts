import { describe, it, expect } from "vitest";
import { hashInvoice, verifyInvoiceHash } from "../src/invoiceHashVerifier.js";
import type { Invoice } from "../src/types.js";

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "42",
    creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    recipients: [
      {
        address: "GRECIPIENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        amount: 5_000_000n,
      },
    ],
    token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
    deadline: 1_700_000_000,
    funded: 5_000_000n,
    status: "Pending" as const,
    payments: [
      {
        payer: "GPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        amount: 5_000_000n,
      },
    ],
    memo: "Invoice for services",
    ...overrides,
  };
}

describe("hashInvoice", () => {
  it("produces a 64-character hex string", async () => {
    const invoice = makeInvoice();
    const hash = await hashInvoice(invoice);
    expect(hash).toHaveLength(64);
    expect(/^[0-9a-f]+$/.test(hash)).toBe(true);
  });

  it("produces the same hash for identical objects", async () => {
    const invoice1 = makeInvoice();
    const invoice2 = makeInvoice();
    const hash1 = await hashInvoice(invoice1);
    const hash2 = await hashInvoice(invoice2);
    expect(hash1).toBe(hash2);
  });

  it("produces same hash for objects with different key insertion order", async () => {
    // Create two invoices where field order might differ
    const inv1 = {
      id: "42",
      deadline: 1_700_000_000,
      creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      funded: 5_000_000n,
      status: "Pending" as const,
      recipients: [{ address: "GRECIPIENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", amount: 5_000_000n }],
      payments: [{ payer: "GPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", amount: 5_000_000n }],
    };
    const inv2 = {
      creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      id: "42",
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: 1_700_000_000,
      funded: 5_000_000n,
      status: "Pending" as const,
      payments: [{ payer: "GPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", amount: 5_000_000n }],
      recipients: [{ address: "GRECIPIENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", amount: 5_000_000n }],
    };
    const hash1 = await hashInvoice(inv1);
    const hash2 = await hashInvoice(inv2);
    expect(hash1).toBe(hash2);
  });

  it("produces different hash when amount field is mutated", async () => {
    const invoice1 = makeInvoice({ funded: 5_000_000n });
    const invoice2 = makeInvoice({ funded: 10_000_000n });
    const hash1 = await hashInvoice(invoice1);
    const hash2 = await hashInvoice(invoice2);
    expect(hash1).not.toBe(hash2);
  });

  it("produces different hash when recipient changes", async () => {
    const invoice1 = makeInvoice();
    const invoice2 = makeInvoice({
      recipients: [
        {
          address: "GDIFFERENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          amount: 5_000_000n,
        },
      ],
    });
    const hash1 = await hashInvoice(invoice1);
    const hash2 = await hashInvoice(invoice2);
    expect(hash1).not.toBe(hash2);
  });

  it("ignores contentHash field in the invoice", async () => {
    const invoice = makeInvoice();
    const hashWithout = await hashInvoice(invoice);
    const hashWith = await hashInvoice({ ...invoice, contentHash: "abc123" } as any);
    expect(hashWithout).toBe(hashWith);
  });
});

describe("verifyInvoiceHash", () => {
  it("returns true when hashes match", async () => {
    const invoice = makeInvoice();
    const hash = await hashInvoice(invoice);
    const result = await verifyInvoiceHash(invoice, hash);
    expect(result).toBe(true);
  });

  it("returns false when hashes diverge", async () => {
    const invoice = makeInvoice({ funded: 5_000_000n });
    const result = await verifyInvoiceHash(invoice, "00".repeat(32));
    expect(result).toBe(false);
  });

  it("returns true for identical invoices across runs", async () => {
    const invoice1 = makeInvoice();
    const invoice2 = makeInvoice();
    const hash = await hashInvoice(invoice1);
    const result = await verifyInvoiceHash(invoice2, hash);
    expect(result).toBe(true);
  });
});
