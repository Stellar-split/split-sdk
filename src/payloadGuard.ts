import type { CreateInvoiceParams, Recipient } from "./types.js";

export const DEFAULT_MAX_INVOICE_SIZE_BYTES = 8_192;
export const DEFAULT_MAX_RECIPIENTS = 50;
export const DEFAULT_MAX_MEMO_LENGTH = 512;

export interface PayloadGuardConfig {
  maxInvoiceSizeBytes?: number;
  maxRecipients?: number;
  maxMemoLength?: number;
}

export interface PayloadViolation {
  field: string;
  issue: string;
  actual: number;
  limit: number;
}

export class PayloadSizeError extends Error {
  readonly violations: PayloadViolation[];

  constructor(violations: PayloadViolation[]) {
    const messages = violations.map(
      (v) => `${v.field}: ${v.issue} (${v.actual} > ${v.limit})`
    );
    super(`Invoice payload too large:\n${messages.join("\n")}`);
    this.name = "PayloadSizeError";
    this.violations = violations;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function validateInvoicePayload(
  params: CreateInvoiceParams,
  config?: PayloadGuardConfig
): void {
  const maxSize = config?.maxInvoiceSizeBytes ?? DEFAULT_MAX_INVOICE_SIZE_BYTES;
  const maxRecipients = config?.maxRecipients ?? DEFAULT_MAX_RECIPIENTS;
  const maxMemoLength = config?.maxMemoLength ?? DEFAULT_MAX_MEMO_LENGTH;

  const violations: PayloadViolation[] = [];

  if (params.recipients.length > maxRecipients) {
    violations.push({
      field: "recipients",
      issue: "Too many recipients",
      actual: params.recipients.length,
      limit: maxRecipients,
    });
  }

  for (const r of params.recipients) {
    if (r.address.length > 56) {
      violations.push({
        field: `recipient[].address`,
        issue: "Address exceeds Stellar length",
        actual: r.address.length,
        limit: 56,
      });
    }
  }

  const serialized = serializePayload(params);
  const sizeBytes = new TextEncoder().encode(serialized).length;

  if (sizeBytes > maxSize) {
    violations.push({
      field: "payload",
      issue: "Total serialized size exceeds limit",
      actual: sizeBytes,
      limit: maxSize,
    });
  }

  if (params.memo !== undefined && params.memo.length > maxMemoLength) {
    violations.push({
      field: "memo",
      issue: "Memo too long",
      actual: params.memo.length,
      limit: maxMemoLength,
    });
  }

  if (violations.length > 0) {
    throw new PayloadSizeError(violations);
  }
}

function serializePayload(params: CreateInvoiceParams): string {
  const recipientsStr = params.recipients
    .map((r) => `${r.address}:${r.amount.toString()}`)
    .join(",");
  return `${params.creator}|${params.token}|${params.deadline}|${recipientsStr}|${params.memo ?? ""}`;
}
