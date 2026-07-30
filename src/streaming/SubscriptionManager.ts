/**
 * SubscriptionManager — routes typed InvoiceEvent payloads to registered
 * per-invoice callbacks without requiring consumers to poll SplitClient
 * fetch methods.
 *
 * There is no native WebSocket/SSE event stream on the Soroban RPC surface
 * used by this SDK, so the manager bridges a `Server.getEvents()`
 * poll-then-push loop (the EventBridge) that behaves like a persistent
 * connection from the caller's point of view: it survives transient
 * disconnects via exponential-backoff reconnect, and replays events missed
 * during an outage using a client-side cursor persisted to storage.
 */

import type { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type { InvoiceEvent } from "../types.js";
import { computeEventKey, parseInvoiceEvent } from "../subscription.js";
import { createStorageAdapter } from "../storage/storageAdapter.js";
import type { StorageAdapter } from "../storage/storageAdapter.js";
import type { EventCursor, SubscriptionOptions } from "../types/events.js";
import { TooManySubscriptionsError } from "../errors.js";

const MAX_CONCURRENT_INVOICE_SUBSCRIPTIONS = 10;

const DEFAULT_OPTIONS: Required<
  Pick<
    SubscriptionOptions,
    "pollIntervalMs" | "initialBackoffMs" | "maxBackoffMs" | "backoffMultiplier" | "maxRetries"
  >
> = {
  pollIntervalMs: 3000,
  initialBackoffMs: 1000,
  maxBackoffMs: 30_000,
  backoffMultiplier: 2,
  maxRetries: Infinity,
};

type InvoiceEventHandler = (event: InvoiceEvent) => void;

interface InvoiceSubscriptionState {
  invoiceId: string;
  handlers: Set<InvoiceEventHandler>;
  seenEventKeys: Set<string>;
  lastLedger: number | null;
  lastEventId: string | null;
  backoffMs: number;
  retryAttempt: number;
  pollTimer: ReturnType<typeof setTimeout> | null;
  stopped: boolean;
}

/**
 * Maintains one logical "connection" per invoice ID, fanning out each
 * matching InvoiceEvent to every handler registered for that invoice.
 */
export class SubscriptionManager {
  private readonly server: SorobanRpc.Server;
  private readonly contractId: string;
  private readonly storage: StorageAdapter;
  private readonly options: Required<
    Pick<
      SubscriptionOptions,
      "pollIntervalMs" | "initialBackoffMs" | "maxBackoffMs" | "backoffMultiplier" | "maxRetries"
    >
  >;
  private readonly onLifecycleEvent?: SubscriptionOptions["onLifecycleEvent"];
  private readonly subscriptions = new Map<string, InvoiceSubscriptionState>();

  constructor(server: SorobanRpc.Server, contractId: string, options: SubscriptionOptions = {}) {
    this.server = server;
    this.contractId = contractId;
    this.storage = options.storage ?? createStorageAdapter(options.storageKind ?? "localStorage");
    this.options = {
      pollIntervalMs: options.pollIntervalMs ?? DEFAULT_OPTIONS.pollIntervalMs,
      initialBackoffMs: options.initialBackoffMs ?? DEFAULT_OPTIONS.initialBackoffMs,
      maxBackoffMs: options.maxBackoffMs ?? DEFAULT_OPTIONS.maxBackoffMs,
      backoffMultiplier: options.backoffMultiplier ?? DEFAULT_OPTIONS.backoffMultiplier,
      maxRetries: options.maxRetries ?? DEFAULT_OPTIONS.maxRetries,
    };
    this.onLifecycleEvent = options.onLifecycleEvent;
  }

  /** Number of invoice IDs currently being watched. */
  get activeSubscriptionCount(): number {
    return this.subscriptions.size;
  }

  /**
   * Register a handler for typed InvoiceEvents on a given invoice ID.
   * The first subscriber for an invoice ID starts the underlying bridge and
   * restores any previously persisted cursor so events missed during a
   * prior outage are replayed. Returns a function that unregisters just
   * this handler.
   */
  
  subscribe(invoiceId: string, handler: InvoiceEventHandler, opts?: Pick<SubscriptionOptions, "storage" | "storageKind">): () => void {
    let state = this.subscriptions.get(invoiceId);
    if (!state) {
      if (this.subscriptions.size >= MAX_CONCURRENT_INVOICE_SUBSCRIPTIONS) {
        throw new TooManySubscriptionsError(MAX_CONCURRENT_INVOICE_SUBSCRIPTIONS);
      }
      const storage = opts?.storage ?? (opts?.storageKind ? createStorageAdapter(opts.storageKind) : this.storage);
      const cursor = this._loadCursor(storage, invoiceId);
      state = {
        invoiceId,
        handlers: new Set(),
        seenEventKeys: new Set(),
        lastLedger: cursor?.lastLedger ?? null,
        lastEventId: cursor?.lastEventId ?? null,
        backoffMs: this.options.initialBackoffMs,
        retryAttempt: 0,
        pollTimer: null,
        stopped: false,
      };
      this.subscriptions.set(invoiceId, state);
      void this._poll(state, storage);
    }
    state.handlers.add(handler);
    return () => this._removeHandler(invoiceId, handler);
  }

  /**
   * Stop delivering events for an invoice. When `handler` is omitted, all
   * handlers for the invoice are removed and the underlying poll
   * interval/timer is released.
   */
  unsubscribe(invoiceId: string, handler?: InvoiceEventHandler): void {
    if (handler) {
      this._removeHandler(invoiceId, handler);
      return;
    }
    const state = this.subscriptions.get(invoiceId);
    if (!state) return;
    this._stop(state);
  }

  /** Tear down every active subscription and release all timers/handlers. */
  destroy(): void {
    for (const invoiceId of [...this.subscriptions.keys()]) {
      this.unsubscribe(invoiceId);
    }
  }

  private _removeHandler(invoiceId: string, handler: InvoiceEventHandler): void {
    const state = this.subscriptions.get(invoiceId);
    if (!state) return;
    state.handlers.delete(handler);
    if (state.handlers.size === 0) {
      this._stop(state);
    }
  }

  private _stop(state: InvoiceSubscriptionState): void {
    state.stopped = true;
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    this.subscriptions.delete(state.invoiceId);
  }

  private _cursorKey(invoiceId: string): string {
    return `stellar_split:cursor:${this.contractId}:${invoiceId}`;
  }

  private _loadCursor(storage: StorageAdapter, invoiceId: string): EventCursor | null {
    try {
      const raw = storage.getItem(this._cursorKey(invoiceId));
      if (!raw) return null;
      return JSON.parse(raw) as EventCursor;
    } catch {
      return null;
    }
  }

  private _saveCursor(storage: StorageAdapter, cursor: EventCursor): void {
    try {
      storage.setItem(this._cursorKey(cursor.invoiceId), JSON.stringify(cursor));
      this.onLifecycleEvent?.({ type: "cursor_persisted", invoiceId: cursor.invoiceId, cursor });
    } catch {
      // Best-effort persistence — an in-memory replay window still applies.
    }
  }

  /** The EventBridge: one poll-then-push cycle for a single invoice subscription. */
  private async _poll(state: InvoiceSubscriptionState, storage: StorageAdapter): Promise<void> {
    if (state.stopped) return;

    try {
      if (state.lastLedger === null) {
        const latest = await this.server.getLatestLedger();
        state.lastLedger = latest.sequence;
      }

      const response = await this.server.getEvents({
        startLedger: state.lastLedger,
        filters: [{ type: "contract", contractIds: [this.contractId] }],
      });

      const events = response.events ?? [];
      let maxLedger = state.lastLedger;
      let lastDeliveredEventId: string | null = state.lastEventId;
      let deliveredAny = false;

      for (const raw of events) {
        if (raw.ledger > maxLedger) maxLedger = raw.ledger;

        const eventKey = computeEventKey(raw);
        if (state.seenEventKeys.has(eventKey)) continue;
        state.seenEventKeys.add(eventKey);

        const parsed = parseInvoiceEvent(raw, this.contractId);
        if (!parsed || parsed.invoiceId !== state.invoiceId) continue;

        for (const h of state.handlers) {
          try {
            h(parsed);
          } catch {
            // Isolate handler failures from the bridge's own control flow.
          }
        }
        deliveredAny = true;
        lastDeliveredEventId = parsed.eventId;
      }

      state.lastLedger = maxLedger + 1;
      state.lastEventId = lastDeliveredEventId;

      if (deliveredAny) {
        this._saveCursor(storage, {
          invoiceId: state.invoiceId,
          lastLedger: state.lastLedger,
          lastEventId: state.lastEventId,
          updatedAt: Date.now(),
        });
      }

      state.retryAttempt = 0;
      state.backoffMs = this.options.initialBackoffMs;
      this.onLifecycleEvent?.({ type: "connected", invoiceId: state.invoiceId });

      if (!state.stopped) {
        state.pollTimer = setTimeout(() => void this._poll(state, storage), this.options.pollIntervalMs);
      }
    } catch (error) {
      if (state.stopped) return;
      const err = error instanceof Error ? error : new Error(String(error));
      state.retryAttempt += 1;
      this.onLifecycleEvent?.({ type: "disconnected", invoiceId: state.invoiceId, error: err });

      if (state.retryAttempt > this.options.maxRetries) {
        this._stop(state);
        return;
      }

      const delay = Math.min(state.backoffMs, this.options.maxBackoffMs);
      this.onLifecycleEvent?.({
        type: "reconnecting",
        invoiceId: state.invoiceId,
        attempt: state.retryAttempt,
        delayMs: delay,
      });

      state.pollTimer = setTimeout(() => {
        state.backoffMs = Math.min(state.backoffMs * this.options.backoffMultiplier, this.options.maxBackoffMs);
        void this._poll(state, storage);
      }, delay);
    }
  }
}

// ---------------------------------------------------------------------------
// Singleton accessor — one SubscriptionManager per (server, contractId) pair
// ---------------------------------------------------------------------------

let singleton: SubscriptionManager | null = null;
let singletonContractId: string | null = null;

/**
 * Returns the shared SubscriptionManager for a contract, creating one on
 * first use. Recreating with a different `contractId` tears down and
 * replaces the previous singleton.
 */
export function getSubscriptionManager(
  server: SorobanRpc.Server,
  contractId: string,
  options?: SubscriptionOptions,
): SubscriptionManager {
  if (!singleton || singletonContractId !== contractId) {
    singleton?.destroy();
    singleton = new SubscriptionManager(server, contractId, options);
    singletonContractId = contractId;
  }
  return singleton;
}

/**
 * Destroy the shared SubscriptionManager when it exists for `contractId`.
 * Returns true when a live singleton was found and torn down.
 */
export function destroySubscriptionManager(contractId?: string): boolean {
  if (!singleton) return false;
  if (contractId && singletonContractId !== contractId) return false;
  singleton.destroy();
  singleton = null;
  singletonContractId = null;
  return true;
}

/** Test-only: reset the module-level singleton between test cases. */
export function _resetSubscriptionManagerSingletonForTesting(): void {
  singleton?.destroy();
  singleton = null;
  singletonContractId = null;
}
