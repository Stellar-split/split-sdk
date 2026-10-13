/**
 * Tests for issue #614 — `searchByMemo` in `src/search.ts`.
 *
 * Covers: substring match, case-insensitive default, case-sensitive override,
 * empty query returns all invoices, and invoices with a null/undefined memo
 * being skipped without error.
 */
import { describe, it, expect } from "vitest";
import { searchByMemo } from "../src/search.js";
import type { Invoice } from "../src/types.js";

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "1",
    creator: "GCREATOR",
    recipients: [{ address: "GRECIPIENT", amount: 100n }],
    token: "TOKEN_USDC",
    deadline: 2_000_000_000,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

const invoices: Invoice[] = [
  makeInvoice({ id: "1", memo: "split:INV-001" }),
  makeInvoice({ id: "2", memo: "SPLIT:inv-002" }),
  makeInvoice({ id: "3", memo: "rent for October" }),
  makeInvoice({ id: "4", memo: undefined }),
  makeInvoice({ id: "5" }), // memo omitted entirely
];

describe("searchByMemo", () => {
  it("matches on a substring of the memo", () => {
    const result = searchByMemo(invoices, "rent for");
    expect(result.map((i) => i.id)).toEqual(["3"]);
  });

  it("is case-insensitive by default", () => {
    const result = searchByMemo(invoices, "split:inv-");
    expect(result.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("respects caseSensitive: true", () => {
    const result = searchByMemo(invoices, "SPLIT:", { caseSensitive: true });
    expect(result.map((i) => i.id)).toEqual(["2"]);

    const lower = searchByMemo(invoices, "split:", { caseSensitive: true });
    expect(lower.map((i) => i.id)).toEqual(["1"]);
  });

  it("returns all invoices unchanged for an empty query", () => {
    const result = searchByMemo(invoices, "");
    expect(result).toEqual(invoices);
    expect(result).toHaveLength(invoices.length);
  });

  it("skips invoices with a null or undefined memo without error", () => {
    const withNull = [
      ...invoices,
      makeInvoice({ id: "6", memo: null as unknown as string }),
    ];
    expect(() => searchByMemo(withNull, "split")).not.toThrow();
    const result = searchByMemo(withNull, "split");
    expect(result.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("returns an empty array when nothing matches", () => {
    expect(searchByMemo(invoices, "zzz-no-match")).toEqual([]);
  });

  it("does not mutate the input array", () => {
    const snapshot = [...invoices];
    searchByMemo(invoices, "split");
    expect(invoices).toEqual(snapshot);
  });
});
