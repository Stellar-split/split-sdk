import { describe, it, expect } from "vitest";
import {
  rankResults,
  scoreInvoice,
  WEIGHT_EXACT_MATCH,
  WEIGHT_FUNDING_PROGRESS,
  WEIGHT_RECENCY,
} from "../src/searchRanking.js";
import type { Invoice } from "../src/types.js";

const NOW = 1_000_000; // fixed "now" in seconds

function inv(overrides: Partial<Invoice> & { id: string }): Invoice {
  return {
    creator: "GCREATOR",
    recipients: [{ address: "GRECIP", amount: 100n }],
    token: "USDC",
    deadline: NOW + 86400, // 1 day from now
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  } as Invoice;
}

describe("scoreInvoice – exact match weight", () => {
  it("adds WEIGHT_EXACT_MATCH when id exactly matches query", () => {
    const invoice = inv({ id: "inv-42" });
    const withExact = scoreInvoice(invoice, { query: "inv-42", nowSecs: NOW });
    const withPartial = scoreInvoice(invoice, { query: "inv", nowSecs: NOW });
    expect(withExact - withPartial).toBe(WEIGHT_EXACT_MATCH);
  });
});

describe("scoreInvoice – funding progress weight", () => {
  it("fully funded invoice scores WEIGHT_FUNDING_PROGRESS more than unfunded", () => {
    const unfunded = inv({ id: "u", funded: 0n });
    const funded = inv({ id: "f", funded: 100n }); // 100/100 = 100%
    const ctx = { query: "x", nowSecs: NOW };
    const diff = scoreInvoice(funded, ctx) - scoreInvoice(unfunded, ctx);
    expect(diff).toBeCloseTo(WEIGHT_FUNDING_PROGRESS);
  });

  it("half-funded scores roughly half of WEIGHT_FUNDING_PROGRESS more than unfunded", () => {
    const unfunded = inv({ id: "u", funded: 0n });
    const half = inv({ id: "h", funded: 50n });
    const ctx = { query: "x", nowSecs: NOW };
    const diff = scoreInvoice(half, ctx) - scoreInvoice(unfunded, ctx);
    expect(diff).toBeCloseTo(WEIGHT_FUNDING_PROGRESS * 0.5);
  });
});

describe("scoreInvoice – recency weight", () => {
  it("deadline very close to now scores more than deadline 30 days away", () => {
    const urgent = inv({ id: "ur", deadline: NOW + 1 });          // 1 sec away
    const distant = inv({ id: "di", deadline: NOW + 30 * 86400 }); // exactly 30 days
    const ctx = { query: "x", nowSecs: NOW };
    expect(scoreInvoice(urgent, ctx)).toBeGreaterThan(scoreInvoice(distant, ctx));
  });

  it("past-deadline invoice gets 0 recency score", () => {
    const expired = inv({ id: "ex", deadline: NOW - 1 });
    const future = inv({ id: "fu", deadline: NOW + 1 });
    const ctx = { query: "x", nowSecs: NOW };
    // expired recency contribution is 0; future's is small but positive
    expect(scoreInvoice(future, ctx)).toBeGreaterThan(scoreInvoice(expired, ctx));
  });
});

describe("rankResults", () => {
  it("returns invoices sorted by descending score", () => {
    const low = inv({ id: "low", funded: 0n, deadline: NOW + 30 * 86400 });
    const high = inv({ id: "high", funded: 100n, deadline: NOW + 1 });
    const result = rankResults([low, high], { query: "x", nowSecs: NOW });
    expect(result[0].id).toBe("high");
    expect(result[1].id).toBe("low");
  });

  it("stable sort: equal-scoring invoices preserve input order", () => {
    const a = inv({ id: "a" });
    const b = inv({ id: "b" });
    const c = inv({ id: "c" });
    // All identical structure → equal scores
    const result = rankResults([a, b, c], { query: "x", nowSecs: NOW });
    expect(result.map((i) => i.id)).toEqual(["a", "b", "c"]);
  });
});
