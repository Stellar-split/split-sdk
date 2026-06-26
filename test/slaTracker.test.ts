import { describe, expect, it } from "vitest";
import { computeSlaReport } from "../src/slaTracker.js";
import type { Invoice } from "../src/types.js";

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "1",
    creator: "GCREATOR",
    recipients: [{ address: "GRECIP", amount: 1000n }],
    token: "USDC",
    deadline: 9999999999,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

const ONE_HOUR_MS = 3_600_000;
const ONE_DAY_MS = 86_400_000;

describe("slaTracker", () => {
  it("computes correct aggregate for mixed compliant/breached set", () => {
    const invoices: Invoice[] = [
      // Within SLA: funded in 1 hour
      makeInvoice({
        id: "1",
        funded: 1000n,
        payments: [
          { payer: "P1", amount: 1000n, timestamp: 1000 },
        ],
      }),
      // Breached: funded in 25 hours
      makeInvoice({
        id: "2",
        funded: 1000n,
        payments: [
          { payer: "P1", amount: 500n, timestamp: 1000 },
          { payer: "P2", amount: 500n, timestamp: 91_000 },
        ],
      }),
    ];

    const report = computeSlaReport(invoices, ONE_DAY_MS);

    // Invoice 1: time-to-fund = 0ms (single payment)
    // Invoice 2: time-to-fund = (91000 - 1000) * 1000 = 90_000_000ms = 25 hours
    expect(report.withinSla).toBe(1);
    expect(report.breached).toBe(1);
    expect(report.avgTimeToFund).toBe(45_000_000);
  });

  it("returns zeroed report for empty input", () => {
    const report = computeSlaReport([], ONE_DAY_MS);

    expect(report.withinSla).toBe(0);
    expect(report.breached).toBe(0);
    expect(report.avgTimeToFund).toBe(0);
  });

  it("excludes invoices with zero payments from time-to-fund averages", () => {
    const invoices: Invoice[] = [
      // Has payments - funded instantly
      makeInvoice({
        id: "1",
        funded: 1000n,
        payments: [{ payer: "P1", amount: 1000n, timestamp: 5000 }],
      }),
      // No payments at all
      makeInvoice({ id: "2", funded: 0n, payments: [] }),
    ];

    const report = computeSlaReport(invoices, ONE_DAY_MS);

    expect(report.withinSla).toBe(1);
    expect(report.breached).toBe(1);
    // avgTimeToFund should only consider invoice 1 (time=0)
    expect(report.avgTimeToFund).toBe(0);
  });

  it("all invoices within SLA", () => {
    const invoices: Invoice[] = [
      makeInvoice({
        id: "1",
        funded: 1000n,
        payments: [{ payer: "P1", amount: 1000n, timestamp: 100 }],
      }),
      makeInvoice({
        id: "2",
        funded: 1000n,
        payments: [{ payer: "P1", amount: 1000n, timestamp: 200 }],
      }),
    ];

    const report = computeSlaReport(invoices, ONE_DAY_MS);

    expect(report.withinSla).toBe(2);
    expect(report.breached).toBe(0);
  });

  it("handles multi-payment funding time correctly", () => {
    const invoices: Invoice[] = [
      makeInvoice({
        id: "1",
        recipients: [{ address: "R1", amount: 500n }, { address: "R2", amount: 500n }],
        funded: 1000n,
        payments: [
          { payer: "P1", amount: 300n, timestamp: 1000 },
          { payer: "P2", amount: 400n, timestamp: 2000 },
          { payer: "P3", amount: 300n, timestamp: 3000 },
        ],
      }),
    ];

    const report = computeSlaReport(invoices, ONE_DAY_MS);

    // Cumulative: 300 @ 1000, 700 @ 2000, 1000 @ 3000
    // Total owed = 1000, fully funded at timestamp 3000
    // Time to fund = (3000 - 1000) * 1000 = 2_000_000ms
    expect(report.withinSla).toBe(1);
    expect(report.avgTimeToFund).toBe(2_000_000);
  });
});
