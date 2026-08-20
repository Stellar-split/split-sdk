import { describe, expect, it } from "vitest";
import { searchByMemo } from "../src/search.js";
import type { Invoice } from "../src/types.js";

function makeInvoice(overrides: Partial<Invoice> & { memo?: string }): Invoice {
  return {
    id: "test-id",
    creator: "GABCDEF1234567890",
    recipient: "G1234567890ABCDEF",
    amount: "100",
    asset: "XLM",
    status: "pending",
    ...overrides,
  } as Invoice;
}

describe("searchByMemo", () => {
  it("returns invoices whose memo contains the query substring", () => {
    const invoices = [
      makeInvoice({ memo: "split:INV-001", id: "1" }),
      makeInvoice({ memo: "payment for services", id: "2" }),
      makeInvoice({ memo: "split:INV-002", id: "3" }),
    ];

    const result = searchByMemo(invoices, "split");

    expect(result).toHaveLength(2);
    expect(result.map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("is case-insensitive by default", () => {
    const invoices = [
      makeInvoice({ memo: "Hello World", id: "1" }),
      makeInvoice({ memo: "hello world", id: "2" }),
      makeInvoice({ memo: "HELLO WORLD", id: "3" }),
    ];

    const result = searchByMemo(invoices, "hello");

    expect(result).toHaveLength(3);
  });

  it("respects caseSensitive option", () => {
    const invoices = [
      makeInvoice({ memo: "Hello World", id: "1" }),
      makeInvoice({ memo: "hello world", id: "2" }),
    ];

    const result = searchByMemo(invoices, "Hello", { caseSensitive: true });

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("1");
  });

  it("returns all invoices unchanged when query is empty", () => {
    const invoices = [
      makeInvoice({ memo: "alpha", id: "1" }),
      makeInvoice({ memo: "beta", id: "2" }),
      makeInvoice({ memo: "gamma", id: "3" }),
    ];

    const result = searchByMemo(invoices, "");

    expect(result).toHaveLength(3);
    expect(result).toEqual(invoices);
  });

  it("skips invoices with undefined or null memo", () => {
    const invoices = [
      makeInvoice({ memo: "found me", id: "1" }),
      makeInvoice({ memo: undefined, id: "2" }),
      makeInvoice({ memo: null, id: "3" } as unknown as Invoice),
    ];

    const result = searchByMemo(invoices, "found");

    expect(result).toHaveLength(1);
    expect(result[0]!.id).toBe("1");
  });

  it("returns empty array when no invoices match", () => {
    const invoices = [
      makeInvoice({ memo: "alpha", id: "1" }),
      makeInvoice({ memo: "beta", id: "2" }),
    ];

    const result = searchByMemo(invoices, "nonexistent");

    expect(result).toHaveLength(0);
  });
});