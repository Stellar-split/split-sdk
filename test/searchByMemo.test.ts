import { searchByMemo } from "../src/search.js";
import type { Invoice } from "../src/types.js";

function makeInvoice(memo?: string): Invoice {
  return {
    id: "1",
    creator: "GABC",
    recipients: [],
    token: "USDC",
    deadline: 0,
    memo,
  } as Invoice;
}

describe("searchByMemo", () => {
  const invoices = [
    makeInvoice("split:INV-001"),
    makeInvoice("SPLIT:inv-002"),
    makeInvoice("payment for project alpha"),
    makeInvoice(),
    makeInvoice(""),
  ];

  it("returns all invoices when query is empty", () => {
    expect(searchByMemo(invoices, "")).toHaveLength(5);
  });

  it("finds invoices by substring (case-insensitive default)", () => {
    const results = searchByMemo(invoices, "split");
    expect(results).toHaveLength(2);
    expect(results.map((i) => i.memo)).toContain("split:INV-001");
    expect(results.map((i) => i.memo)).toContain("SPLIT:inv-002");
  });

  it("is case-sensitive when opts.caseSensitive is true", () => {
    const results = searchByMemo(invoices, "split", { caseSensitive: true });
    expect(results).toHaveLength(1);
    expect(results[0].memo).toBe("split:INV-001");
  });

  it("skips invoices with undefined or null memo", () => {
    const results = searchByMemo(invoices, "project");
    expect(results).toHaveLength(1);
    expect(results[0].memo).toBe("payment for project alpha");
  });

  it("matches partial strings", () => {
    const results = searchByMemo(invoices, "alpha");
    expect(results).toHaveLength(1);
    expect(results[0].memo).toBe("payment for project alpha");
  });

  it("returns empty array when no matches", () => {
    expect(searchByMemo(invoices, "nonexistent")).toHaveLength(0);
  });
});
