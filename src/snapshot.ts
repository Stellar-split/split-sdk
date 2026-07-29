import { createHash } from "crypto";
import type { Invoice, Payment, SplitLeg, SplitRollbackCheckpoint } from "./types.js";

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

/** An immutable, persisted record of a split rollback checkpoint. */
export interface SplitRollbackRecord {
  snapshotId: string;
  capturedAt: number;
  checkpoint: Readonly<SplitRollbackCheckpoint>;
}

/**
 * Freeze a split rollback checkpoint into a persistable record, mirroring
 * the shape produced by {@link snapshotInvoice} for invoice state.
 */
export function snapshotSplitRollback(
  checkpoint: SplitRollbackCheckpoint
): SplitRollbackRecord {
  const capturedAt = Date.now();
  const snapshotId = createHash("sha256")
    .update(`${checkpoint.splitId}${capturedAt}`)
    .digest("hex");

  const frozenLegs = Object.freeze(
    checkpoint.legs.map((leg) => Object.freeze({ ...leg }))
  ) as Readonly<SplitLeg[]>;

  const frozenCheckpoint = Object.freeze({
    ...checkpoint,
    legs: frozenLegs,
  }) as Readonly<SplitRollbackCheckpoint>;

  return Object.freeze({
    snapshotId,
    capturedAt,
    checkpoint: frozenCheckpoint,
  });
}
