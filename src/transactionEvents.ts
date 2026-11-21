/**
 * Transaction lifecycle event tracking for StellarSplit SDK.
 *
 * Tracks and emits typed events for every step of a transaction — created,
 * simulated, signed, submitted, confirmed, and error — so the UI and
 * integrators can follow progress without polling.
 *
 * Issue #1264 — Add transaction event tracking
 */

import { TypedEventEmitter } from "./events/TypedEventEmitter.js";

// ─── Step & event types ──────────────────────────────────────────────────────

/** All stages in a transaction's lifecycle. */
export type TransactionStep =
  | "created"
  | "simulated"
  | "signed"
  | "submitted"
  | "confirmed"
  | "error";

/** Fields common to every transaction event. */
export interface TransactionEventBase {
  /** Caller-supplied identifier for the transaction. */
  transactionId: string;
  /** Lifecycle stage this event represents. */
  step: TransactionStep;
  /** Unix epoch milliseconds when the event was emitted. */
  timestamp: number;
}

export interface TransactionCreatedEvent extends TransactionEventBase {
  step: "created";
  /** High-level operation name (e.g. "payInvoice", "cloneInvoice"). */
  operation: string;
  sourceAccount?: string;
  details?: Record<string, unknown>;
}

export interface TransactionSimulatedEvent extends TransactionEventBase {
  step: "simulated";
  success: boolean;
  fee?: string;
  result?: unknown;
}

export interface TransactionSignedEvent extends TransactionEventBase {
  step: "signed";
  signer?: string;
  signatureCount?: number;
}

export interface TransactionSubmittedEvent extends TransactionEventBase {
  step: "submitted";
  hash?: string;
  ledger?: number;
}

export interface TransactionConfirmedEvent extends TransactionEventBase {
  step: "confirmed";
  success: boolean;
  hash?: string;
  ledger?: number;
  result?: unknown;
}

export interface TransactionErrorEvent extends TransactionEventBase {
  step: "error";
  /** The step that failed before the error was recorded. */
  failedStep: Exclude<TransactionStep, "error">;
  error: {
    message: string;
    code?: string;
    details?: unknown;
  };
}

/** Discriminated union of all transaction lifecycle events. */
export type TransactionEvent =
  | TransactionCreatedEvent
  | TransactionSimulatedEvent
  | TransactionSignedEvent
  | TransactionSubmittedEvent
  | TransactionConfirmedEvent
  | TransactionErrorEvent;

/** Internal event map used by the TypedEventEmitter. */
export interface TransactionEventMap {
  "transaction:created": TransactionCreatedEvent;
  "transaction:simulated": TransactionSimulatedEvent;
  "transaction:signed": TransactionSignedEvent;
  "transaction:submitted": TransactionSubmittedEvent;
  "transaction:confirmed": TransactionConfirmedEvent;
  "transaction:error": TransactionErrorEvent;
  "transaction:any": TransactionEvent;
}

/** Listener callback type for catch-all subscriptions. */
export type TransactionEventListener = (event: TransactionEvent) => void;

// ─── Filtering ───────────────────────────────────────────────────────────────

/** Criteria for filtering stored or emitted transaction events. */
export interface TransactionEventFilter {
  /** Keep only events for these transaction IDs. */
  transactionId?: string | string[];
  /** Keep only events at these lifecycle steps. */
  step?: TransactionStep | TransactionStep[];
  /** Keep only events at or after this timestamp. */
  since?: number;
  /** Keep only events at or before this timestamp. */
  until?: number;
  /** Maximum number of most-recent events to return. */
  limit?: number;
}

// ─── Stats ───────────────────────────────────────────────────────────────────

/** Aggregate statistics over all stored transaction events. */
export interface TransactionEventStats {
  /** Total events stored. */
  total: number;
  /** Count per lifecycle step. */
  byStep: Record<TransactionStep, number>;
  /** Number of distinct transaction IDs seen. */
  uniqueTransactions: number;
  /** Timestamp of the oldest stored event, or undefined when empty. */
  oldestTimestamp: number | undefined;
  /** Timestamp of the newest stored event, or undefined when empty. */
  newestTimestamp: number | undefined;
  /** Time span in milliseconds between oldest and newest; 0 when fewer than two events. */
  spanMs: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

const STEP_TO_EVENT_NAME: Record<TransactionStep, keyof TransactionEventMap> = {
  created:   "transaction:created",
  simulated: "transaction:simulated",
  signed:    "transaction:signed",
  submitted: "transaction:submitted",
  confirmed: "transaction:confirmed",
  error:     "transaction:error",
};

function matchesFilter(event: TransactionEvent, filter: TransactionEventFilter): boolean {
  if (filter.transactionId !== undefined) {
    const ids = Array.isArray(filter.transactionId)
      ? filter.transactionId
      : [filter.transactionId];
    if (!ids.includes(event.transactionId)) return false;
  }
  if (filter.step !== undefined) {
    const steps = Array.isArray(filter.step) ? filter.step : [filter.step];
    if (!steps.includes(event.step)) return false;
  }
  if (filter.since !== undefined && event.timestamp < filter.since) return false;
  if (filter.until !== undefined && event.timestamp > filter.until) return false;
  return true;
}

// ─── Tracker ─────────────────────────────────────────────────────────────────

/** Options for constructing a {@link TransactionEventTracker}. */
export interface TransactionEventTrackerOptions {
  /**
   * Maximum number of events to retain in the history buffer.
   * Oldest events are evicted when capacity is reached. Defaults to 500.
   */
  maxHistory?: number;
}

/**
 * Tracks and emits typed events for each transaction lifecycle step.
 *
 * - Typed `on()` subscriptions per step via the internal `TypedEventEmitter`.
 * - Catch-all `subscribe()` for listeners that need every event.
 * - Bounded ring-buffer history with `getEvents()` and filtering.
 * - `getStats()` for aggregate debugging summaries.
 */
export class TransactionEventTracker {
  private readonly emitter = new TypedEventEmitter<TransactionEventMap>();
  private readonly catchAllListeners = new Set<TransactionEventListener>();
  private readonly history: TransactionEvent[] = [];
  private readonly maxHistory: number;

  constructor(options: TransactionEventTrackerOptions = {}) {
    this.maxHistory = Math.max(1, options.maxHistory ?? 500);
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  /**
   * Subscribe to a specific lifecycle step.
   * Returns an unsubscribe function.
   */
  on<K extends keyof TransactionEventMap>(
    event: K,
    handler: (payload: TransactionEventMap[K]) => void,
  ): () => void {
    return this.emitter.on(event, handler);
  }

  /**
   * Subscribe to every transaction event regardless of step.
   * Returns an unsubscribe function.
   */
  subscribe(listener: TransactionEventListener): () => void {
    this.catchAllListeners.add(listener);
    return () => this.catchAllListeners.delete(listener);
  }

  // ── Internal dispatch ──────────────────────────────────────────────────────

  private record(event: TransactionEvent): void {
    if (this.history.length >= this.maxHistory) {
      this.history.shift();
    }
    this.history.push(event);

    // Emit to per-step typed listeners
    const name = STEP_TO_EVENT_NAME[event.step] as keyof TransactionEventMap;
    this.emitter.emit(name, event as TransactionEventMap[typeof name]);

    // Emit to catch-all listeners
    this.emitter.emit("transaction:any", event);
    for (const listener of this.catchAllListeners) {
      listener(event);
    }
  }

  // ── Emit helpers ───────────────────────────────────────────────────────────

  emitCreated(
    transactionId: string,
    operation: string,
    extra: { sourceAccount?: string; details?: Record<string, unknown> } = {},
  ): TransactionCreatedEvent {
    const event: TransactionCreatedEvent = {
      transactionId,
      step: "created",
      timestamp: Date.now(),
      operation,
      ...extra,
    };
    this.record(event);
    return event;
  }

  emitSimulated(
    transactionId: string,
    result: { success: boolean; fee?: string; result?: unknown },
  ): TransactionSimulatedEvent {
    const event: TransactionSimulatedEvent = {
      transactionId,
      step: "simulated",
      timestamp: Date.now(),
      ...result,
    };
    this.record(event);
    return event;
  }

  emitSigned(
    transactionId: string,
    extra: { signer?: string; signatureCount?: number } = {},
  ): TransactionSignedEvent {
    const event: TransactionSignedEvent = {
      transactionId,
      step: "signed",
      timestamp: Date.now(),
      ...extra,
    };
    this.record(event);
    return event;
  }

  emitSubmitted(
    transactionId: string,
    extra: { hash?: string; ledger?: number } = {},
  ): TransactionSubmittedEvent {
    const event: TransactionSubmittedEvent = {
      transactionId,
      step: "submitted",
      timestamp: Date.now(),
      ...extra,
    };
    this.record(event);
    return event;
  }

  emitConfirmed(
    transactionId: string,
    result: { success: boolean; hash?: string; ledger?: number; result?: unknown },
  ): TransactionConfirmedEvent {
    const event: TransactionConfirmedEvent = {
      transactionId,
      step: "confirmed",
      timestamp: Date.now(),
      ...result,
    };
    this.record(event);
    return event;
  }

  emitError(
    transactionId: string,
    failedStep: Exclude<TransactionStep, "error">,
    error: { message: string; code?: string; details?: unknown },
  ): TransactionErrorEvent {
    const event: TransactionErrorEvent = {
      transactionId,
      step: "error",
      timestamp: Date.now(),
      failedStep,
      error,
    };
    this.record(event);
    return event;
  }

  // ── Queries ────────────────────────────────────────────────────────────────

  /**
   * Returns stored events, optionally filtered.
   * Results are ordered oldest-first.
   */
  getEvents(filter?: TransactionEventFilter): TransactionEvent[] {
    let results: TransactionEvent[] = filter
      ? this.history.filter((e) => matchesFilter(e, filter))
      : [...this.history];

    if (filter?.limit !== undefined && filter.limit >= 0 && results.length > filter.limit) {
      results = results.slice(results.length - filter.limit);
    }

    return results;
  }

  /** Returns the most recently recorded event, or undefined when empty. */
  getLastEvent(): TransactionEvent | undefined {
    return this.history.length > 0 ? this.history[this.history.length - 1] : undefined;
  }

  /**
   * Returns aggregate statistics over all stored events.
   * Computed in a single O(n) pass.
   */
  getStats(): TransactionEventStats {
    const byStep: Record<TransactionStep, number> = {
      created: 0, simulated: 0, signed: 0,
      submitted: 0, confirmed: 0, error: 0,
    };
    const txIds = new Set<string>();
    let oldestTimestamp: number | undefined;
    let newestTimestamp: number | undefined;

    for (const event of this.history) {
      byStep[event.step]++;
      txIds.add(event.transactionId);
      if (oldestTimestamp === undefined || event.timestamp < oldestTimestamp) {
        oldestTimestamp = event.timestamp;
      }
      if (newestTimestamp === undefined || event.timestamp > newestTimestamp) {
        newestTimestamp = event.timestamp;
      }
    }

    return {
      total: this.history.length,
      byStep,
      uniqueTransactions: txIds.size,
      oldestTimestamp,
      newestTimestamp,
      spanMs:
        oldestTimestamp !== undefined &&
        newestTimestamp !== undefined &&
        this.history.length >= 2
          ? newestTimestamp - oldestTimestamp
          : 0,
    };
  }

  /** Clears all stored events and resets the history buffer. */
  clear(): void {
    this.history.length = 0;
  }

  /** Total number of events currently stored in the history buffer. */
  count(): number {
    return this.history.length;
  }
}

// ─── Global default tracker ──────────────────────────────────────────────────

let defaultTransactionEventTracker = new TransactionEventTracker();

/** Gets the default global TransactionEventTracker instance. */
export function getDefaultTransactionEventTracker(): TransactionEventTracker {
  return defaultTransactionEventTracker;
}

/** Replaces the default global TransactionEventTracker instance. */
export function setDefaultTransactionEventTracker(tracker: TransactionEventTracker): void {
  defaultTransactionEventTracker = tracker;
}

/** Resets the default global TransactionEventTracker to a fresh instance. */
export function resetDefaultTransactionEventTracker(): void {
  defaultTransactionEventTracker = new TransactionEventTracker();
}
