import type { Invoice } from "./types.js";
import { formatAmount, truncateAddress } from "./utils.js";
import { UnknownExportFormatError } from "./errors.js";
import { buildInvoicePdf } from "./exportPdf.js";

/** Export format for invoices. */
export type ExportFormat = "json" | "csv" | "text" | "pdf";

/** Styling options for PDF export. */
export interface PdfStylingOptions {
  /** Base font size in points. */
  fontSize?: number;
  /** Primary text color (hex, e.g. "#111111"). */
  textColor?: string;
  /** Accent/heading color (hex). */
  accentColor?: string;
  /** Page margins in points. */
  margin?: number;
  /** Document title. */
  title?: string;
}

/** Template descriptor for PDF export. */
export interface PdfTemplate {
  name: string;
  title?: string;
  styling?: PdfStylingOptions;
  /** Optional row builder override. */
  buildRows?: (invoice: Invoice) => InvoiceTableRow[];
}

/** Column definition for CSV export. */
export interface CsvColumn {
  /** Header label. */
  header: string;
  /** Value extractor for a given invoice. */
  value: (invoice: Invoice) => string;
}

/** Template descriptor for CSV export. */
export interface CsvTemplate {
  name: string;
  columns?: CsvColumn[];
}

/** Options accepted by exportInvoiceWithOptions. */
export interface ExportOptions {
  format: ExportFormat;
  template?: PdfTemplate | CsvTemplate | string;
  styling?: PdfStylingOptions;
}

/** Reusable invoice table rows. */
export interface InvoiceTableRow {
  text: string;
  bold?: boolean;
  indent?: number;
  title?: string;
}

/**
 * Build a standard invoice table for PDF export (reusable across templates).
 */
export function renderInvoiceTable(invoice: Invoice): InvoiceTableRow[] {
  const rows: InvoiceTableRow[] = [
    { text: "StellarSplit Invoice", bold: true, indent: 0 },
    { text: `Invoice ID: ${invoice.id}`, indent: 16 },
    { text: `Creator: ${invoice.creator ?? ""}`, indent: 16 },
    { text: `Token: ${invoice.token ?? ""}`, indent: 16 },
    { text: `Status: ${invoice.status ?? ""}`, indent: 16 },
    { text: `Deadline: ${new Date((invoice.deadline ?? 0) * 1000).toISOString()}`, indent: 16 },
    { text: `Funded: ${formatAmount(invoice.funded ?? 0n)}`, indent: 16 },
    { text: "", indent: 0 },
    { text: "Recipients", bold: true, indent: 0 },
  ];
  for (const r of invoice.recipients ?? []) {
    rows.push({ text: `${r.address}: ${formatAmount(r.amount)}`, indent: 32 });
  }
  rows.push({ text: "", indent: 0 });
  rows.push({ text: "Payments", bold: true, indent: 0 });
  for (const p of invoice.payments ?? []) {
    rows.push({ text: `${p.payer}: ${formatAmount(p.amount)}`, indent: 32 });
  }
  return rows;
}

/**
 * Export an invoice as PDF (A4, branded, reusable template).
 * Accepts optional template and styling overrides.
 */
export function exportAsPdf(
  invoice: Invoice,
  template?: PdfTemplate | string,
  styling?: PdfStylingOptions
): string {
  const resolvedTemplate = resolvePdfTemplate(template);
  const rows = resolvedTemplate?.buildRows
    ? resolvedTemplate.buildRows(invoice)
    : renderInvoiceTable(invoice);
  const mergedStyling: PdfStylingOptions = {
    ...(resolvedTemplate?.styling ?? {}),
    ...(styling ?? {}),
  };
  const title =
    mergedStyling.title ??
    resolvedTemplate?.title ??
    "StellarSplit Invoice";
  return buildInvoicePdf(title, rows, {
    title,
    fontSize: mergedStyling.fontSize,
    textColor: mergedStyling.textColor,
    accentColor: mergedStyling.accentColor,
    margin: mergedStyling.margin,
  });
}

/** Resolve a PDF template reference (object or registered name). */
function resolvePdfTemplate(
  template?: PdfTemplate | string
): PdfTemplate | undefined {
  if (!template) return undefined;
  if (typeof template === "string") return pdfTemplates.get(template);
  return template;
}

/** Registry of named PDF templates. */
const pdfTemplates = new Map<string, PdfTemplate>();

/** Register a named PDF template. */
export function registerPdfTemplate(template: PdfTemplate): void {
  pdfTemplates.set(template.name, template);
}

/** List registered PDF template names. */
export function listPdfTemplates(): string[] {
  return Array.from(pdfTemplates.keys());
}

/** Resolve a CSV template reference (object or registered name). */
function resolveCsvTemplate(
  template?: CsvTemplate | string
): CsvTemplate | undefined {
  if (!template) return undefined;
  if (typeof template === "string") return csvTemplates.get(template);
  return template;
}

/** Registry of named CSV templates. */
const csvTemplates = new Map<string, CsvTemplate>();

/** Register a named CSV template. */
export function registerCsvTemplate(template: CsvTemplate): void {
  csvTemplates.set(template.name, template);
}

/** List registered CSV template names. */
export function listCsvTemplates(): string[] {
  return Array.from(csvTemplates.keys());
}

/** Default CSV columns covering all invoice fields. */
export const DEFAULT_CSV_COLUMNS: CsvColumn[] = [
  { header: "ID", value: (i) => i.id },
  { header: "Creator", value: (i) => i.creator ?? "" },
  {
    header: "Recipients",
    value: (i) => (i.recipients ?? []).map((r) => `${r.address}:${r.amount}`).join("|"),
  },
  { header: "Token", value: (i) => i.token ?? "" },
  { header: "Deadline", value: (i) => String(i.deadline ?? "") },
  { header: "Funded", value: (i) => i.funded?.toString() ?? "0" },
  { header: "Status", value: (i) => i.status ?? "" },
  {
    header: "Payments",
    value: (i) => (i.payments ?? []).map((p) => `${p.payer}:${p.amount}`).join("|"),
  },
  { header: "Memo", value: (i) => i.memo ?? "" },
  { header: "ScheduledReleaseDate", value: (i) => String(i.scheduledReleaseDate ?? "") },
  { header: "ClonedFrom", value: (i) => i.clonedFrom ?? "" },
  { header: "GroupId", value: (i) => i.groupId ?? "" },
];

/** Escape a single CSV field per RFC 4180. */
export function escapeCsvField(value: string): string {
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

/**
 * Export an invoice with a unified options object.
 * Dispatches to PDF/CSV (and other formats) while preserving all fields.
 */
export function exportInvoiceWithOptions(
  invoice: Invoice,
  options: ExportOptions
): string {
  switch (options.format) {
    case "pdf":
      return exportAsPdf(
        invoice,
        options.template as PdfTemplate | string | undefined,
        options.styling
      );
    case "csv":
      return exportAsCsv(invoice, options.template as CsvTemplate | string | undefined);
    case "json":
      return exportAsJson(invoice);
    case "text":
      return exportAsText(invoice);
    default:
      throw new UnknownExportFormatError(options.format as string);
  }
}

/**
 * Export an invoice in the specified format.
 *
 * @param invoice - The invoice to export
 * @param format - Export format (json, csv, text, or pdf)
 * @returns Formatted invoice data as string
 */
export function exportInvoice(invoice: Invoice, format: ExportFormat): string {
  switch (format) {
    case "json": return exportAsJson(invoice);
    case "csv": return exportAsCsv(invoice);
    case "text": return exportAsText(invoice);
    case "pdf": return exportAsPdf(invoice);
    default:
      throw new UnknownExportFormatError(format as string);
  }
}

/** Export invoice as JSON with BigInt fields as strings. */
export function exportAsJson(invoice: Invoice): string {
  const data = {
    id: invoice.id,
    creator: invoice.creator,
    recipients: (invoice.recipients ?? []).map((r) => ({
      address: r.address,
      amount: r.amount.toString(),
    })),
    token: invoice.token,
    deadline: invoice.deadline,
    funded: invoice.funded.toString(),
    status: invoice.status,
    payments: (invoice.payments ?? []).map((p) => ({
      payer: p.payer,
      amount: p.amount.toString(),
    })),
    memo: invoice.memo ?? null,
    scheduledReleaseDate: invoice.scheduledReleaseDate ?? null,
    clonedFrom: invoice.clonedFrom ?? null,
    groupId: invoice.groupId ?? null,
  };
  return JSON.stringify(data, null, 2);
}

/**
 * Export invoice as CSV with proper escaping and optional template.
 * Preserves all invoice fields by default (no data loss).
 */
export function exportAsCsv(
  invoice: Invoice,
  template?: CsvTemplate | string
): string {
  const resolved = resolveCsvTemplate(template);
  const columns = resolved?.columns ?? DEFAULT_CSV_COLUMNS;
  const headers = columns.map((c) => escapeCsvField(c.header)).join(",");
  const row = columns.map((c) => escapeCsvField(c.value(invoice))).join(",");
  return [headers, row].join("\n");
}

/** Export invoice as human-readable text. */
export function exportAsText(invoice: Invoice): string {
  const lines: string[] = [];
  lines.push("=== StellarSplit Invoice ===");
  lines.push(`ID: ${invoice.id}`);
  lines.push(`Creator: ${truncateAddress(invoice.creator ?? "")}`);
  lines.push(`Status: ${invoice.status ?? ""}`);
  lines.push(`Token: ${truncateAddress(invoice.token ?? "")}`);
  lines.push(`Deadline: ${new Date((invoice.deadline ?? 0) * 1000).toISOString()}`);
  lines.push(`Funded: ${formatAmount(invoice.funded ?? 0n)} USDC`);
  lines.push("");
  lines.push("Recipients:");
  for (const recipient of invoice.recipients ?? []) {
    lines.push(
      `  - ${truncateAddress(recipient.address)}: ${formatAmount(recipient.amount)} USDC`
    );
  }
  if ((invoice.payments ?? []).length > 0) {
    lines.push("");
    lines.push("Payments:");
    for (const payment of invoice.payments ?? []) {
      lines.push(
        `  - ${truncateAddress(payment.payer)}: ${formatAmount(payment.amount)} USDC`
      );
    }
  }
  return lines.join("\n");
}

/**
 * Register a custom export format via a builder function.
 * Enables plugins to add formats (e.g. HTML, Markdown) without forking.
 */
export interface ExportBuilder {
  (invoice: Invoice): string;
  format: string;
}
const builders = new Map<string, ExportBuilder>();

export function registerExportBuilder(format: string, builder: ExportBuilder): void {
  builders.set(format, builder);
}

export function listExportBuilders(): string[] {
  return Array.from(builders.keys());
}

// Register built-in templates.
registerPdfTemplate({
  name: "default",
  title: "StellarSplit Invoice",
  styling: { fontSize: 12, margin: 40 },
});
registerCsvTemplate({
  name: "default",
  columns: DEFAULT_CSV_COLUMNS,
});
