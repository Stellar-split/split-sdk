import type { Invoice } from "./types.js";

/** A single row in the compliance audit export. */
export interface ComplianceExportRecord {
  invoiceId: string;
  creator: string;
  status: string;
  token: string;
  /** Unix timestamp in seconds. */
  deadline: number;
  /** Total funded amount in stroops. */
  funded: bigint;
  /** Payer address, or empty string when no payment exists for this row. */
  payerAddress: string;
  /** Payment amount in stroops, or 0n when no payment exists for this row. */
  paymentAmount: bigint;
  /** Unix timestamp in seconds when the payment was made, or null. */
  paymentTimestamp: number | null;
  /** Ledger sequence number when the payment was recorded, or null. */
  paymentLedger: number | null;
  memo: string;
}

/** Options for filtering the compliance export. */
export interface ComplianceExportOptions {
  /** Start of date range (Unix timestamp in seconds, inclusive). */
  from: number;
  /** End of date range (Unix timestamp in seconds, inclusive). */
  to: number;
  /** Optional creator address filter — narrows results to invoices by this creator. */
  creator?: string;
}

/** Result returned by {@link exportComplianceReport}. */
export interface ComplianceExportResult {
  /** CSV string with a stable header row followed by one data row per payment. */
  csv: string;
  /** Typed records corresponding to each CSV data row. */
  records: ComplianceExportRecord[];
}

/**
 * Stable, ordered list of CSV column names.
 * Column order is guaranteed — tests snapshot this to catch accidental reordering.
 */
export const CSV_COLUMNS = [
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
] as const;

/**
 * Produces a regulator/auditor-friendly CSV export and typed records for
 * invoices whose `deadline` falls within `[from, to]` (both inclusive).
 *
 * Each payment in a matched invoice produces its own row. Invoices with no
 * payments produce a single row with empty payment fields.
 */
export function exportComplianceReport(
  invoices: Invoice[],
  options: ComplianceExportOptions,
): ComplianceExportResult {
  const { from, to, creator } = options;

  const filtered = invoices.filter((inv) => {
    if (inv.deadline < from || inv.deadline > to) return false;
    if (creator !== undefined && inv.creator !== creator) return false;
    return true;
  });

  const records: ComplianceExportRecord[] = [];

  for (const inv of filtered) {
    if (inv.payments.length === 0) {
      records.push({
        invoiceId: inv.id,
        creator: inv.creator,
        status: inv.status,
        token: inv.token,
        deadline: inv.deadline,
        funded: inv.funded,
        payerAddress: "",
        paymentAmount: 0n,
        paymentTimestamp: null,
        paymentLedger: null,
        memo: inv.memo ?? "",
      });
    } else {
      for (const payment of inv.payments) {
        records.push({
          invoiceId: inv.id,
          creator: inv.creator,
          status: inv.status,
          token: inv.token,
          deadline: inv.deadline,
          funded: inv.funded,
          payerAddress: payment.payer,
          paymentAmount: payment.amount,
          paymentTimestamp: payment.timestamp ?? null,
          paymentLedger: payment.ledger ?? null,
          memo: inv.memo ?? "",
        });
      }
    }
  }

  const csv = buildCsv(records);
  return { csv, records };
}

function buildCsv(records: ComplianceExportRecord[]): string {
  const header = CSV_COLUMNS.join(",");
  const rows = records.map((r) =>
    [
      r.invoiceId,
      r.creator,
      r.status,
      r.token,
      String(r.deadline),
      String(r.funded),
      r.payerAddress,
      String(r.paymentAmount),
      r.paymentTimestamp !== null ? String(r.paymentTimestamp) : "",
      r.paymentLedger !== null ? String(r.paymentLedger) : "",
      csvEscape(r.memo),
    ].join(","),
  );
  return [header, ...rows].join("\n");
}

function csvEscape(value: string): string {
  if (value.includes(",") || value.includes('"') || value.includes("\n")) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}
