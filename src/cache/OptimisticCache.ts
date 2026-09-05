/**
 * OptimisticCache — applies a predicted outcome to a cached value
 * immediately upon submission, then commits or rolls back once the
 * settled transaction result is known, so UIs built on the SDK don't have
 * to re-fetch (and flicker) after every mutation.
 *
 * Keyed by invoiceId, with an internal (invoiceId, version) composite so
 * concurrent optimistic mutations to the same invoice queue up instead of
 * clobbering one another: rolling back mutation N leaves mutations N+1..M
 * (and the base cache) untouched.
 *
 * Supports stale-while-revalidate: when a base cache entry is within
 * `staleWhileRevalidateMs` of its TTL, the stale value is returned
 * immediately and a background refresh is triggered.
 */

import { SimpleCache } from "../cache.js";

export type CommitFn = () => void;
export type RollbackFn = () => void;
export type RevalidateFn<T> = (invoiceId: string) => Promise<T>;

export interface OptimisticEntry<T> {
  key: string;
  invoiceId: string;
  version: number;
  predictedValue: T;
  rollbackValue: T;
}

export interface RollbackEvent<T> {
  key: string;
  invoiceId: string;
  version: number;
  /** The value now visible for `invoiceId` after this rollback (either an
   * older still-pending prediction, or the committed base value). */
  restoredValue: T;
}

export interface RevalidateErrorEvent {
  invoiceId: string;
  error: unknown;
}

export interface OptimisticCacheOptions<T> {
  /** Underlying base cache. Created automatically when omitted. */
  base?: SimpleCache<T>;
  /**
   * How long before TTL expiry a cached value is considered stale but
   * still served while a background revalidation runs. `0` disables
   * stale-while-revalidate (default).
   */
  staleWhileRevalidateMs?: number;
  /**
   * Called in the background when a stale entry is served.
   * Must resolve with the fresh value to write back into the base cache.
   */
  revalidate?: RevalidateFn<T>;
}

const DEFAULT_BASE_TTL_MS = 60_000;

export class OptimisticCache<T = unknown> {
  private readonly base: SimpleCache<T>;
  private readonly staleWhileRevalidateMs: number;
  private readonly revalidate?: RevalidateFn<T>;
  /** Per-invoice FIFO queue of pending (uncommitted, unrolled-back) predictions. */
  private readonly pending = new Map<string, OptimisticEntry<T>[]>();
  private readonly rollbackHandlers = new Set<(event: RollbackEvent<T>) => void>();
  private readonly revalidateErrorHandlers = new Set<(event: RevalidateErrorEvent) => void>();
  private readonly versionCounters = new Map<string, number>();
  /** Track in-flight background revalidations so only one runs per key. */
  private readonly inFlightRevalidations = new Set<string>();

  constructor(options: OptimisticCacheOptions<T> = {}) {
    this.base = options.base ?? new SimpleCache<T>({ enabled: true, ttlMs: DEFAULT_BASE_TTL_MS });
    this.staleWhileRevalidateMs = options.staleWhileRevalidateMs ?? 0;
    this.revalidate = options.revalidate;
  }

  /**
   * Read the current UI-facing value for an invoice: the most recently
   * applied still-pending optimistic prediction if one exists, otherwise
   * the committed base value.
   *
   * When stale-while-revalidate is configured and the base value is within
   * the stale window, the value is returned immediately and a background
   * revalidation is started (if not already in-flight for this key).
   */
  get(invoiceId: string): T | undefined {
    const queue = this.pending.get(invoiceId);
    if (queue && queue.length > 0) {
      return queue[queue.length - 1]!.predictedValue;
    }

    const value = this.base.get(invoiceId);

    // Stale-while-revalidate: if the entry is within the stale window,
    // trigger a background refresh without blocking the caller.
    if (this.staleWhileRevalidateMs > 0 && this.revalidate && value !== undefined) {
      this._maybeRevalidate(invoiceId);
    }

    return value;
  }

  /** Number of optimistic mutations across all invoices awaiting commit/rollback. */
  get pendingCount(): number {
    let total = 0;
    for (const queue of this.pending.values()) total += queue.length;
    return total;
  }

  /** Register a listener invoked whenever a rollback() restores a prior value. */
  onRollback(handler: (event: RollbackEvent<T>) => void): () => void {
    this.rollbackHandlers.add(handler);
    return () => this.rollbackHandlers.delete(handler);
  }

  /** Register a listener invoked when a background revalidation fails. */
  onRevalidateError(handler: (event: RevalidateErrorEvent) => void): () => void {
    this.revalidateErrorHandlers.add(handler);
    return () => this.revalidateErrorHandlers.delete(handler);
  }

  /**
   * Apply a predicted value for `invoiceId` immediately. Returns a
   * `{ commit, rollback }` pair: `commit()` writes the prediction into the
   * base cache, `rollback()` restores whatever was visible before this
   * prediction (an earlier still-pending prediction, or the base value).
   * Both are idempotent no-ops after the first call.
   */
  applyOptimistic(
    invoiceId: string,
    predictedValue: T,
    rollbackValue: T,
  ): { commit: CommitFn; rollback: RollbackFn; key: string } {
    const version = (this.versionCounters.get(invoiceId) ?? 0) + 1;
    this.versionCounters.set(invoiceId, version);
    const key = `${invoiceId}@${version}`;

    const entry: OptimisticEntry<T> = { key, invoiceId, version, predictedValue, rollbackValue };
    const queue = this.pending.get(invoiceId) ?? [];
    queue.push(entry);
    this.pending.set(invoiceId, queue);

    let settled = false;

    const commit: CommitFn = () => {
      if (settled) return;
      settled = true;
      this.base.set(invoiceId, entry.predictedValue);
      this._removeEntry(entry);
    };

    const rollback: RollbackFn = () => {
      if (settled) return;
      settled = true;
      this._removeEntry(entry);

      const remaining = this.pending.get(invoiceId);
      const stillPending = remaining && remaining.length > 0;
      const restoredValue = stillPending ? remaining![remaining!.length - 1]!.predictedValue : entry.rollbackValue;
      if (!stillPending) {
        this.base.set(invoiceId, entry.rollbackValue);
      }

      const event: RollbackEvent<T> = { key, invoiceId, version, restoredValue };
      for (const handler of this.rollbackHandlers) {
        try {
          handler(event);
        } catch {
          // Isolate listener failures from cache bookkeeping.
        }
      }
    };

    return { commit, rollback, key };
  }

  /**
   * Check whether the base cache entry for `invoiceId` is stale (within
   * `staleWhileRevalidateMs` of expiry) and trigger a background
   * revalidation if so. Does nothing when SWR is disabled or already
   * in-flight for this key.
   */
  private _maybeRevalidate(invoiceId: string): void {
    if (!this.revalidate || this.inFlightRevalidations.has(invoiceId)) return;

    const raw = this.base.peek(invoiceId);
    if (!raw) return;

    const ttl = this.base.resolveTtl(invoiceId);
    if (ttl <= 0) return;

    const staleThreshold = raw.expiresAt - this.staleWhileRevalidateMs;
    const now = Date.now();
    if (now < staleThreshold) return; // not yet stale

    this.inFlightRevalidations.add(invoiceId);

    this.revalidate(invoiceId)
      .then((fresh) => {
        this.base.set(invoiceId, fresh);
      })
      .catch((err) => {
        const event: RevalidateErrorEvent = { invoiceId, error: err };
        for (const handler of this.revalidateErrorHandlers) {
          try {
            handler(event);
          } catch {
            // Isolate listener failures.
          }
        }
      })
      .finally(() => {
        this.inFlightRevalidations.delete(invoiceId);
      });
  }

  private _removeEntry(entry: OptimisticEntry<T>): void {
    const queue = this.pending.get(entry.invoiceId);
    if (!queue) return;
    const idx = queue.indexOf(entry);
    if (idx >= 0) queue.splice(idx, 1);
    if (queue.length === 0) this.pending.delete(entry.invoiceId);
  }
}
