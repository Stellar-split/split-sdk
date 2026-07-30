/**
 * Tests for InvoiceCloneabilityValidator (#486)
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Horizon, rpc as SorobanRpc } from "@stellar/stellar-sdk";
import {
  InvoiceCloneabilityValidator,
} from "../src/preflight/InvoiceCloneabilityValidator.js";
import type { CloneabilityReport } from "../src/preflight/InvoiceCloneabilityValidator.js";
import { InvoiceNotCloneableError } from "../src/errors.js";
import type { Invoice } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADDR_A = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const ADDR_B = "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPGQS7Z5H4M3I5K6XTLCPUDVKL";

const FUTURE_DEADLINE = Math.floor(Date.now() / 1_000) + 86_400 * 7; // 7 days from now
const PAST_DEADLINE   = Math.floor(Date.now() / 1_000) - 3_600;       // 1 hour ago

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "42",
    creator: ADDR_A,
    recipients: [{ address: ADDR_B, amount: 100_000_000n }],
    token: "native",
    deadline: FUTURE_DEADLINE,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  } as Invoice;
}

/** Minimal healthy AccountResponse mock */
function makeAcct(xlm = 10) {
  return {
    sequenceNumber: () => "100",
    subentry_count: 0,
    balances: [
      {
        asset_type: "native" as const,
        balance: xlm.toFixed(7),
        buying_liabilities: "0",
        selling_liabilities: "0",
      },
    ],
  };
}

let loadAccountSpy: ReturnType<typeof vi.spyOn>;
let getLatestLedgerSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  loadAccountSpy = vi.spyOn(Horizon.Server.prototype, "loadAccount") as ReturnType<typeof vi.spyOn>;
  loadAccountSpy.mockResolvedValue(makeAcct() as any);

  getLatestLedgerSpy = vi.spyOn(SorobanRpc.Server.prototype, "getLatestLedger") as ReturnType<typeof vi.spyOn>;
  // Return ledger close time = now (so future deadlines pass)
  getLatestLedgerSpy.mockResolvedValue({
    id: "1",
    sequence: 1000,
    closeTime: Math.floor(Date.now() / 1_000),
  } as any);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InvoiceCloneabilityValidator — status check", () => {
  it("blocks cloning a Cancelled invoice", async () => {
    const invoice = makeInvoice({ status: "Cancelled" });
    const validator = new InvoiceCloneabilityValidator({ rpcUrl: "https://rpc.example.com" });
    const report = await validator.validate(invoice);

    expect(report.cloneable).toBe(false);
    const statusField = report.fieldReports.find((f) => f.field === "status");
    expect(statusField).toBeDefined();
    expect(statusField!.valid).toBe(false);
    expect(statusField!.reason).toMatch(/Cancelled/i);
  });

  it("blocks cloning a Disputed invoice", async () => {
    const invoice = makeInvoice({ status: "Disputed" as any });
    const validator = new InvoiceCloneabilityValidator();
    const report = await validator.validate(invoice);

    const statusField = report.fieldReports.find((f) => f.field === "status");
    expect(statusField!.valid).toBe(false);
  });

  it("allows cloning a Pending invoice", async () => {
    const invoice = makeInvoice({ status: "Pending" });
    const validator = new InvoiceCloneabilityValidator({ rpcUrl: "https://rpc.example.com" });
    const report = await validator.validate(invoice);

    const statusField = report.fieldReports.find((f) => f.field === "status");
    expect(statusField).toBeUndefined();
  });

  it("allows cloning a Released invoice", async () => {
    const invoice = makeInvoice({ status: "Released" });
    const validator = new InvoiceCloneabilityValidator({ rpcUrl: "https://rpc.example.com" });
    const report = await validator.validate(invoice);

    const statusField = report.fieldReports.find((f) => f.field === "status");
    expect(statusField).toBeUndefined();
  });
});

describe("InvoiceCloneabilityValidator — deadline check", () => {
  it("blocks cloning when deadline is in the past", async () => {
    const invoice = makeInvoice({ deadline: PAST_DEADLINE });
    const validator = new InvoiceCloneabilityValidator({
      rpcUrl: "https://rpc.example.com",
      minDeadlineBufferMs: 3_600_000,
    });
    const report = await validator.validate(invoice);

    const deadlineField = report.fieldReports.find((f) => f.field === "deadline");
    expect(deadlineField).toBeDefined();
    expect(deadlineField!.valid).toBe(false);
    expect(deadlineField!.reason).toMatch(/past|buffer/i);
    expect(deadlineField!.suggestedFix).toMatch(/newDeadline/);
  });

  it("passes when deadline is sufficiently in the future", async () => {
    const invoice = makeInvoice({ deadline: FUTURE_DEADLINE });
    const validator = new InvoiceCloneabilityValidator({
      rpcUrl: "https://rpc.example.com",
      minDeadlineBufferMs: 3_600_000,
    });
    const report = await validator.validate(invoice);

    const deadlineField = report.fieldReports.find((f) => f.field === "deadline");
    expect(deadlineField).toBeUndefined();
  });

  it("uses ledger close time (not Date.now) for the deadline check", async () => {
    // Set ledger time 2 hours in the future — deadline that appears "past" by wall
    // clock should pass because ledger time is what matters
    const futureLedgerTime = Math.floor(Date.now() / 1_000) - 7_200; // 2h behind
    getLatestLedgerSpy.mockResolvedValue({
      id: "1",
      sequence: 1000,
      closeTime: futureLedgerTime,
    } as any);

    // Deadline is 1h from "now" but 3h from ledger time → passes with 1h buffer
    const deadline = Math.floor(Date.now() / 1_000) + 3_600;
    const invoice = makeInvoice({ deadline });
    const validator = new InvoiceCloneabilityValidator({
      rpcUrl: "https://rpc.example.com",
      minDeadlineBufferMs: 3_600_000, // 1 hour
    });
    const report = await validator.validate(invoice);

    // ledger time is 2h behind now, so deadline - ledgerTime = 3h which is > 1h buffer
    const deadlineField = report.fieldReports.find((f) => f.field === "deadline");
    expect(deadlineField).toBeUndefined();
  });
});

describe("InvoiceCloneabilityValidator — recipient checks", () => {
  it("returns failing field report for a removed recipient", async () => {
    loadAccountSpy.mockRejectedValue(new Error("Not Found"));

    const invoice = makeInvoice();
    const validator = new InvoiceCloneabilityValidator({ rpcUrl: "https://rpc.example.com" });
    const report = await validator.validate(invoice);

    const recipientField = report.fieldReports.find((f) =>
      f.field.startsWith("recipients["),
    );
    expect(recipientField).toBeDefined();
    expect(recipientField!.valid).toBe(false);
  });

  it("returns no recipient issues when all accounts are healthy", async () => {
    loadAccountSpy.mockResolvedValue(makeAcct() as any);

    const invoice = makeInvoice();
    const validator = new InvoiceCloneabilityValidator({ rpcUrl: "https://rpc.example.com" });
    const report = await validator.validate(invoice);

    const recipientFields = report.fieldReports.filter((f) =>
      f.field.startsWith("recipients["),
    );
    expect(recipientFields).toHaveLength(0);
  });
});

describe("InvoiceCloneabilityValidator — combined", () => {
  it("returns two failing FieldReport entries for expired deadline + removed recipient", async () => {
    loadAccountSpy.mockRejectedValue(new Error("Not Found"));

    const invoice = makeInvoice({ deadline: PAST_DEADLINE });
    const validator = new InvoiceCloneabilityValidator({
      rpcUrl: "https://rpc.example.com",
      minDeadlineBufferMs: 3_600_000,
    });
    const report = await validator.validate(invoice);

    expect(report.cloneable).toBe(false);
    expect(report.fieldReports.length).toBeGreaterThanOrEqual(2);
    expect(report.fieldReports.some((f) => f.field === "deadline")).toBe(true);
    expect(report.fieldReports.some((f) => f.field.startsWith("recipients["))).toBe(true);
  });

  it("returns cloneable: true with empty fieldReports for a fully valid invoice", async () => {
    const invoice = makeInvoice();
    const validator = new InvoiceCloneabilityValidator({ rpcUrl: "https://rpc.example.com" });
    const report = await validator.validate(invoice);

    expect(report.cloneable).toBe(true);
    expect(report.fieldReports).toHaveLength(0);
  });
});

describe("InvoiceNotCloneableError", () => {
  it("embeds the full CloneabilityReport in .details", () => {
    const report: CloneabilityReport = {
      invoiceId: "99",
      cloneable: false,
      fieldReports: [
        {
          field: "deadline",
          valid: false,
          reason: "expired",
          suggestedFix: "set a new deadline",
        },
      ],
    };

    const err = new InvoiceNotCloneableError(report);
    expect(err.details).toBe(report);
    expect(err.code).toBe("INVOICE_NOT_CLONEABLE");
    expect(err.message).toContain("99");
    expect(err.message).toContain("deadline");
  });

  it("is instanceof StellarSplitError", async () => {
    const { StellarSplitError } = await import("../src/errors.js");
    const err = new InvoiceNotCloneableError({
      invoiceId: "1",
      cloneable: false,
      fieldReports: [],
    });
    expect(err).toBeInstanceOf(StellarSplitError);
  });
});
