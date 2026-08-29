import { describe, it, expect } from "vitest";
import { searchByMemo } from "../src/search.js";
import type { Invoice } from "../src/types.js";

function createMockInvoice(id: string, memo?: string | null): Invoice {
  return {
    id,
    creator: "GCREATOR1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
    recipients: [
      {
        address: "GRECIPIENT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ",
        amount: 10000000n,
      },
    ],
    token: "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC",
    deadline: Math.floor(Date.now() / 1000) + 3600,
    funded: 0n,
    status: "Pending",
    payments: [],
    memo: memo as unknown as string | undefined,
  };
}

describe("searchByMemo", () => {
  it("is exported as a function from src/search.ts", () => {
    expect(typeof searchByMemo).toBe("function");
  });

  it("matches invoices where memo contains query as a substring", () => {
    const inv1 = createMockInvoice("1", "split:INV-001");
    const inv2 = createMockInvoice("2", "split:INV-002");
    const inv3 = createMockInvoice("3", "other:REF-999");
    const invoices = [inv1, inv2, inv3];

    const results = searchByMemo(invoices, "INV-001");
    expect(results).toEqual([inv1]);

    const prefixResults = searchByMemo(invoices, "split:");
    expect(prefixResults).toEqual([inv1, inv2]);

    const middleResults = searchByMemo(invoices, "INV");
    expect(middleResults).toEqual([inv1, inv2]);
  });

  it("performs case-insensitive matching by default", () => {
    const inv1 = createMockInvoice("1", "split:INV-001");
    const inv2 = createMockInvoice("2", "SPLIT:INV-002");
    const inv3 = createMockInvoice("3", "Split:Inv-003");
    const inv4 = createMockInvoice("4", "unrelated memo");
    const invoices = [inv1, inv2, inv3, inv4];

    const lowerQueryResults = searchByMemo(invoices, "split");
    expect(lowerQueryResults).toEqual([inv1, inv2, inv3]);

    const upperQueryResults = searchByMemo(invoices, "SPLIT");
    expect(upperQueryResults).toEqual([inv1, inv2, inv3]);

    const mixedQueryResults = searchByMemo(invoices, "sPliT");
    expect(mixedQueryResults).toEqual([inv1, inv2, inv3]);

    const explicitDefaultResults = searchByMemo(invoices, "split", { caseSensitive: false });
    expect(explicitDefaultResults).toEqual([inv1, inv2, inv3]);
  });

  it("enforces exact-case matching when opts.caseSensitive is true", () => {
    const inv1 = createMockInvoice("1", "split:INV-001");
    const inv2 = createMockInvoice("2", "SPLIT:INV-002");
    const inv3 = createMockInvoice("3", "Split:Inv-003");
    const invoices = [inv1, inv2, inv3];

    const lowerResults = searchByMemo(invoices, "split", { caseSensitive: true });
    expect(lowerResults).toEqual([inv1]);

    const upperResults = searchByMemo(invoices, "SPLIT", { caseSensitive: true });
    expect(upperResults).toEqual([inv2]);

    const titleResults = searchByMemo(invoices, "Split", { caseSensitive: true });
    expect(titleResults).toEqual([inv3]);

    const noMatchResults = searchByMemo(invoices, "sPliT", { caseSensitive: true });
    expect(noMatchResults).toEqual([]);
  });

  it("returns all invoices unchanged when query is empty string", () => {
    const inv1 = createMockInvoice("1", "split:INV-001");
    const inv2 = createMockInvoice("2", undefined);
    const inv3 = createMockInvoice("3", null);
    const inv4 = createMockInvoice("4", "another memo");
    const invoices = [inv1, inv2, inv3, inv4];

    const results = searchByMemo(invoices, "");
    expect(results).toEqual(invoices);
    expect(results.length).toBe(4);
    expect(results[0]).toBe(inv1);
    expect(results[1]).toBe(inv2);
    expect(results[2]).toBe(inv3);
    expect(results[3]).toBe(inv4);
  });

  it("skips invoices with undefined or null memo without throwing error", () => {
    const inv1 = createMockInvoice("1", undefined);
    const inv2 = createMockInvoice("2", null);
    const inv3 = createMockInvoice("3", "split:INV-001");
    const inv4 = createMockInvoice("4");
    delete (inv4 as Partial<Invoice>).memo;
    const inv5 = createMockInvoice("5", "split:INV-002");
    const invoices = [inv1, inv2, inv3, inv4, inv5];

    expect(() => {
      const results = searchByMemo(invoices, "split");
      expect(results).toEqual([inv3, inv5]);
    }).not.toThrow();
  });

  it("returns an empty array when no invoice matches the query", () => {
    const inv1 = createMockInvoice("1", "split:INV-001");
    const inv2 = createMockInvoice("2", "split:INV-002");
    const invoices = [inv1, inv2];

    const results = searchByMemo(invoices, "NONEXISTENT_TAG");
    expect(results).toEqual([]);
  });

  it("handles empty invoice array input gracefully", () => {
    const emptyInvoices: Invoice[] = [];
    expect(searchByMemo(emptyInvoices, "split")).toEqual([]);
    expect(searchByMemo(emptyInvoices, "")).toEqual([]);
    expect(searchByMemo(emptyInvoices, "split", { caseSensitive: true })).toEqual([]);
  });

  it("correctly handles special characters and unicode in memos and queries", () => {
    const inv1 = createMockInvoice("1", "order #123 (urgent)");
    const inv2 = createMockInvoice("2", "payment for 🍕 pizza");
    const inv3 = createMockInvoice("3", "special [chars] & symbols: 100%");
    const invoices = [inv1, inv2, inv3];

    expect(searchByMemo(invoices, "#123")).toEqual([inv1]);
    expect(searchByMemo(invoices, "(urgent)")).toEqual([inv1]);
    expect(searchByMemo(invoices, "🍕")).toEqual([inv2]);
    expect(searchByMemo(invoices, "[chars]")).toEqual([inv3]);
    expect(searchByMemo(invoices, "100%")).toEqual([inv3]);
  });
});
