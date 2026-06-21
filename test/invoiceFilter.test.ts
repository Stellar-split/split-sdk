import { describe, it, expect } from "vitest";
import { compileFilter, applyFilter, FilterIndex } from "../src/invoiceFilter.js";
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
  makeInvoice({ id: "1", status: "Pending",   creator: "A", funded: 100n,  deadline: 1000 }),
  makeInvoice({ id: "2", status: "Released",  creator: "B", funded: 500n,  deadline: 2000 }),
  makeInvoice({ id: "3", status: "Pending",   creator: "A", funded: 200n,  deadline: 3000 }),
  makeInvoice({ id: "4", status: "Cancelled", creator: "C", funded: 0n,    deadline: 4000 }),
  makeInvoice({
    id: "5", status: "Released", creator: "B", funded: 1000n, deadline: 5000,
    recipients: [{ address: "R1", amount: 50n }, { address: "R2", amount: 50n }],
  }),
];

describe("compileFilter", () => {
  it("throws when both and and or are present at the same level", () => {
    expect(() =>
      compileFilter({ and: [{ status: "Pending" }], or: [{ status: "Released" }] })
    ).toThrow();
  });

  it("throws when both and and or appear inside a nested criteria", () => {
    expect(() =>
      compileFilter({
        and: [{ and: [{ status: "Pending" }], or: [{ status: "Released" }] }],
      })
    ).toThrow();
  });

  it("returns a CompiledFilter with a predicate function and the original criteria", () => {
    const criteria = { status: "Pending" as const };
    const filter = compileFilter(criteria);
    expect(typeof filter.predicate).toBe("function");
    expect(filter.criteria).toBe(criteria);
  });
});

describe("applyFilter — empty array", () => {
  it("returns empty array for empty invoice list", () => {
    const filter = compileFilter({ status: "Pending" });
    expect(applyFilter([], filter)).toEqual([]);
  });
});

describe("applyFilter — leaf predicates", () => {
  it("filters by status", () => {
    const result = applyFilter(invoices, compileFilter({ status: "Pending" }));
    expect(result.map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("filters by creator", () => {
    const result = applyFilter(invoices, compileFilter({ creator: "B" }));
    expect(result.map((i) => i.id)).toEqual(["2", "5"]);
  });

  it("filters by token", () => {
    const tokenInvoices = [
      makeInvoice({ id: "a", token: "USDC" }),
      makeInvoice({ id: "b", token: "XLM" }),
    ];
    const result = applyFilter(tokenInvoices, compileFilter({ token: "USDC" }));
    expect(result.map((i) => i.id)).toEqual(["a"]);
  });

  it("filters by recipient — matches if ANY recipient matches", () => {
    const result = applyFilter(invoices, compileFilter({ recipient: "R2" }));
    expect(result.map((i) => i.id)).toEqual(["5"]);
  });

  it("filters by minFunded (bigint)", () => {
    const result = applyFilter(invoices, compileFilter({ minFunded: 500n }));
    expect(result.map((i) => i.id)).toEqual(["2", "5"]);
  });

  it("filters by maxFunded (bigint)", () => {
    const result = applyFilter(invoices, compileFilter({ maxFunded: 100n }));
    expect(result.map((i) => i.id)).toEqual(["1", "4"]);
  });

  it("filters by bigint funded range (minFunded + maxFunded)", () => {
    const result = applyFilter(invoices, compileFilter({ minFunded: 100n, maxFunded: 500n }));
    expect(result.map((i) => i.id)).toEqual(["1", "2", "3"]);
  });

  it("filters by deadlineBefore", () => {
    const result = applyFilter(invoices, compileFilter({ deadlineBefore: 3000 }));
    expect(result.map((i) => i.id)).toEqual(["1", "2"]);
  });

  it("filters by deadlineAfter", () => {
    const result = applyFilter(invoices, compileFilter({ deadlineAfter: 3000 }));
    expect(result.map((i) => i.id)).toEqual(["4", "5"]);
  });
});

describe("applyFilter — nested AND/OR logic", () => {
  it("AND: all conditions must match", () => {
    const result = applyFilter(
      invoices,
      compileFilter({ and: [{ status: "Pending" }, { creator: "A" }] })
    );
    expect(result.map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("OR: any condition may match", () => {
    const result = applyFilter(
      invoices,
      compileFilter({ or: [{ status: "Cancelled" }, { creator: "B" }] })
    );
    expect(result.map((i) => i.id)).toEqual(["2", "4", "5"]);
  });

  it("deeply nested OR containing AND groups", () => {
    const result = applyFilter(
      invoices,
      compileFilter({
        or: [
          { and: [{ status: "Pending" }, { creator: "A" }] },
          { status: "Cancelled" },
        ],
      })
    );
    expect(result.map((i) => i.id)).toEqual(["1", "3", "4"]);
  });

  it("AND combining status with bigint range", () => {
    const result = applyFilter(
      invoices,
      compileFilter({ and: [{ status: "Pending" }, { minFunded: 150n }] })
    );
    expect(result.map((i) => i.id)).toEqual(["3"]);
  });
});

describe("FilterIndex", () => {
  it("returns empty array before buildIndex is called", () => {
    const idx = new FilterIndex();
    expect(idx.queryIndex(compileFilter({ status: "Pending" }))).toEqual([]);
  });

  it("queries by status using the index", () => {
    const idx = new FilterIndex();
    idx.buildIndex(invoices);
    const result = idx.queryIndex(compileFilter({ status: "Released" }));
    expect(result.map((i) => i.id)).toEqual(["2", "5"]);
  });

  it("queries by creator using the index", () => {
    const idx = new FilterIndex();
    idx.buildIndex(invoices);
    const result = idx.queryIndex(compileFilter({ creator: "A" }));
    expect(result.map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("intersects status + creator indexes for multi-field equality", () => {
    const idx = new FilterIndex();
    idx.buildIndex(invoices);
    const result = idx.queryIndex(compileFilter({ status: "Released", creator: "B" }));
    expect(result.map((i) => i.id)).toEqual(["2", "5"]);
  });

  it("reuses the index across multiple queries without rebuilding", () => {
    const idx = new FilterIndex();
    idx.buildIndex(invoices);

    expect(idx.queryIndex(compileFilter({ status: "Pending" })).map((i) => i.id)).toEqual(["1", "3"]);
    expect(idx.queryIndex(compileFilter({ creator: "B" })).map((i) => i.id)).toEqual(["2", "5"]);
    expect(idx.queryIndex(compileFilter({ status: "Cancelled" })).map((i) => i.id)).toEqual(["4"]);
  });

  it("applies remaining predicates (bigint range) after index lookup", () => {
    const idx = new FilterIndex();
    idx.buildIndex(invoices);
    // status narrows via index, minFunded is applied as remaining predicate
    const result = idx.queryIndex(compileFilter({ status: "Pending", minFunded: 150n }));
    expect(result.map((i) => i.id)).toEqual(["3"]);
  });

  it("invalidates and rebuilds index when invoice array reference changes", () => {
    const idx = new FilterIndex();
    const arr1 = [...invoices];
    idx.buildIndex(arr1);

    const extra = makeInvoice({ id: "99", status: "Pending", creator: "Z" });
    const arr2 = [...invoices, extra];
    idx.buildIndex(arr2);

    const result = idx.queryIndex(compileFilter({ status: "Pending" }));
    expect(result.some((i) => i.id === "99")).toBe(true);
  });

  it("does not rebuild index for the same array reference", () => {
    const idx = new FilterIndex();
    const arr = [...invoices];
    idx.buildIndex(arr);
    idx.buildIndex(arr); // same reference — should be a no-op

    const result = idx.queryIndex(compileFilter({ status: "Pending" }));
    expect(result.map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("falls back to full scan for AND/OR criteria (no index shortcut)", () => {
    const idx = new FilterIndex();
    idx.buildIndex(invoices);
    const result = idx.queryIndex(
      compileFilter({ or: [{ status: "Cancelled" }, { creator: "B" }] })
    );
    expect(result.map((i) => i.id)).toEqual(["2", "4", "5"]);
  });

  it("returns empty array when no invoices match via index", () => {
    const idx = new FilterIndex();
    idx.buildIndex(invoices);
    const result = idx.queryIndex(compileFilter({ status: "Refunded" }));
    expect(result).toEqual([]);
  });
});
