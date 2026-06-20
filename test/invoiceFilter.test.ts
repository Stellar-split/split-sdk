import { describe, it, expect } from "vitest";
import {
  compileFilter,
  applyFilter,
  buildIndex,
  type FilterCriteria,
} from "../src/invoiceFilter.js";
import type { Invoice, InvoiceStatus } from "../src/types.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "1",
    creator: "GABC",
    recipients: [{ address: "GRECIP", amount: 1000000n }],
    token: "GUSDC",
    deadline: 1700000000,
    funded: 500000n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

const sampleInvoices: Invoice[] = [
  makeInvoice({ id: "1", status: "Pending", creator: "GABC", token: "GUSDC", funded: 1000000n, deadline: 1700000000 }),
  makeInvoice({ id: "2", status: "Released", creator: "GABC", token: "GUSDC", funded: 5000000n, deadline: 1700001000 }),
  makeInvoice({ id: "3", status: "Pending", creator: "GXYZ", token: "GXLM", funded: 0n, deadline: 1700002000 }),
  makeInvoice({ id: "4", status: "Cancelled", creator: "GXYZ", token: "GUSDC", funded: 2000000n, deadline: 1699999000 }),
  makeInvoice({ id: "5", status: "Refunded", creator: "GABC", token: "GXLM", funded: 3000000n, deadline: 1700003000 }),
];

// ── compileFilter / applyFilter ──────────────────────────────────────────────

describe("compileFilter / applyFilter", () => {
  it("filters by single status field", () => {
    const filter = compileFilter({ status: "Pending" });
    const result = applyFilter(sampleInvoices, filter);
    expect(result.map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("filters by creator", () => {
    const filter = compileFilter({ creator: "GABC" });
    const result = applyFilter(sampleInvoices, filter);
    expect(result.map((i) => i.id)).toEqual(["1", "2", "5"]);
  });

  it("filters by token", () => {
    const filter = compileFilter({ token: "GUSDC" });
    const result = applyFilter(sampleInvoices, filter);
    expect(result.map((i) => i.id)).toEqual(["1", "2", "4"]);
  });

  it("filters by recipient (matches any recipient)", () => {
    const filter = compileFilter({ recipient: "GRECIP" });
    const result = applyFilter(sampleInvoices, filter);
    expect(result.length).toBe(5); // all have GRECIP as recipient
  });

  it("filters by minFunded bigint", () => {
    const filter = compileFilter({ minFunded: 2000000n });
    const result = applyFilter(sampleInvoices, filter);
    expect(result.map((i) => i.id)).toEqual(["2", "4", "5"]);
  });

  it("filters by maxFunded bigint", () => {
    const filter = compileFilter({ maxFunded: 1000000n });
    const result = applyFilter(sampleInvoices, filter);
    expect(result.map((i) => i.id)).toEqual(["1", "3"]);
  });

  it("filters by funded range (min + max)", () => {
    const filter = compileFilter({ minFunded: 1000000n, maxFunded: 3000000n });
    const result = applyFilter(sampleInvoices, filter);
    expect(result.map((i) => i.id)).toEqual(["1", "4", "5"]);
  });

  it("filters by deadlineBefore", () => {
    const filter = compileFilter({ deadlineBefore: 1700000000 });
    const result = applyFilter(sampleInvoices, filter);
    expect(result.map((i) => i.id)).toEqual(["4"]);
  });

  it("filters by deadlineAfter", () => {
    const filter = compileFilter({ deadlineAfter: 1700002000 });
    const result = applyFilter(sampleInvoices, filter);
    expect(result.map((i) => i.id)).toEqual(["5"]);
  });

  it("combines multiple leaf fields (implicit AND)", () => {
    const filter = compileFilter({ status: "Pending", creator: "GABC" });
    const result = applyFilter(sampleInvoices, filter);
    expect(result.map((i) => i.id)).toEqual(["1"]);
  });

  it("returns empty for empty input array", () => {
    const filter = compileFilter({ status: "Pending" });
    const result = applyFilter([], filter);
    expect(result).toEqual([]);
  });
});

// ── Nested AND / OR logic ───────────────────────────────────────────────────

describe("nested AND / OR logic", () => {
  it("AND: all children must match", () => {
    const filter = compileFilter({
      and: [
        { status: "Pending" },
        { creator: "GABC" },
      ],
    });
    const result = applyFilter(sampleInvoices, filter);
    expect(result.map((i) => i.id)).toEqual(["1"]);
  });

  it("AND: returns empty when one child doesn't match", () => {
    const filter = compileFilter({
      and: [
        { status: "Pending" },
        { creator: "GXYZ" },
        { token: "GUSDC" },
      ],
    });
    const result = applyFilter(sampleInvoices, filter);
    expect(result).toEqual([]);
  });

  it("OR: any child can match", () => {
    const filter = compileFilter({
      or: [
        { status: "Cancelled" },
        { status: "Refunded" },
      ],
    });
    const result = applyFilter(sampleInvoices, filter);
    expect(result.map((i) => i.id).sort()).toEqual(["4", "5"]);
  });

  it("OR: returns empty when no child matches", () => {
    const filter = compileFilter({
      or: [
        { status: "Cancelled" },
        { status: "Refunded" },
      ],
    });
    const allPending = sampleInvoices.filter((i) => i.status === "Pending");
    const result = applyFilter(allPending, filter);
    expect(result).toEqual([]);
  });

  it("nested AND within OR", () => {
    const filter = compileFilter({
      or: [
        { and: [{ status: "Pending" }, { creator: "GABC" }] },
        { and: [{ status: "Released" }, { creator: "GABC" }] },
      ],
    });
    const result = applyFilter(sampleInvoices, filter);
    expect(result.map((i) => i.id).sort()).toEqual(["1", "2"]);
  });

  it("nested OR within AND", () => {
    const filter = compileFilter({
      and: [
        { or: [{ status: "Pending" }, { status: "Released" }] },
        { creator: "GABC" },
      ],
    });
    const result = applyFilter(sampleInvoices, filter);
    expect(result.map((i) => i.id).sort()).toEqual(["1", "2"]);
  });

  it("throws when both and and or present at same level", () => {
    expect(() =>
      compileFilter({
        and: [{ status: "Pending" }],
        or: [{ status: "Released" }],
      } as FilterCriteria),
    ).toThrow("cannot have both 'and' and 'or'");
  });
});

// ── FilterIndex ──────────────────────────────────────────────────────────────

describe("FilterIndex", () => {
  it("buildIndex creates index and queryIndex works", () => {
    const index = buildIndex(sampleInvoices);
    const filter = compileFilter({ status: "Pending" });
    const result = index.queryIndex(filter);
    expect(result.map((i) => i.id).sort()).toEqual(["1", "3"]);
  });

  it("index reuse across multiple queries", () => {
    const index = buildIndex(sampleInvoices);

    const r1 = index.queryIndex(compileFilter({ status: "Pending" }));
    const r2 = index.queryIndex(compileFilter({ creator: "GABC" }));
    const r3 = index.queryIndex(compileFilter({ token: "GXLM" }));

    expect(r1.length).toBe(2);
    expect(r2.length).toBe(3);
    expect(r3.length).toBe(2);
  });

  it("rebuild updates the index", () => {
    const index = buildIndex(sampleInvoices);
    expect(index.queryIndex(compileFilter({ status: "Pending" })).length).toBe(2);

    const newInvoices = [
      makeInvoice({ id: "10", status: "Pending" }),
      makeInvoice({ id: "11", status: "Pending" }),
      makeInvoice({ id: "12", status: "Released" }),
    ];
    index.rebuild(newInvoices);
    expect(index.queryIndex(compileFilter({ status: "Pending" })).length).toBe(2);
  });

  it("byStatus direct lookup", () => {
    const index = buildIndex(sampleInvoices);
    expect(index.byStatus("Pending").length).toBe(2);
    expect(index.byStatus("Released").length).toBe(1);
    expect(index.byStatus("Cancelled").length).toBe(1);
  });

  it("byCreator direct lookup", () => {
    const index = buildIndex(sampleInvoices);
    expect(index.byCreator("GABC").length).toBe(3);
    expect(index.byCreator("GXYZ").length).toBe(2);
  });

  it("byToken direct lookup", () => {
    const index = buildIndex(sampleInvoices);
    expect(index.byToken("GUSDC").length).toBe(3);
    expect(index.byToken("GXLM").length).toBe(2);
  });

  it("empty array returns empty for all queries", () => {
    const index = buildIndex([]);
    expect(index.queryIndex(compileFilter({ status: "Pending" }))).toEqual([]);
    expect(index.byStatus("Pending")).toEqual([]);
    expect(index.byCreator("GABC")).toEqual([]);
  });
});

// ── bigint funded range filtering ────────────────────────────────────────────

describe("bigint funded range filtering", () => {
  it("handles bigint comparison correctly", () => {
    const invoices = [
      makeInvoice({ id: "1", funded: 0n }),
      makeInvoice({ id: "2", funded: 1n }),
      makeInvoice({ id: "3", funded: 999999n }),
      makeInvoice({ id: "4", funded: 1000000n }),
      makeInvoice({ id: "5", funded: 1000001n }),
    ];

    const filter = compileFilter({ minFunded: 1n, maxFunded: 1000000n });
    const result = applyFilter(invoices, filter);
    expect(result.map((i) => i.id)).toEqual(["2", "3", "4"]);
  });

  it("handles very large bigint values", () => {
    const invoices = [
      makeInvoice({ id: "1", funded: 9007199254740992n }), // Number.MAX_SAFE_INTEGER + 1
      makeInvoice({ id: "2", funded: 9007199254740993n }),
    ];

    const filter = compileFilter({ minFunded: 9007199254740993n });
    const result = applyFilter(invoices, filter);
    expect(result.map((i) => i.id)).toEqual(["2"]);
  });
});
