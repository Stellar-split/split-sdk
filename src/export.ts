import type { Invoice } from "./types.js";
import { formatAmount, truncateAddress } from "./utils.js";

/** Export format for invoices. */
export type ExportFormat = "json" | "csv" | "text";

/**
 * Export an invoice in the specified format.
 *
 * @param invoice - The invoice to export
 * @param format - Export format (json, csv, or text)
 * @returns Formatted invoice data as string
 */
export function exportInvoice(invoice: Invoice, format: ExportFormat): string {
  switch (format) {
    case "json":
      return exportAsJson(invoice);
    case "csv":
      return exportAsCsv(invoice);
    case "text":
      return exportAsText(invoice);
    default:
      throw new Error(`Unknown export format: ${format}`);
  }
}

/** Export invoice as JSON with BigInt fields as strings. */
function exportAsJson(invoice: Invoice): string {
  const data = {
    id: invoice.id,
    creator: invoice.creator,
    recipients: invoice.recipients.map((r) => ({
      address: r.address,
      amount: r.amount.toString(),
    })),
    token: invoice.token,
    deadline: invoice.deadline,
    funded: invoice.funded.toString(),
    status: invoice.status,
    payments: invoice.payments.map((p) => ({
      payer: p.payer,
      amount: p.amount.toString(),
    })),
  };
  return JSON.stringify(data, null, 2);
}

/** Export invoice as CSV. */
function exportAsCsv(invoice: Invoice): string {
  const headers = [
    "ID",
    "Creator",
    "Recipients",
    "Token",
    "Deadline",
    "Funded",
    "Status",
    "Payments",
  ];

  const recipients = invoice.recipients
    .map((r) => `${r.address}:${r.amount}`)
    .join("|");
  const payments = invoice.payments
    .map((p) => `${p.payer}:${p.amount}`)
    .join("|");

  const row = [
    invoice.id,
    invoice.creator,
    recipients,
    invoice.token,
    invoice.deadline,
    invoice.funded.toString(),
    invoice.status,
    payments,
  ];

  return [headers.join(","), row.join(",")].join("\n");
}

/** Export invoice as human-readable text. */
function exportAsText(invoice: Invoice): string {
  const lines: string[] = [];
  lines.push("=== StellarSplit Invoice ===");
  lines.push(`ID: ${invoice.id}`);
  lines.push(`Creator: ${truncateAddress(invoice.creator)}`);
  lines.push(`Status: ${invoice.status}`);
  lines.push(`Token: ${truncateAddress(invoice.token)}`);
  lines.push(`Deadline: ${new Date(invoice.deadline * 1000).toISOString()}`);
  lines.push(`Funded: ${formatAmount(invoice.funded)} USDC`);
  lines.push("");
  lines.push("Recipients:");
  for (const recipient of invoice.recipients) {
    lines.push(
      `  - ${truncateAddress(recipient.address)}: ${formatAmount(recipient.amount)} USDC`
    );
  }
  if (invoice.payments.length > 0) {
    lines.push("");
    lines.push("Payments:");
    for (const payment of invoice.payments) {
      lines.push(
        `  - ${truncateAddress(payment.payer)}: ${formatAmount(payment.amount)} USDC`
      );
    }
  }
  return lines.join("\n");
}
