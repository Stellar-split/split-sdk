import { describe, it, expect } from "vitest";
import { computeCreatorReputation } from "../src/reputation.js";
import type { Invoice, InvoiceStatus } from "../src/types.js";

function makeInvoice(
  id: string,
  status: InvoiceStatus,
  overrides: Partial<Invoice> = {}
): Invoice {
  return {
    id,
    creator: "GCREATOR",
    recipients: [{ address: "GPAYEE", amount: 1000n }],
    token: "USDC",
    deadline: 1_800_000_000,
    funded: status === "Released" ? 1000n : 0n,
    status,
    payments: [],
    ...overrides,
  };
}

describe("computeCreatorReputation", () => {
  it("returns zero score for empty invoices array", () => {
    const score = computeCreatorReputation([]);
    expect(score.totalInvoices).toBe(0);
    expect(score.overallScore).toBe(0);
  });

  it("calculates completion rate correctly", () => {
    const invoices = [
      makeInvoice("1", "Released"),
      makeInvoice("2", "Released"),
      makeInvoice("3", "Pending"),
    ];

    const score = computeCreatorReputation(invoices);
    expect(score.totalInvoices).toBe(3);
    expect(score.completedInvoices).toBe(2);
    expect(score.completionRate).toBe(2 / 3);
  });

  it("calculates dispute rate correctly", () => {
    const invoices = [
      makeInvoice("1", "Released"),
      makeInvoice("2", "Refunded"),
      makeInvoice("3", "Pending"),
    ];

    const score = computeCreatorReputation(invoices);
    expect(score.disputedInvoices).toBe(1);
    expect(score.disputeRate).toBe(1 / 3);
  });

  it("computes average funding time from payment timestamps", () => {
    const invoices = [
      makeInvoice("1", "Released", {
        payments: [
          { payer: "GPAYER", amount: 1000n, timestamp: 1_800_100_000 },
        ],
      }),
    ];

    const score = computeCreatorReputation(invoices);
    expect(score.averageFundingTimeSeconds).not.toBeNull();
  });

  it("sets averageFundingTimeSeconds to null when no completed invoices have payments", () => {
    const invoices = [
      makeInvoice("1", "Released", { payments: [] }),
      makeInvoice("2", "Pending"),
    ];

    const score = computeCreatorReputation(invoices);
    expect(score.averageFundingTimeSeconds).toBeNull();
  });

  it("produces overallScore between 0 and 1", () => {
    const invoices = [
      makeInvoice("1", "Released"),
      makeInvoice("2", "Released"),
      makeInvoice("3", "Pending"),
    ];

    const score = computeCreatorReputation(invoices);
    expect(score.overallScore).toBeGreaterThanOrEqual(0);
    expect(score.overallScore).toBeLessThanOrEqual(1);
  });

  it("uses custom weights when provided", () => {
    const invoices = [
      makeInvoice("1", "Released"),
    ];

    const defaultScore = computeCreatorReputation(invoices);
    const customScore = computeCreatorReputation(invoices, {
      completionWeight: 1,
      fundingTimeWeight: 0,
      disputeWeight: 0,
    });

    expect(customScore.overallScore).toBe(1);
  });

  it("uses creator from first invoice", () => {
    const invoices = [
      makeInvoice("1", "Released"),
      makeInvoice("2", "Pending"),
    ];

    const score = computeCreatorReputation(invoices);
    expect(score.creator).toBe("GCREATOR");
  });
});
