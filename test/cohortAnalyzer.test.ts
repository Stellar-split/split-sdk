import { describe, it, expect } from "vitest";
import { analyzeCohorts } from "../src/cohortAnalyzer.js";
import type { Invoice } from "../src/types.js";

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "1",
    creator: "GCREATOR",
    recipients: [{ address: "GRECIPI", amount: 100n }],
    token: "TOKEN",
    deadline: 0,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

// 2024-01-08 00:00:00 UTC (Monday, week of Jan 8)
const JAN_08_2024 = 1704672000;
// 2024-01-15 00:00:00 UTC (Monday, week of Jan 15)
const JAN_15_2024 = 1705276800;
// 2024-02-01 00:00:00 UTC
const FEB_01_2024 = 1706745600;

describe("analyzeCohorts — weekly bucketing", () => {
  it("places invoices in the correct week buckets", () => {
    const invoices = [
      makeInvoice({ id: "1", deadline: JAN_08_2024, status: "Released" }),
      makeInvoice({ id: "2", deadline: JAN_08_2024 + 86400, status: "Pending" }),
      makeInvoice({ id: "3", deadline: JAN_15_2024, status: "Released" }),
    ];
    const result = analyzeCohorts(invoices, "week");
    expect(result).toHaveLength(2);
    expect(result[0]!.total).toBe(2);
    expect(result[0]!.completed).toBe(1);
    expect(result[0]!.completionRate).toBeCloseTo(0.5);
    expect(result[1]!.total).toBe(1);
    expect(result[1]!.completed).toBe(1);
    expect(result[1]!.completionRate).toBe(1);
  });

  it("orders buckets ascending by period key", () => {
    const invoices = [
      makeInvoice({ id: "a", deadline: JAN_15_2024, status: "Pending" }),
      makeInvoice({ id: "b", deadline: JAN_08_2024, status: "Released" }),
    ];
    const result = analyzeCohorts(invoices, "week");
    expect(result[0]!.period < result[1]!.period).toBe(true);
  });
});

describe("analyzeCohorts — monthly bucketing", () => {
  it("places invoices in the correct month buckets", () => {
    const invoices = [
      makeInvoice({ id: "1", deadline: JAN_08_2024, status: "Released" }),
      makeInvoice({ id: "2", deadline: JAN_15_2024, status: "Released" }),
      makeInvoice({ id: "3", deadline: FEB_01_2024, status: "Pending" }),
    ];
    const result = analyzeCohorts(invoices, "month");
    expect(result).toHaveLength(2);
    expect(result[0]!.period).toBe("2024-01");
    expect(result[0]!.total).toBe(2);
    expect(result[0]!.completed).toBe(2);
    expect(result[0]!.completionRate).toBe(1);
    expect(result[1]!.period).toBe("2024-02");
    expect(result[1]!.total).toBe(1);
    expect(result[1]!.completed).toBe(0);
    expect(result[1]!.completionRate).toBe(0);
  });
});

describe("analyzeCohorts — sparse-period handling", () => {
  it("returns empty array for empty input", () => {
    expect(analyzeCohorts([], "week")).toEqual([]);
  });

  it("handles non-contiguous periods without gaps breaking ordering", () => {
    const invoices = [
      makeInvoice({ id: "1", deadline: JAN_08_2024, status: "Released" }),
      makeInvoice({ id: "2", deadline: FEB_01_2024, status: "Pending" }),
    ];
    const result = analyzeCohorts(invoices, "month");
    expect(result).toHaveLength(2);
    expect(result[0]!.period).toBe("2024-01");
    expect(result[1]!.period).toBe("2024-02");
  });

  it("completionRate is 0 for periods with no Released invoices", () => {
    const invoices = [
      makeInvoice({ id: "1", deadline: JAN_08_2024, status: "Pending" }),
      makeInvoice({ id: "2", deadline: JAN_08_2024 + 3600, status: "Refunded" }),
    ];
    const result = analyzeCohorts(invoices, "month");
    expect(result).toHaveLength(1);
    expect(result[0]!.completionRate).toBe(0);
  });
});
