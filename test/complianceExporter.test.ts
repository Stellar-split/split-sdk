import { describe, it, expect } from "vitest";
import {
  exportComplianceReport,
  CSV_COLUMNS,
} from "../src/complianceExporter.js";
import type { Invoice } from "../src/types.js";

const BASE = 1_700_000_000;

const invoices: Invoice[] = [
  {
    id: "1",
    creator: "GCREATOR1",
    recipients: [{ address: "GREC1", amount: 100n }],
    token: "USDC",
    deadline: BASE,
    funded: 500n,
    status: "Released",
    payments: [
      { payer: "GPAYER1", amount: 300n, timestamp: BASE - 100, ledger: 42 },
      { payer: "GPAYER2", amount: 200n, timestamp: BASE - 50 },
    ],
  },
  {
    id: "2",
    creator: "GCREATOR2",
    recipients: [{ address: "GREC2", amount: 200n }],
    token: "USDC",
    deadline: BASE + 1000,
    funded: 0n,
    status: "Pending",
    payments: [],
    memo: "no payments yet",
  },
  {
    id: "3",
    creator: "GCREATOR1",
    recipients: [{ address: "GREC3", amount: 50n }],
    token: "USDC",
    deadline: BASE - 5000,
    funded: 50n,
    status: "Refunded",
    payments: [{ payer: "GPAYER3", amount: 50n }],
  },
];

describe("exportComplianceReport", () => {
  it("includes invoices whose deadline falls on the from/to boundaries (inclusive)", () => {
    const { records } = exportComplianceReport(invoices, {
      from: BASE,
      to: BASE + 1000,
    });
    const ids = [...new Set(records.map((r) => r.invoiceId))];
    expect(ids).toContain("1");
    expect(ids).toContain("2");
    expect(ids).not.toContain("3");
  });

  it("excludes invoices strictly outside the date range", () => {
    const { records } = exportComplianceReport(invoices, {
      from: BASE + 1,
      to: BASE + 999,
    });
    const ids = records.map((r) => r.invoiceId);
    expect(ids).not.toContain("1");
    expect(ids).not.toContain("2");
    expect(ids).not.toContain("3");
  });

  it("produces one record per payment for invoices with payments", () => {
    const { records } = exportComplianceReport(invoices, {
      from: BASE,
      to: BASE,
    });
    expect(records).toHaveLength(2);
    expect(records[0]!.payerAddress).toBe("GPAYER1");
    expect(records[1]!.payerAddress).toBe("GPAYER2");
  });

  it("produces one row with empty payment fields for invoices with no payments", () => {
    const { records } = exportComplianceReport(invoices, {
      from: BASE + 1000,
      to: BASE + 1000,
    });
    expect(records).toHaveLength(1);
    expect(records[0]!.invoiceId).toBe("2");
    expect(records[0]!.payerAddress).toBe("");
    expect(records[0]!.paymentAmount).toBe(0n);
    expect(records[0]!.paymentTimestamp).toBeNull();
    expect(records[0]!.paymentLedger).toBeNull();
  });

  it("creator filter narrows results to invoices by that creator only", () => {
    const { records } = exportComplianceReport(invoices, {
      from: BASE,
      to: BASE + 1000,
      creator: "GCREATOR1",
    });
    expect(records.every((r) => r.creator === "GCREATOR1")).toBe(true);
    const ids = [...new Set(records.map((r) => r.invoiceId))];
    expect(ids).toContain("1");
    expect(ids).not.toContain("2");
  });

  it("returns an empty result when no invoices match", () => {
    const { csv, records } = exportComplianceReport(invoices, {
      from: 0,
      to: 1,
    });
    expect(records).toHaveLength(0);
    expect(csv).toBe(CSV_COLUMNS.join(","));
  });

  it("CSV column order is stable (snapshot)", () => {
    expect(CSV_COLUMNS).toEqual([
      "invoiceId",
      "creator",
      "status",
      "token",
      "deadline",
      "funded",
      "payerAddress",
      "paymentAmount",
      "paymentTimestamp",
      "paymentLedger",
      "memo",
    ]);
  });

  it("CSV header matches CSV_COLUMNS exactly", () => {
    const { csv } = exportComplianceReport(invoices, {
      from: BASE,
      to: BASE + 1000,
    });
    const header = csv.split("\n")[0];
    expect(header).toBe(CSV_COLUMNS.join(","));
  });

  it("CSV data rows reflect record field values in column order", () => {
    const { csv, records } = exportComplianceReport(invoices, {
      from: BASE,
      to: BASE,
    });
    const [, firstRow] = csv.split("\n");
    const r = records[0]!;
    const expected = [
      r.invoiceId,
      r.creator,
      r.status,
      r.token,
      String(r.deadline),
      String(r.funded),
      r.payerAddress,
      String(r.paymentAmount),
      String(r.paymentTimestamp),
      String(r.paymentLedger),
      r.memo,
    ].join(",");
    expect(firstRow).toBe(expected);
  });

  it("escapes memo fields that contain commas", () => {
    const inv: Invoice = {
      id: "99",
      creator: "GCREATOR1",
      recipients: [],
      token: "USDC",
      deadline: BASE,
      funded: 0n,
      status: "Pending",
      payments: [],
      memo: "service, consulting",
    };
    const { csv } = exportComplianceReport([inv], {
      from: BASE,
      to: BASE,
    });
    const dataRow = csv.split("\n")[1]!;
    expect(dataRow.endsWith('"service, consulting"')).toBe(true);
  });
});
