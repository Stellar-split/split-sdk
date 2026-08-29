import { describe, expect, it } from "vitest";
import { searchByMemo } from "../src/search.js";
import type { Invoice } from "../src/types.js";

function makeInvoice(id: string, memo?: string | null): Invoice {
  return {
    id,
    creator: "GABC",
    recipients: [],
    token: "TOKEN",
    deadline: 0,
    funded: 0n,
    status: "Pending",
    payments: [],
    memo: memo as unknown as undefined,
  };
}

describe("searchByMemo", () => {
  const invoices: Invoice[] = [
    makeInvoice("inv-1", "split:INV-001"),
    makeInvoice("inv-2", "SPLIT:inv-002"),
    makeInvoice("inv-3", "monthly payment"),
    makeInvoice("inv-4", "split:"),
    makeInvoice("inv-5", ""),
    makeInvoice("inv-6", null as unknown as undefined),
    makeInvoice("inv-7", undefined),
  ];

  it("returns invoices whose memo contains the query substring", () => {
    const result = searchByMemo(invoices, "split");
    expect(result.map((i) => i.id)).toEqual(["inv-1", "inv-2", "inv-4"]);
  });

  it("is case-insensitive by default", () => {
    const result = searchByMemo(invoices, "SPLIT");
    expect(result.map((i) => i.id)).toEqual(["inv-1", "inv-2", "inv-4"]);
  });

  it("can be made case-sensitive", () => {
    const result = searchByMemo(invoices, "SPLIT", { caseSensitive: true });
    expect(result.map((i) => i.id)).toEqual(["inv-2"]);
  });

  it("returns all invoices when query is empty", () => {
    const result = searchByMemo(invoices, "");
    expect(result.map((i) => i.id)).toEqual([
      "inv-1",
      "inv-2",
      "inv-3",
      "inv-4",
      "inv-5",
      "inv-6",
      "inv-7",
    ]);
  });

  it("skips invoices with null or undefined memo", () => {
    const result = searchByMemo(invoices, "payment");
    expect(result.map((i) => i.id)).toEqual(["inv-3"]);
  });

  it("returns empty array when no memo matches", () => {
    const result = searchByMemo(invoices, "nonexistent");
    expect(result).toEqual([]);
  });

  it("matches partial substrings anywhere in the memo", () => {
    const result = searchByMemo(invoices, "nv-00");
    expect(result.map((i) => i.id)).toEqual(["inv-1", "inv-2"]);
  });

  it("does not mutate the input array", () => {
    const before = invoices.map((i) => i.id);
    searchByMemo(invoices, "split");
    expect(invoices.map((i) => i.id)).toEqual(before);
  });
});
