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
