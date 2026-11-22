/**
 * SDK event emitter for state changes and transaction lifecycle events.
 *
 * Wraps TypedEventEmitter with per-listener filtering, emission history,
 * and aggregate stats so integrators can react to SDK state without polling.
 *
 * Issue #1263 — Implement event emitter
 */

import { TypedEventEmitter, type Unsubscribe, type WildcardEventHandler } from "./TypedEventEmitter.js";

// ─── Re-export base primitives used by the rest of the SDK ───────────────────

export type { Unsubscribe, WildcardEventHandler };
export { AbortError } from "./TypedEventEmitter.js";

// ─── SDK Event Map ───────────────────────────────────────────────────────────

/** Payload emitted when a transaction is submitted to the network. */
export interface TransactionSubmittedPayload {
  id: string;
  hash?: string;
  meta?: Record<string, unknown>;
}

/** Payload emitted when a transaction is confirmed on the ledger. */
export interface TransactionConfirmedPayload {
  id: string;
  hash?: string;
  ledger?: number;
  meta?: Record<string, unknown>;
}

/** Payload emitted when a transaction fails. */
export interface TransactionFailedPayload {
  id: string;
  hash?: string;
  error?: unknown;
  meta?: Record<string, unknown>;
}

/** Payload emitted when a tracked SDK state slice changes. */
export interface StateChangedPayload<T = unknown> {
  key: string;
  previous: T | undefined;
  current: T;
  timestamp: number;
}

/** Payload emitted when a SDK error is raised outside a transaction context. */
export interface SdkErrorPayload {
  message: string;
  code?: string;
  context?: Record<string, unknown>;
}

/** Complete map of all events the SDK emitter can emit. */
export interface SdkEventMap {
  "transaction:submitted": TransactionSubmittedPayload;
  "transaction:confirmed": TransactionConfirmedPayload;
  "transaction:failed":    TransactionFailedPayload;
  "state:changed":         StateChangedPayload;
  "sdk:error":             SdkErrorPayload;
  [event: string]: unknown;
}

// ─── Filtering ───────────────────────────────────────────────────────────────

/** Predicate that decides whether a handler should be invoked for a payload. */
export type EventFilter<T = unknown> = (payload: T) => boolean;

// ─── Stats ───────────────────────────────────────────────────────────────────

/** Aggregate statistics over all events emitted since the tracker was created or last reset. */
export interface EventEmitterStats {
  /** Total number of events emitted (all event names). */
  totalEmitted: number;
  /** Count of emissions per event name. */
  byEvent: Record<string, number>;
  /** Current number of registered listeners across all events. */
  listenerCount: number;
  /** Timestamp (ms) of the first emission, or undefined when no events have been emitted. */
  firstEmittedAt: number | undefined;
  /** Timestamp (ms) of the most recent emission, or undefined when no events have been emitted. */
  lastEmittedAt: number | undefined;
}

// ─── Emission history ─────────────────────────────────────────────────────────

/** A single record in the emission history. */
export interface EmittedEvent<K extends keyof SdkEventMap = keyof SdkEventMap> {
  /** Event name. */
  event: K;
  /** Payload at the time of emission. */
  payload: SdkEventMap[K];
  /** Unix epoch milliseconds when the event was emitted. */
  timestamp: number;
}

/** Filter criteria for querying the emission history. */
export interface EmissionHistoryFilter {
  /** Keep only records for these event names. */
  event?: keyof SdkEventMap | (keyof SdkEventMap)[];
  /** Keep only records emitted at or after this timestamp. */
  since?: number;
  /** Keep only records emitted at or before this timestamp. */
  until?: number;
  /** Maximum number of most-recent records to return. */
  limit?: number;
}

// ─── Options ─────────────────────────────────────────────────────────────────

/** Options for constructing a {@link SdkEventEmitter}. */
export interface SdkEventEmitterOptions {
  /**
   * Maximum number of emission history records to retain.
   * Oldest records are evicted when capacity is reached. Defaults to 200.
   */
  maxHistory?: number;
}

// ─── SdkEventEmitter ─────────────────────────────────────────────────────────

/**
 * SDK-level event emitter for state changes and transaction lifecycle events.
 *
 * - Typed `on()` / `off()` subscriptions with optional per-listener filter predicates.
 * - Wildcard `on("*")` to receive every event.
 * - Promise-based `once()` with optional `AbortSignal`.
 * - Bounded emission history with `getHistory()` and filtering.
 * - `getStats()` for aggregate debugging summaries.
 */
export class SdkEventEmitter {
  private readonly inner = new TypedEventEmitter<SdkEventMap>();

  // Per-listener filter registry (handler → filter)
  private readonly filters = new WeakMap<(...args: unknown[]) => void, EventFilter<unknown>>();
  // Wrapper map so we can remove the right wrapped handler on off()
  private readonly wrappers = new WeakMap<(...args: unknown[]) => void, (...args: unknown[]) => void>();

  // Emission history (bounded ring buffer)
  private readonly history: EmittedEvent[] = [];
  private readonly maxHistory: number;

  // Stats counters
  private readonly emitCounts: Record<string, number> = {};
  private firstEmittedAt: number | undefined = undefined;
  private lastEmittedAt: number | undefined = undefined;

  constructor(options: SdkEventEmitterOptions = {}) {
    this.maxHistory = Math.max(1, options.maxHistory ?? 200);
  }

  // ── Subscriptions ──────────────────────────────────────────────────────────

  /**
   * Register a handler for a specific event, with an optional filter predicate.
   * Returns an unsubscribe function.
   *
   * When a filter is provided, the handler is only called when
   * `filter(payload)` returns `true`.
   */
  on<K extends keyof SdkEventMap>(
    event: K,
    handler: (payload: SdkEventMap[K]) => void,
    filter?: EventFilter<SdkEventMap[K]>,
  ): Unsubscribe {
    if (filter) {
      const wrapped = (payload: SdkEventMap[K]) => {
        if (filter(payload)) handler(payload);
      };
      // Store the wrapper so off() can remove it
      this.wrappers.set(
        handler as (...args: unknown[]) => void,
        wrapped as (...args: unknown[]) => void,
      );
      this.filters.set(
        handler as (...args: unknown[]) => void,
        filter as EventFilter<unknown>,
      );
      return this.inner.on(event, wrapped);
    }
    return this.inner.on(event, handler);
  }

  /**
   * Register a wildcard handler that receives every emitted event.
   * Returns an unsubscribe function.
   */
  onAny(handler: WildcardEventHandler<SdkEventMap>): Unsubscribe {
    return this.inner.on("*", handler);
  }

  /**
   * Remove a previously registered handler.
   * If the handler was registered with a filter, the wrapped version is removed.
   */
  off<K extends keyof SdkEventMap>(
    event: K,
    handler: (payload: SdkEventMap[K]) => void,
  ): void {
    const wrapped = this.wrappers.get(handler as (...args: unknown[]) => void);
    if (wrapped) {
      this.inner.off(event, wrapped as (payload: SdkEventMap[K]) => void);
      this.wrappers.delete(handler as (...args: unknown[]) => void);
      this.filters.delete(handler as (...args: unknown[]) => void);
    } else {
      this.inner.off(event, handler);
    }
  }

  /**
   * Returns a promise that resolves with the next emission of `event`.
   * Rejects with `AbortError` if the signal fires first.
   */
  once<K extends keyof SdkEventMap>(event: K, signal?: AbortSignal): Promise<SdkEventMap[K]> {
    return this.inner.once(event, signal) as Promise<SdkEventMap[K]>;
  }

  /** Remove all handlers, optionally scoped to a single event. */
  removeAllListeners<K extends keyof SdkEventMap>(event?: K): void {
    if (event === undefined) {
      this.inner.removeAllListeners();
    } else {
      this.inner.removeAllListeners(event);
    }
  }

  /** Number of handlers currently registered for an event (or wildcards if `"*"`). */
  listenerCount<K extends keyof SdkEventMap>(event: K | "*"): number {
    return this.inner.listenerCount(event as keyof SdkEventMap);
  }

  // ── Emission ───────────────────────────────────────────────────────────────

  /**
   * Emit an event to all matching listeners and record it in history/stats.
   */
  emit<K extends keyof SdkEventMap>(event: K, payload: SdkEventMap[K]): void {
    const now = Date.now();

    // Update stats
    this.emitCounts[event as string] = (this.emitCounts[event as string] ?? 0) + 1;
    if (this.firstEmittedAt === undefined) this.firstEmittedAt = now;
    this.lastEmittedAt = now;

    // Record history
    const record: EmittedEvent = { event: event as string, payload, timestamp: now };
    if (this.history.length >= this.maxHistory) this.history.shift();
    this.history.push(record);

    // Dispatch
    this.inner.emit(event, payload);
  }

  // ── History queries ────────────────────────────────────────────────────────

  /**
   * Returns recorded emission history, optionally filtered.
   * Results are ordered oldest-first.
   */
  getHistory(filter?: EmissionHistoryFilter): EmittedEvent[] {
    let results = [...this.history];

    if (filter?.event !== undefined) {
      const names = new Set(
        Array.isArray(filter.event) ? filter.event : [filter.event],
      );
      results = results.filter((r) => names.has(r.event as keyof SdkEventMap));
    }
    if (filter?.since !== undefined) {
      results = results.filter((r) => r.timestamp >= filter.since!);
    }
    if (filter?.until !== undefined) {
      results = results.filter((r) => r.timestamp <= filter.until!);
    }
    if (filter?.limit !== undefined && filter.limit >= 0 && results.length > filter.limit) {
      results = results.slice(results.length - filter.limit);
    }

    return results;
  }

  /** Returns the most recently emitted event record, or undefined when empty. */
  getLastEmitted(): EmittedEvent | undefined {
    return this.history.length > 0 ? this.history[this.history.length - 1] : undefined;
  }

  /** Clears the emission history. Does not affect listeners or stats counters. */
  clearHistory(): void {
    this.history.length = 0;
  }

  // ── Stats ──────────────────────────────────────────────────────────────────

  /**
   * Returns aggregate statistics over all emissions since construction (or last
   * `resetStats()` call). Computed in O(1) from pre-maintained counters.
   */
  getStats(): EventEmitterStats {
    let listenerCount = 0;
    // Sum across all named events + wildcards
    for (const event of Object.keys(this.emitCounts)) {
      listenerCount += this.inner.listenerCount(event as keyof SdkEventMap);
    }
    listenerCount += this.inner.listenerCount("*");

    return {
      totalEmitted: Object.values(this.emitCounts).reduce((s, n) => s + n, 0),
      byEvent: { ...this.emitCounts },
      listenerCount,
      firstEmittedAt: this.firstEmittedAt,
      lastEmittedAt: this.lastEmittedAt,
    };
  }

  /** Resets emission counters and timestamps. Does not affect listeners or history. */
  resetStats(): void {
    for (const key of Object.keys(this.emitCounts)) {
      delete this.emitCounts[key];
    }
    this.firstEmittedAt = undefined;
    this.lastEmittedAt = undefined;
  }
}

// ─── Global default SDK emitter ──────────────────────────────────────────────

let _default = new SdkEventEmitter();

/** Gets the default global SdkEventEmitter instance. */
export function getDefaultSdkEventEmitter(): SdkEventEmitter {
  return _default;
}

/** Replaces the default global SdkEventEmitter instance. */
export function setDefaultSdkEventEmitter(emitter: SdkEventEmitter): void {
  _default = emitter;
}

/** Resets the default global SdkEventEmitter to a fresh instance. */
export function resetDefaultSdkEventEmitter(): void {
  _default = new SdkEventEmitter();
}

// ─── Legacy singleton (kept for back-compat with existing imports) ───────────
// Files that do `import { eventEmitter } from "./events/eventEmitter"` keep working.
export { _default as eventEmitter };
