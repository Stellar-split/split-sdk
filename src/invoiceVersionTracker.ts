/**
 * Invoice Version History Diff Tracker
 *
 * Records ordered, immutable snapshots of invoice state on every update.
 * Each version includes the full invoice snapshot, the author, timestamp, and
 * a structured change summary derived from src/diff.ts.
 *
 * Integrates with src/client.ts updateInvoice() which creates a new version
 * before overwriting the stored invoice.
 *
 * Snapshots are stored in memory keyed by invoiceId. For production use,
 * replace the in-memory store with a persistent backend by passing a custom
 * VersionStore implementation.
 */

import type { Invoice } from "./types.js";
import { diffInvoices } from "./diff.js";
import type { InvoiceDiff } from "./diff.js";
import { previewSplitRules } from "./splitPreview.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A single immutable version snapshot of an invoice.
 */
export interface InvoiceVersion {
  /** 1-based version number (first snapshot = 1). */
  version: number;
  /** Full invoice snapshot at this version. */
  snapshot: Readonly<Invoice>;
  /** Stellar address of the account that made the change. */
  changedBy: string;
  /** When this version was recorded. */
  changedAt: Date;
  /** Human-readable summary of what changed, derived from the diff. */
  changeSummary: string;
}

/**
 * Structured diff between two {@link InvoiceVersion} entries.
 */
export interface InvoiceVersionDiff {
  /** Source version number. */
  fromVersion: number;
  /** Target version number. */
  toVersion: number;
  /** Array of changed fields with before/after values. */
  changes: InvoiceDiff;
  /** Whether any fields changed between the two versions. */
  hasChanges: boolean;
}

// ---------------------------------------------------------------------------
// Version storage interface (swappable for persistence)
// ---------------------------------------------------------------------------

/** Interface for backing storage of invoice versions. */
export interface VersionStore {
  /** Append a version to the history for `invoiceId`. */
  append(invoiceId: string, version: InvoiceVersion): Promise<void>;
  /** Return all versions for `invoiceId` in ascending order, or [] if none. */
  getAll(invoiceId: string): Promise<InvoiceVersion[]>;
  /** Return the latest version for `invoiceId`, or null if none. */
  getLatest(invoiceId: string): Promise<InvoiceVersion | null>;
}

/** Default in-memory version store. */
export class InMemoryVersionStore implements VersionStore {
  private readonly _store = new Map<string, InvoiceVersion[]>();

  async append(invoiceId: string, version: InvoiceVersion): Promise<void> {
    const existing = this._store.get(invoiceId) ?? [];
    this._store.set(invoiceId, [...existing, version]);
  }

  async getAll(invoiceId: string): Promise<InvoiceVersion[]> {
    return [...(this._store.get(invoiceId) ?? [])];
  }

  async getLatest(invoiceId: string): Promise<InvoiceVersion | null> {
    const versions = this._store.get(invoiceId);
    if (!versions || versions.length === 0) return null;
    return versions[versions.length - 1]!;
  }

  /** Remove all versions for an invoice (useful in tests). */
  clear(invoiceId?: string): void {
    if (invoiceId) {
      this._store.delete(invoiceId);
    } else {
      this._store.clear();
    }
  }
}

// ---------------------------------------------------------------------------
// Summary builder
// ---------------------------------------------------------------------------

/**
 * Build a short human-readable summary of the changes captured by `diff`.
 *
 * When no previous version exists (initial recording), returns "Initial version".
 */
function buildChangeSummary(diff: InvoiceDiff): string {
  if (diff.length === 0) {
    return "No fields changed.";
  }

  const parts = diff.map((entry) => {
    const before = formatValue(entry.before);
    const after = formatValue(entry.after);
    return `${entry.field}: ${before} → ${after}`;
  });

  return parts.join("; ");
}

function formatValue(v: unknown): string {
  if (v === undefined || v === null) return "(none)";
  if (typeof v === "bigint") return v.toString();
  if (Array.isArray(v)) return `[${v.length} items]`;
  if (typeof v === "object") return "[object]";
  return String(v);
}

// ---------------------------------------------------------------------------
// InvoiceVersionTracker
// ---------------------------------------------------------------------------

/** Options for creating a {@link InvoiceVersionTracker}. */
export interface InvoiceVersionTrackerOptions {
  /** Custom version store implementation (defaults to in-memory). */
  store?: VersionStore;
}

export type VersionVector = Record<string, number>;

export class ConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConflictError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function detectVersionConflict(
  current: VersionVector,
  incoming: VersionVector,
): void {
  let incomingDominates = false;
  let currentDominates = false;

  for (const actor of new Set([...Object.keys(current), ...Object.keys(incoming)])) {
    const currentValue = current[actor] ?? 0;
    const incomingValue = incoming[actor] ?? 0;

    if (incomingValue > currentValue) {
      incomingDominates = true;
    }

    if (currentValue > incomingValue) {
      currentDominates = true;
    }
  }

  if (incomingDominates && currentDominates) {
    throw new ConflictError("Diverged version vectors detected");
  }
}

/**
 * Tracks the full version history of invoices, storing an ordered sequence of
 * immutable snapshots that can be diffed between any two versions.
 *
 * @example
 * ```typescript
 * const tracker = new InvoiceVersionTracker();
 *
 * // Record initial version
 * await tracker.record(invoice.id, invoice, "GCREATOR...");
 *
 * // After an update:
 * const updated = { ...invoice, memo: "Updated description" };
 * await tracker.record(invoice.id, updated, "GCREATOR...");
 *
 * // Inspect history
 * const history = await tracker.getHistory(invoice.id);
 * console.log(history.length); // 2
 *
 * // Diff between version 1 and 2
 * const diff = await tracker.diff(invoice.id, 1, 2);
 * console.log(diff.changes); // [{ field: "memo", before: undefined, after: "Updated description" }]
 * ```
 */
export class InvoiceVersionTracker {
  private readonly _store: VersionStore;

  constructor(options?: InvoiceVersionTrackerOptions) {
    this._store = options?.store ?? new InMemoryVersionStore();
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Record a new version of an invoice.
   *
   * If this is the first snapshot for the invoice, the version is 1 and the
   * change summary is "Initial version.". Subsequent recordings compute a diff
   * against the previous version to produce the change summary.
   *
   * Also appends a split-preview change summary when split_rules differ, using
   * `generateSplitDiff` logic from `previewSplitRules`.
   *
   * @param invoiceId  - The invoice being versioned.
   * @param newSnapshot - The current (new) state of the invoice.
   * @param changedBy  - The Stellar address of the account making the change.
   * @returns The newly created {@link InvoiceVersion}.
   */
  async record(
    invoiceId: string,
    newSnapshot: Invoice,
    changedBy: string,
  ): Promise<InvoiceVersion> {
    const latest = await this._store.getLatest(invoiceId);
    const nextVersionNumber = latest ? latest.version + 1 : 1;

    let changeSummary: string;
    if (!latest) {
      changeSummary = "Initial version.";
    } else {
      const diff = diffInvoices(latest.snapshot as Invoice, newSnapshot);
      changeSummary = buildChangeSummary(diff);

      // Append split-rules preview diff if rules changed
      if (diff.some((d) => d.field === "split_rules")) {
        const funded = newSnapshot.funded ?? 0n;
        const splitInfo = previewSplitRules(newSnapshot, funded);
        const splitLines = splitInfo
          .map((e) => `${e.recipient}: ${e.amount} stroops`)
          .join(", ");
        changeSummary += ` | Split preview: [${splitLines}]`;
      }
    }

    const version: InvoiceVersion = {
      version: nextVersionNumber,
      snapshot: Object.freeze({ ...newSnapshot }),
      changedBy,
      changedAt: new Date(),
      changeSummary,
    };

    await this._store.append(invoiceId, version);
    return version;
  }

  /**
   * Return all recorded versions for an invoice in ascending (oldest-first) order.
   *
   * @param invoiceId - The invoice to retrieve history for.
   * @returns Array of {@link InvoiceVersion} entries, possibly empty.
   */
  async getHistory(invoiceId: string): Promise<InvoiceVersion[]> {
    return this._store.getAll(invoiceId);
  }

  /**
   * Compute a structured diff between two version snapshots.
   *
   * @param invoiceId   - The invoice to diff.
   * @param fromVersion - The source version number (1-based).
   * @param toVersion   - The target version number (1-based).
   * @returns {@link InvoiceVersionDiff} with all changed fields.
   * @throws {Error} if either version does not exist.
   */
  async diff(
    invoiceId: string,
    fromVersion: number,
    toVersion: number,
  ): Promise<InvoiceVersionDiff> {
    const history = await this._store.getAll(invoiceId);

    const from = history.find((v) => v.version === fromVersion);
    const to = history.find((v) => v.version === toVersion);

    if (!from) {
      throw new Error(
        `Version ${fromVersion} not found for invoice "${invoiceId}".`,
      );
    }
    if (!to) {
      throw new Error(
        `Version ${toVersion} not found for invoice "${invoiceId}".`,
      );
    }

    const changes = diffInvoices(from.snapshot as Invoice, to.snapshot as Invoice);

    return {
      fromVersion,
      toVersion,
      changes,
      hasChanges: changes.length > 0,
    };
  }

  /**
   * Return the latest version snapshot for an invoice, or `null` if none exists.
   */
  async getLatest(invoiceId: string): Promise<InvoiceVersion | null> {
    return this._store.getLatest(invoiceId);
  }
}
