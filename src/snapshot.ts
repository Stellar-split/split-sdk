import { createHash } from "crypto";
import type { Invoice, Payment } from "./types.js";

export interface InvoiceSnapshot {
  snapshotId: string;
  capturedAt: number;
  invoice: Readonly<Invoice>;
  payments: Readonly<Payment[]>;
}

export function snapshotInvoice(invoice: Invoice): InvoiceSnapshot {
  const capturedAt = Date.now();
  const snapshotId = createHash("sha256")
    .update(`${invoice.id}${capturedAt}`)
    .digest("hex");

  const frozenPayments = Object.freeze(
    invoice.payments.map((p) => Object.freeze({ ...p }))
  ) as Readonly<Payment[]>;

  const frozenInvoice = Object.freeze({
    ...invoice,
    recipients: Object.freeze(invoice.recipients.map((r) => Object.freeze({ ...r }))),
    payments: frozenPayments,
  }) as Readonly<Invoice>;

  return Object.freeze({
    snapshotId,
    capturedAt,
    invoice: frozenInvoice,
    payments: frozenPayments,
  });
}
