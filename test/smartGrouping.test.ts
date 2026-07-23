import { describe, it, expect } from "vitest";
import { groupInvoicesByPattern } from "../src/index.ts";

describe("groupInvoicesByPattern", () => {
  it("clusters invoices into two groups of three based on recipients, token, amount, and memo prefix", () => {
    const invoices = [
      {
        id: "1",
        creator: "GCREATOR",
        recipients: [
          { address: "GRECIPIENT1", amount: 1000n },
          { address: "GRECIPIENT2", amount: 2000n },
        ],
        token: "USDCToken",
        deadline: 1700000000,
        funded: 0n,
        status: "Pending" as const,
        payments: [],
        memo: "Payroll January",
      },
      {
        id: "2",
        creator: "GCREATOR",
        recipients: [
          { address: "GRECIPIENT2", amount: 2000n },
          { address: "GRECIPIENT1", amount: 1000n },
        ],
        token: "USDCToken",
        deadline: 1700000000,
        funded: 0n,
        status: "Pending" as const,
        payments: [],
        memo: "Payroll February",
      },
      {
        id: "3",
        creator: "GCREATOR",
        recipients: [
          { address: "GRECIPIENT1", amount: 950n },
          { address: "GRECIPIENT2", amount: 2050n },
        ],
        token: "USDCToken",
        deadline: 1700000000,
        funded: 0n,
        status: "Pending" as const,
        payments: [],
        memo: "Payroll March",
      },
      {
        id: "4",
        creator: "GCREATOR",
        recipients: [
          { address: "GRECIPIENT3", amount: 5000n },
          { address: "GRECIPIENT4", amount: 2500n },
        ],
        token: "USDCToken",
        deadline: 1700000000,
        funded: 0n,
        status: "Pending" as const,
        payments: [],
        memo: "Rent January",
      },
      {
        id: "5",
        creator: "GCREATOR",
        recipients: [
          { address: "GRECIPIENT4", amount: 2500n },
          { address: "GRECIPIENT3", amount: 5000n },
        ],
        token: "USDCToken",
        deadline: 1700000000,
        funded: 0n,
        status: "Pending" as const,
        payments: [],
        memo: "Rent February",
      },
      {
        id: "6",
        creator: "GCREATOR",
        recipients: [
          { address: "GRECIPIENT3", amount: 5200n },
          { address: "GRECIPIENT4", amount: 2300n },
        ],
        token: "USDCToken",
        deadline: 1700000000,
        funded: 0n,
        status: "Pending" as const,
        payments: [],
        memo: "Rent March",
      },
    ];

    const clusters = groupInvoicesByPattern(invoices);

    expect(clusters).toHaveLength(2);
    expect(clusters[0]!.invoices).toHaveLength(3);
    expect(clusters[1]!.invoices).toHaveLength(3);

    const allInvoiceIds = clusters.flatMap((cluster) => cluster.invoices.map((invoice) => invoice.id));
    expect(new Set(allInvoiceIds)).toEqual(new Set(invoices.map((invoice) => invoice.id)));

    expect(clusters[0]!.label).toContain("USDCToken");
    expect(clusters[1]!.label).toContain("USDCToken");
    expect(clusters[0]!.similarity).toBeGreaterThan(0);
    expect(clusters[1]!.similarity).toBeGreaterThan(0);
  });
});
