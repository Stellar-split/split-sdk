import { createHash } from "crypto";
import type { Invoice, Payment, ReminderSchedule } from "./types.js";

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

// ---------------------------------------------------------------------------
// Invoice reminder schedule persistence (keyed by invoiceId)
// ---------------------------------------------------------------------------

const REMINDER_SCHEDULE_STORAGE_KEY = "stellar_split_reminder_schedules";

/**
 * Load all persisted reminder schedules (across every invoice).
 * Returns an empty array when no persistence layer is available (e.g. Node
 * without a `localStorage` polyfill) or nothing has been saved yet.
 */
export function loadReminderSchedules(): ReminderSchedule[] {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(REMINDER_SCHEDULE_STORAGE_KEY);
      return raw ? (JSON.parse(raw) as ReminderSchedule[]) : [];
    }
  } catch {
    /* no-op */
  }
  return [];
}

/** Persist the full set of reminder schedules, replacing any previous snapshot. */
export function saveReminderSchedules(schedules: ReminderSchedule[]): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(REMINDER_SCHEDULE_STORAGE_KEY, JSON.stringify(schedules));
    }
  } catch {
    /* no-op */
  }
}
