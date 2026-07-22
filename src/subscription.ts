import { rpc as SorobanRpc, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { InvoiceEvent, Subscription, SubscriptionOptions } from "./types.js";
import { StellarSplitError } from "./errors.js";

/** Error codes for subscription errors. */
export const SUBSCRIPTION_ERROR_CODES = {
  MAX_RETRIES_EXCEEDED: "SUBSCRIPTION_MAX_RETRIES_EXCEEDED",
  SUBSCRIPTION_CLOSED: "SUBSCRIPTION_CLOSED",
  POLLING_ERROR: "SUBSCRIPTION_POLLING_ERROR",
  INVOICE_NOT_FOUND: "INVOICE_NOT_FOUND",
  CONTRACT_ERROR: "CONTRACT_ERROR",
} as const;

/** Event emitted when subscription encounters an error. */
export interface SubscriptionErrorEvent {
  type: "error";
  invoiceId: string;
  error: Error;
  retryCount: number;
  maxRetries: number;
}

/** Event emitted when subscription is closed. */
export interface SubscriptionCloseEvent {
  type: "close";
  invoiceId: string;
  reason: "unsubscribed" | "max_retries" | "error";
}

/** Event emitted when subscription reconnects. */
export interface SubscriptionReconnectEvent {
  type: "reconnect";
  invoiceId: string;
  retryCount: number;
  nextRetryMs: number;
}

/** Union of all subscription lifecycle events. */
export type SubscriptionLifecycleEvent =
  | SubscriptionErrorEvent
  | SubscriptionCloseEvent
  | SubscriptionReconnectEvent;

/** Callback for subscription lifecycle events. */
export type SubscriptionLifecycleCallback = (event: SubscriptionLifecycleEvent) => void;

/** Internal state for subscription. */
export interface SubscriptionState {
  stopped: boolean;
  paused: boolean;
  lastLedger: number | null;
  retryCount: number;
  seenEventKeys: Set<string>;
  pollTimer: ReturnType<typeof setTimeout> | null;
  reconnectTimer: ReturnType<typeof setTimeout> | null;
  backoffMs: number;
  pendingCallback: boolean;
}

/** Maximum concurrent subscriptions limit. */
const MAX_CONCURRENT_SUBSCRIPTIONS = 10;
const activeSubscriptions = new Set<SubscriptionState>();

export function _resetActiveSubscriptionsForTesting(): void {
  activeSubscriptions.clear();
}

function stopSubscription(state: SubscriptionState) {
  state.stopped = true;
  activeSubscriptions.delete(state);
}

/** Default subscription options. */
const DEFAULT_OPTIONS = {
  pollIntervalMs: 3000,
  maxRetries: 5,
  initialBackoffMs: 1000,
  maxBackoffMs: 30000,
  backoffMultiplier: 2,
  callbackTimeoutMs: 5000,
};

/** Compute a unique event key for deduplication (ledger + topic hash). */
function computeEventKey(event: SorobanRpc.Api.EventResponse): string {
  const topic = event.topic as unknown[];
  const topicStr = Array.isArray(topic) ? topic.join(":") : String(topic);
  return `${event.ledger}:${topicStr}`;
}

function parseEventValue(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === "object" && value !== null && !("toXDR" in value)) {
    return value as Record<string, unknown>;
  }
  try {
    const native = scValToNative(value as xdr.ScVal);
    if (typeof native === "object" && native !== null) {
      return native as Record<string, unknown>;
    }
  } catch {
    // ignore fallback
  }
  return (value as Record<string, unknown>) ?? {};
}

/** Parse a Soroban event into an InvoiceEvent. */
function parseInvoiceEvent(
  event: SorobanRpc.Api.EventResponse,
  contractId: string,
): InvoiceEvent | null {
  const topic = event.topic as unknown[];
  if (!Array.isArray(topic) || topic.length === 0) return null;

  const eventType = typeof topic[0] === "string" ? topic[0] : null;
  if (!eventType) return null;

  const invoiceId = extractInvoiceId(event, topic);
  if (!invoiceId) return null;

  const eventId = computeEventKey(event);

  const baseEvent = {
    invoiceId,
    ledger: event.ledger,
    timestamp: Math.floor(Date.now() / 1000),
    eventId,
  };

  const data = parseEventValue(event.value);

  switch (eventType) {
    case "created": {
      return {
        ...baseEvent,
        type: "created",
        creator: String(data.creator ?? ""),
        recipients: (data.recipients as Array<Record<string, unknown>>)?.map((r) => ({
          address: String(typeof r === "object" && r !== null ? r.address ?? r : r),
          amount: BigInt(String(typeof r === "object" && r !== null ? r.amount ?? "0" : "0")),
        })) ?? [],
        token: String(data.token ?? ""),
        deadline: Number(data.deadline ?? 0),
      };
    }
    case "payment": {
      const payer = String(data.payer ?? "");
      const amount = BigInt(String(data.amount ?? "0"));
      return {
        ...baseEvent,
        type: "payment",
        payer,
        amount,
        donateOnFailure: Boolean(data.donateOnFailure),
        payment: {
          payer,
          amount,
          ledger: event.ledger,
          timestamp: Math.floor(Date.now() / 1000),
        },
      };
    }
    case "released": {
      const releasedBy = String(data.releasedBy ?? "");
      const amount = BigInt(String(data.amount ?? data.totalAmount ?? "0"));
      return {
        ...baseEvent,
        type: "released",
        releasedBy,
        amount,
        totalAmount: amount,
      };
    }
    case "refunded": {
      const refundedBy = String(data.refundedBy ?? data.refundedTo ?? "");
      const amount = BigInt(String(data.amount ?? data.totalAmount ?? "0"));
      return {
        ...baseEvent,
        type: "refunded",
        refundedBy,
        refundedTo: refundedBy,
        amount,
        totalAmount: amount,
      };
    }
    case "cancelled": {
      return {
        ...baseEvent,
        type: "cancelled",
        cancelledBy: String(data.cancelledBy ?? ""),
      };
    }
    case "frozen": {
      return {
        ...baseEvent,
        type: "frozen",
        frozenBy: String(data.frozenBy ?? ""),
        reason: String(data.reason ?? ""),
      };
    }
    case "unfrozen": {
      return {
        ...baseEvent,
        type: "unfrozen",
        unfrozenBy: String(data.unfrozenBy ?? ""),
      };
    }
    case "dispute_opened": {
      return {
        ...baseEvent,
        type: "dispute_opened",
        disputeId: String(data.disputeId ?? ""),
        openedBy: String(data.openedBy ?? ""),
        reason: String(data.reason ?? ""),
      };
    }
    case "dispute_resolved": {
      return {
        ...baseEvent,
        type: "dispute_resolved",
        disputeId: String(data.disputeId ?? ""),
        resolvedBy: String(data.resolvedBy ?? ""),
        resolution: String(data.resolution ?? ""),
      };
    }
    case "split_rules_updated": {
      return {
        ...baseEvent,
        type: "split_rules_updated",
        updatedBy: String(data.updatedBy ?? ""),
      };
    }
    case "auto_resolve_rules_updated": {
      return {
        ...baseEvent,
        type: "auto_resolve_rules_updated",
        updatedBy: String(data.updatedBy ?? ""),
      };
    }
    case "velocity_limit_updated": {
      return {
        ...baseEvent,
        type: "velocity_limit_updated",
        updatedBy: String(data.updatedBy ?? ""),
        limitPerWindow: BigInt(String(data.limitPerWindow ?? "0")),
        windowDuration: Number(data.windowDuration ?? 0),
      };
    }
    case "prerequisite_added": {
      return {
        ...baseEvent,
        type: "prerequisite_added",
        prerequisiteId: String(data.prerequisiteId ?? ""),
      };
    }
    case "prerequisite_removed": {
      return {
        ...baseEvent,
        type: "prerequisite_removed",
        prerequisiteId: String(data.prerequisiteId ?? ""),
      };
    }
    case "forward_chain_created": {
      return {
        ...baseEvent,
        type: "forward_chain_created",
        forwardInvoiceId: String(data.forwardInvoiceId ?? ""),
      };
    }
    case "scheduled_release_set": {
      return {
        ...baseEvent,
        type: "scheduled_release_set",
        scheduledAt: Number(data.scheduledAt ?? 0),
      };
    }
    case "penalty_tiers_updated": {
      return {
        ...baseEvent,
        type: "penalty_tiers_updated",
        updatedBy: String(data.updatedBy ?? ""),
      };
    }
    case "allowed_callers_updated": {
      return {
        ...baseEvent,
        type: "allowed_callers_updated",
        updatedBy: String(data.updatedBy ?? ""),
      };
    }
    case "nft_gate_set": {
      return {
        ...baseEvent,
        type: "nft_gate_set",
        contractAddress: String(data.contractAddress ?? ""),
      };
    }
    case "nft_gate_removed": {
      return { ...baseEvent, type: "nft_gate_removed" };
    }
    default:
      return null;
  }
}

/** Extract invoice ID from event. */
function extractInvoiceId(
  event: SorobanRpc.Api.EventResponse,
  topic: unknown[],
): string | null {
  if (topic.length > 1) {
    const id = topic[1];
    if (typeof id === "string") return id;
    if (typeof id === "number" || typeof id === "bigint") return String(id);
  }

  const data = parseEventValue(event.value);
  const id = data.invoiceId;
  if (typeof id === "string") return id;
  if (typeof id === "number" || typeof id === "bigint") return String(id);

  return null;
}

/** Create a subscription error. */
export class SubscriptionError extends StellarSplitError {
  constructor(code: string, message: string, context: Record<string, unknown> = {}) {
    super(message, code, context, message);
    this.name = "SubscriptionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Create a subscription to invoice events via Soroban getEvents polling.
 *
 * @param server - Soroban RPC server instance
 * @param contractId - StellarSplit contract ID
 * @param invoiceId - Invoice ID to subscribe to
 * @param callback - Callback fired on each new InvoiceEvent
 * @param options - Subscription configuration options
 * @returns Subscription object with unsubscribe() method
 */
export function createInvoiceSubscription(
  server: SorobanRpc.Server,
  contractId: string,
  invoiceId: string,
  callback: (event: InvoiceEvent) => void,
  options: SubscriptionOptions = {},
): Subscription {
  const config = { ...DEFAULT_OPTIONS, ...options };
  const state: SubscriptionState = {
    stopped: false,
    paused: false,
    lastLedger: null,
    retryCount: 0,
    seenEventKeys: new Set(),
    pollTimer: null,
    reconnectTimer: null,
    backoffMs: config.initialBackoffMs,
    pendingCallback: false,
  };

  if (activeSubscriptions.size >= MAX_CONCURRENT_SUBSCRIPTIONS) {
    state.stopped = true;
  } else {
    activeSubscriptions.add(state);
  }

  const emitLifecycle = (event: SubscriptionLifecycleEvent) => {
    config.onLifecycleEvent?.(event);
  };

  const clearTimers = () => {
    if (state.pollTimer) {
      clearTimeout(state.pollTimer);
      state.pollTimer = null;
    }
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
  };

  const scheduleReconnect = (error: Error) => {
    if (state.stopped) return;

    state.retryCount++;
    if (state.retryCount > config.maxRetries) {
      const maxRetriesError = new SubscriptionError(
        SUBSCRIPTION_ERROR_CODES.MAX_RETRIES_EXCEEDED,
        `Max retries (${config.maxRetries}) exceeded for invoice ${invoiceId}`,
        { invoiceId, retryCount: state.retryCount, lastError: error.message },
      );
      emitLifecycle({
        type: "error",
        invoiceId,
        error: maxRetriesError,
        retryCount: state.retryCount,
        maxRetries: config.maxRetries,
      });
      stopSubscription(state);
      clearTimers();
      return;
    }

    const delay = Math.min(state.backoffMs, config.maxBackoffMs);
    emitLifecycle({
      type: "reconnect",
      invoiceId,
      retryCount: state.retryCount,
      nextRetryMs: delay,
    });

    state.reconnectTimer = setTimeout(() => {
      state.backoffMs = Math.min(state.backoffMs * config.backoffMultiplier, config.maxBackoffMs);
      poll();
    }, delay);
  };

  const poll = async () => {
    if (state.stopped || state.paused || state.pendingCallback) return;

    try {
      if (state.lastLedger === null) {
        const latest = await server.getLatestLedger();
        state.lastLedger = latest.sequence;
      }

      const response = await server.getEvents({
        startLedger: state.lastLedger,
        filters: [{ type: "contract", contractIds: [contractId] }],
      });

      const events = response.events ?? [];
      let maxLedger = state.lastLedger;
      const newEvents: InvoiceEvent[] = [];

      for (const event of events) {
        if (event.ledger > maxLedger) maxLedger = event.ledger;

        const eventKey = computeEventKey(event);
        if (state.seenEventKeys.has(eventKey)) continue;
        state.seenEventKeys.add(eventKey);

        const invoiceEvent = parseInvoiceEvent(event, contractId);
        if (!invoiceEvent) continue;
        if (invoiceEvent.invoiceId !== invoiceId) continue;

        newEvents.push(invoiceEvent);
      }

      if (newEvents.length > 0) {
        state.retryCount = 0;
        state.backoffMs = config.initialBackoffMs;
        state.lastLedger = maxLedger + 1;

        for (const evt of newEvents) {
          state.pendingCallback = true;
          try {
            callback(evt);
          } finally {
            state.pendingCallback = false;
          }
        }
      } else {
        state.lastLedger = maxLedger + 1;
      }
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      scheduleReconnect(err);
      return;
    }

    if (!state.stopped && !state.paused) {
      state.pollTimer = setTimeout(poll, config.pollIntervalMs);
    }
  };

  // Start polling if active
  if (!state.stopped) {
    poll();
  }

  const subscription: Subscription & { state: SubscriptionState } = {
    state,
    unsubscribe: () => {
      if (state.stopped) return;
      stopSubscription(state);
      clearTimers();
      emitLifecycle({
        type: "close",
        invoiceId,
        reason: "unsubscribed",
      });
    },
    pause: () => {
      state.paused = true;
      clearTimers();
    },
    resume: () => {
      if (state.stopped) return;
      state.paused = false;
      poll();
    },
    getInvoiceId: () => invoiceId,
    isActive: () => !state.stopped && !state.paused,
    isPaused: () => state.paused,
  };

  return subscription;
}

export type InvoiceEventCallback = (event: InvoiceEvent) => void;

/** Type guard to check if an event is a payment event. */
export function isInvoicePaymentEvent(event: InvoiceEvent): event is InvoiceEvent & { type: "payment" } {
  return event.type === "payment";
}

/** Type guard to check if an event is a released event. */
export function isInvoiceReleasedEvent(event: InvoiceEvent): event is InvoiceEvent & { type: "released" } {
  return event.type === "released";
}

/** Type guard to check if an event is a refunded event. */
export function isInvoiceRefundedEvent(event: InvoiceEvent): event is InvoiceEvent & { type: "refunded" } {
  return event.type === "refunded";
}

/** Type guard to check if an event is a cancelled event. */
export function isInvoiceCancelledEvent(event: InvoiceEvent): event is InvoiceEvent & { type: "cancelled" } {
  return event.type === "cancelled";
}

/** Type guard to check if an event is a frozen event. */
export function isInvoiceFrozenEvent(event: InvoiceEvent): event is InvoiceEvent & { type: "frozen" } {
  return event.type === "frozen";
}

/** Type guard to check if an event is an unfrozen event. */
export function isInvoiceUnfrozenEvent(event: InvoiceEvent): event is InvoiceEvent & { type: "unfrozen" } {
  return event.type === "unfrozen";
}

/** Type guard to check if an event is a created event. */
export function isInvoiceCreatedEvent(event: InvoiceEvent): event is InvoiceEvent & { type: "created" } {
  return event.type === "created";
}