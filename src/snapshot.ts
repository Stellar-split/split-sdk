import { createHash } from "crypto";
import type {
  Invoice,
  Payment,
  ReminderSchedule,
  SplitRollbackCheckpoint,
} from "./types.js";

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
// Stream dedup token persistence (Issue #530)
// ---------------------------------------------------------------------------

/** Pluggable persistence for a stream deduplicator's seen-token set. */
export interface DedupTokenStore {
  save(namespace: string, tokens: string[]): Promise<void>;
  load(namespace: string): Promise<string[] | null>;
}

/** In-memory token store; state is lost on process exit. */
export class InMemoryDedupTokenStore implements DedupTokenStore {
  private store = new Map<string, string[]>();

  async save(namespace: string, tokens: string[]): Promise<void> {
    this.store.set(namespace, [...tokens]);
  }

  async load(namespace: string): Promise<string[] | null> {
    return this.store.get(namespace) ?? null;
  }
}

let defaultDedupTokenStore: DedupTokenStore = new InMemoryDedupTokenStore();

/** Override the default dedup token store (e.g. with a durable backend). */
export function setDefaultDedupTokenStore(store: DedupTokenStore): void {
  defaultDedupTokenStore = store;
}

/** Persist a deduplicator's current token set under `namespace`. */
export async function saveDedupTokens(namespace: string, tokens: string[]): Promise<void> {
  await defaultDedupTokenStore.save(namespace, tokens);
}

/** Load a previously persisted token set for `namespace`, or null if none exists. */
export async function loadDedupTokens(namespace: string): Promise<string[] | null> {
  return defaultDedupTokenStore.load(namespace);
}

// ---------------------------------------------------------------------------
// Reminder schedule persistence (InvoiceReminderScheduler)
// ---------------------------------------------------------------------------

const REMINDER_SCHEDULES_KEY = "stellar_split_reminder_schedules";

function _hasLocalStorage(): boolean {
  return typeof localStorage !== "undefined" && localStorage !== null;
}

/**
 * Load the persisted reminder schedules from localStorage (browser) or return
 * an empty array in environments without localStorage (e.g. Node.js SSR).
 */
export function loadReminderSchedules(): ReminderSchedule[] {
  if (!_hasLocalStorage()) return [];
  const raw = localStorage.getItem(REMINDER_SCHEDULES_KEY);
  if (!raw) return [];
  try {
    return JSON.parse(raw) as ReminderSchedule[];
  } catch {
    return [];
  }
}

/** Persist the reminder schedules to localStorage. */
export function saveReminderSchedules(schedules: ReminderSchedule[]): void {
  if (!_hasLocalStorage()) return;
  localStorage.setItem(REMINDER_SCHEDULES_KEY, JSON.stringify(schedules));
}

// ---------------------------------------------------------------------------
// Split rollback checkpoint snapshots (SplitRollbackCoordinator)
// ---------------------------------------------------------------------------

/** Immutable snapshot of a split rollback checkpoint. */
export interface SplitRollbackRecord {
  /** SHA-256 identifier derived from the checkpoint contents + capture time. */
  snapshotId: string;
  /** Unix epoch ms when the snapshot was captured. */
  capturedAt: number;
  /** The frozen checkpoint this record snapshots. */
  checkpoint: Readonly<SplitRollbackCheckpoint>;
}

/**
 * Captures an immutable snapshot of a split rollback checkpoint so the
 * coordinator can prove, audit, and idempotently replay rollback state.
 */
export function snapshotSplitRollback(
  checkpoint: SplitRollbackCheckpoint,
): SplitRollbackRecord {
  const capturedAt = Date.now();
  const snapshotId = createHash("sha256")
    .update(`${checkpoint.splitId}${checkpoint.invoiceId}${capturedAt}`)
    .digest("hex");

  return Object.freeze({
    snapshotId,
    capturedAt,
    checkpoint: Object.freeze({
      ...checkpoint,
      legs: Object.freeze([...checkpoint.legs]),
    }),
  });
}
