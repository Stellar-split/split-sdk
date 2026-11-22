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

import { createHash } from "crypto";
import type { Invoice } from "./types.js";
import { diffInvoices } from "./diff.js";
import type { InvoiceDiff } from "./diff.js";
import { previewSplitRules } from "./splitPreview.js";
import {
  InvoiceVersionNotFoundError,
  UnsafeRollbackError,
  InvalidVersionError,
} from "./errors.js";

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
  /** Whether this version was created by rolling back to an earlier version. */
  isRollback?: boolean;
  /** If this is a rollback, the version number that was restored. */
  rolledBackFromVersion?: number;
  /** SHA-256 integrity checksum of the snapshot state. */
  checksum?: string;
  /** Optional metadata associated with this version recording. */
  metadata?: Record<string, unknown>;
}

/**
 * Options for performing an invoice rollback.
 */
export interface RollbackOptions {
  /** Stellar address of the account requesting the rollback. */
  changedBy?: string;
  /** Optional reason or description for the rollback. */
  reason?: string;
  /**
   * If true, allows rolling back an invoice even if its current state is "Released" or "Refunded".
   * Defaults to false for rollback safety.
   */
  allowTerminalStateRollback?: boolean;
  /**
   * If true (default), preserves payments and funded totals recorded on-chain while
   * rolling back invoice configuration (recipients, deadlines, memos, tags, split rules).
   */
  preservePayments?: boolean;
  /** Optional metadata attached to the rollback version. */
  metadata?: Record<string, unknown>;
}

/**
 * Result of an invoice rollback operation.
 */
export interface InvoiceRollbackResult {
  invoiceId: string;
  targetVersion: number;
  newVersionNumber: number;
  restoredInvoice: Invoice;
  version: InvoiceVersion;
}

/**
 * Human-readable entry in an invoice's audit change history.
 */
export interface ChangeLogEntry {
  version: number;
  changedBy: string;
  changedAt: Date;
  changeSummary: string;
  isRollback: boolean;
  rolledBackFromVersion?: number;
  changedFields: string[];
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
  /** Return a specific version by number, or null if none. */
  get?(invoiceId: string, versionNumber: number): Promise<InvoiceVersion | null>;
  /** Clear versions for an invoice or all invoices. */
  clear?(invoiceId?: string): Promise<void> | void;
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

  async get(invoiceId: string, versionNumber: number): Promise<InvoiceVersion | null> {
    const versions = this._store.get(invoiceId);
    if (!versions) return null;
    return versions.find((v) => v.version === versionNumber) ?? null;
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
      snapshot: freezeSnapshot(newSnapshot),
      changedBy,
      changedAt: new Date(),
      changeSummary,
      checksum: computeChecksum(newSnapshot),
    };

    await this._store.append(invoiceId, version);
    return version;
  }

  /**
   * Return a specific recorded version by number, or `null` if it does not exist.
   *
   * @param invoiceId     - The invoice to look up.
   * @param versionNumber - The 1-based version number.
   */
  async getVersion(
    invoiceId: string,
    versionNumber: number,
  ): Promise<InvoiceVersion | null> {
    if (this._store.get) {
      return this._store.get(invoiceId, versionNumber);
    }
    const all = await this._store.getAll(invoiceId);
    return all.find((v) => v.version === versionNumber) ?? null;
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

  /**
   * Pre-flight safety check to evaluate whether a rollback to `targetVersion` is safe.
   *
   * @param invoiceId     - The invoice identifier.
   * @param targetVersion - The version number to roll back to.
   * @param options       - Rollback safety options.
   * @returns Object indicating whether rollback is safe and the reason if not.
   */
  async isRollbackSafe(
    invoiceId: string,
    targetVersion: number,
    options?: RollbackOptions,
  ): Promise<{ safe: boolean; reason?: string }> {
    if (typeof targetVersion !== "number" || targetVersion <= 0 || !Number.isInteger(targetVersion)) {
      return { safe: false, reason: `Target version must be a positive integer, got ${targetVersion}` };
    }

    const latest = await this._store.getLatest(invoiceId);
    if (!latest) {
      return { safe: false, reason: `No version history found for invoice "${invoiceId}"` };
    }

    if (targetVersion === latest.version) {
      return { safe: false, reason: `Target version ${targetVersion} is already the current version` };
    }

    if (targetVersion > latest.version) {
      return { safe: false, reason: `Target version ${targetVersion} exceeds current version ${latest.version}` };
    }

    const target = await this.getVersion(invoiceId, targetVersion);
    if (!target) {
      return { safe: false, reason: `Target version ${targetVersion} does not exist` };
    }

    // Protect terminal state unless caller explicitly allows
    const isTerminal = latest.snapshot.status === "Released" || latest.snapshot.status === "Refunded";
    if (isTerminal && !options?.allowTerminalStateRollback) {
      return {
        safe: false,
        reason: `Invoice "${invoiceId}" is in terminal state "${latest.snapshot.status}". Rollback requires allowTerminalStateRollback: true.`,
      };
    }

    return { safe: true };
  }

  /**
   * Roll back an invoice to a previous version snapshot, creating a new version record.
   *
   * Rollback safety is enforced:
   * - Target version must exist and be strictly less than current version.
   * - Finalized (Released/Refunded) invoices cannot be rolled back unless `allowTerminalStateRollback` is set.
   * - Existing payment history and funded amounts are preserved by default to prevent data loss.
   *
   * @param invoiceId     - The invoice to roll back.
   * @param targetVersion - The historical version number to restore.
   * @param options       - Rollback options and metadata.
   * @returns The rollback outcome including the restored invoice and new version record.
   */
  async rollback(
    invoiceId: string,
    targetVersion: number,
    options?: RollbackOptions,
  ): Promise<InvoiceRollbackResult> {
    const safety = await this.isRollbackSafe(invoiceId, targetVersion, options);
    if (!safety.safe) {
      const latest = await this._store.getLatest(invoiceId);
      if (!latest || typeof targetVersion !== "number" || targetVersion <= 0 || targetVersion > latest.version) {
        throw new InvalidVersionError(safety.reason ?? "Invalid target version", targetVersion);
      }
      const target = await this.getVersion(invoiceId, targetVersion);
      if (!target) {
        throw new InvoiceVersionNotFoundError(invoiceId, targetVersion);
      }
      throw new UnsafeRollbackError(invoiceId, targetVersion, safety.reason ?? "Rollback failed safety check");
    }

    const latest = (await this._store.getLatest(invoiceId))!;
    const target = (await this.getVersion(invoiceId, targetVersion))!;

    // Reconstruct restored invoice snapshot (deep copy so the stored snapshot
    // is never mutated by callers and no partial writes can occur).
    const restored: Invoice = {
      ...target.snapshot,
      recipients: target.snapshot.recipients.map((r) => ({ ...r })),
    };

    // Preserve payments & funded on-chain state if requested (defaults to true)
    const preservePayments = options?.preservePayments ?? true;
    if (preservePayments) {
      restored.payments = [...latest.snapshot.payments];
      restored.funded = latest.snapshot.funded;
    }

    const nextVersionNumber = latest.version + 1;
    const changedBy = options?.changedBy ?? target.changedBy;
    const reasonText = options?.reason ? `: ${options.reason}` : "";
    const diff = diffInvoices(latest.snapshot as Invoice, restored);
    const diffSummary = buildChangeSummary(diff);
    const changeSummary = `Rolled back to version ${targetVersion} from v${latest.version}${reasonText}. Changes: ${diffSummary}`;

    const newVersion: InvoiceVersion = {
      version: nextVersionNumber,
      snapshot: freezeSnapshot(restored),
      changedBy,
      changedAt: new Date(),
      changeSummary,
      isRollback: true,
      rolledBackFromVersion: targetVersion,
      checksum: computeChecksum(restored),
      metadata: options?.metadata,
    };

    // Single atomic append: the new rollback version is only committed once
    // fully constructed, so a failure leaves the history untouched.
    await this._store.append(invoiceId, newVersion);

    return {
      invoiceId,
      targetVersion,
      newVersionNumber: nextVersionNumber,
      restoredInvoice: restored,
      version: newVersion,
    };
  }

  /**
   * Return a human-readable audit change log for the invoice.
   *
   * @param invoiceId - The invoice to retrieve change log for.
   */
  async getChangeLog(invoiceId: string): Promise<ChangeLogEntry[]> {
    const history = await this.getHistory(invoiceId);
    return history.map((v) => {
      const changedFields: string[] = [];
      if (v.changeSummary && v.changeSummary !== "Initial version." && v.changeSummary !== "No fields changed.") {
        const parts = v.changeSummary.split("; ");
        for (const part of parts) {
          const col = part.indexOf(":");
          if (col > 0) {
            changedFields.push(part.slice(0, col).trim());
          }
        }
      }
      return {
        version: v.version,
        changedBy: v.changedBy,
        changedAt: v.changedAt,
        changeSummary: v.changeSummary,
        isRollback: !!v.isRollback,
        rolledBackFromVersion: v.rolledBackFromVersion,
        changedFields,
      };
    });
  }

  /**
   * Export the entire version history for an invoice as a formatted JSON string.
   */
  async exportHistoryJson(invoiceId: string): Promise<string> {
    const history = await this.getHistory(invoiceId);
    return JSON.stringify(
      {
        invoiceId,
        exportedAt: new Date().toISOString(),
        versionCount: history.length,
        versions: history.map((v) => ({
          ...v,
          changedAt: v.changedAt.toISOString(),
        })),
      },
      (_, val) => (typeof val === "bigint" ? val.toString() : val),
      2,
    );
  }

  /**
   * Import historical versions from JSON into the current store.
   *
   * @returns Number of versions imported.
   */
  async importHistoryJson(invoiceId: string, json: string): Promise<number> {
    const parsed = JSON.parse(json);
    const rawVersions: any[] = Array.isArray(parsed) ? parsed : parsed.versions ?? [];
    let count = 0;

    for (const item of rawVersions) {
      const snapshot: Invoice = {
        ...item.snapshot,
        funded: BigInt(item.snapshot?.funded ?? 0),
        recipients: (item.snapshot?.recipients ?? []).map((r: any) => ({
          ...r,
          amount: BigInt(r.amount ?? 0),
        })),
        payments: (item.snapshot?.payments ?? []).map((p: any) => ({
          ...p,
          amount: BigInt(p.amount ?? 0),
        })),
      };
      const v: InvoiceVersion = {
        version: Number(item.version),
        snapshot: freezeSnapshot(snapshot),
        changedBy: String(item.changedBy ?? ""),
        changedAt: new Date(item.changedAt),
        changeSummary: String(item.changeSummary ?? ""),
        isRollback: item.isRollback ? Boolean(item.isRollback) : undefined,
        rolledBackFromVersion: item.rolledBackFromVersion ? Number(item.rolledBackFromVersion) : undefined,
        checksum: item.checksum ? String(item.checksum) : undefined,
        metadata: item.metadata,
      };
      await this._store.append(invoiceId, v);
      count++;
    }

    return count;
  }

  /**
   * Clear recorded versions for an invoice or all invoices.
   */
  async clear(invoiceId?: string): Promise<void> {
    if (this._store.clear) {
      await this._store.clear(invoiceId);
    }
  }
}

/**
 * Produce a deeply frozen copy of an invoice snapshot so that recorded
 * versions are immutable and cannot be mutated by later updates.
 */
function freezeSnapshot(invoice: Invoice): Readonly<Invoice> {
  const copy: Invoice = {
    ...invoice,
    recipients: invoice.recipients.map((r) => Object.freeze({ ...r })),
    payments: invoice.payments.map((p) => Object.freeze({ ...p })),
  };
  return Object.freeze(copy);
}

/**
 * Compute a SHA-256 integrity checksum for an invoice object.
 */
export function computeChecksum(invoice: Invoice): string {
  const json = JSON.stringify(invoice, (_, value) => {
    if (typeof value === "bigint") return value.toString();
    return value;
  });
  return createHash("sha256").update(json).digest("hex");
}

/**
 * High-level Invoice Version Manager.
 * Alias / subclass of {@link InvoiceVersionTracker} supporting full versioning and rollback workflows.
 */
export class InvoiceVersionManager extends InvoiceVersionTracker {}

