/**
 * Recurring subscription types for invoice subscriptions.
 */

import type { CreateInvoiceParams } from "../types.js";

export type SubscriptionStatus = "active" | "paused" | "cancelled";

export interface Subscription {
  id: bigint;
  params: CreateInvoiceParams;
  intervalSeconds: number;
  lastTriggeredAt?: number;
  nextDueAt: number;
  status: SubscriptionStatus;
  creator: string;
  createdAt: number;
}

export interface CreateSubscriptionParams {
  params: CreateInvoiceParams;
  intervalSeconds: number;
}

export interface TooEarlyToTriggerError {
  name: "TooEarlyToTriggerError";
  message: string;
  subscriptionId: bigint;
  nextDueAt: number;
}

/**
 * Real-time invoice state subscription types.
 *
 * These types form the shared contract between the WebSocket handler and
 * consumers of the real-time invoice state subscription API.
 */

/**
 * The lifecycle state of an invoice as observed by the subscription system.
 */
export type InvoiceState = "pending" | "paid" | "expired" | "cancelled";

/**
 * A single real-time update describing a change in an invoice's state.
 */
export interface InvoiceStateUpdate {
  /** Identifier of the invoice whose state changed. */
  invoiceId: bigint;
  /** The state the invoice transitioned from, if known. */
  previousState?: InvoiceState;
  /** The new state of the invoice. */
  state: InvoiceState;
  /** Monotonically increasing sequence number for ordering updates. */
  sequence: number;
  /** Unix timestamp (ms) when the update was produced. */
  timestamp: number;
  /** Optional creator/owner of the invoice, for filtering. */
  creator?: string;
  /** Optional arbitrary metadata associated with the update. */
  metadata?: Record<string, unknown>;
}

/**
 * Filter criteria used to select which invoice state updates a subscriber
 * receives. All provided fields are combined with logical AND.
 */
export interface InvoiceStateFilter {
  /** Only receive updates for these invoice IDs. */
  invoiceIds?: bigint[];
  /** Only receive updates for these invoice states. */
  states?: InvoiceState[];
  /** Only receive updates for invoices created by these addresses. */
  creators?: string[];
  /** Only receive updates whose metadata matches these key/value pairs. */
  metadata?: Record<string, unknown>;
}

/**
 * Statistics tracked for a real-time invoice state subscription.
 */
export interface InvoiceSubscriptionStats {
  /** Number of updates delivered to the subscriber. */
  delivered: number;
  /** Number of updates dropped (e.g. due to backpressure). */
  dropped: number;
  /** Number of updates filtered out by the subscription's filter. */
  filtered: number;
  /** Unix timestamp (ms) when the subscription was created. */
  createdAt: number;
  /** Unix timestamp (ms) of the most recently delivered update. */
  lastDeliveredAt?: number;
  /** Sequence number of the most recently delivered update. */
  lastSequence?: number;
}

/**
 * Configuration for creating a real-time invoice state subscription.
 */
export interface InvoiceSubscriptionConfig {
  /** Optional filter restricting which updates are delivered. */
  filter?: InvoiceStateFilter;
  /** Optional maximum number of buffered updates before dropping. */
  bufferSize?: number;
  /** Optional replay of updates after the given sequence number. */
  sinceSequence?: number;
}

/**
 * Callback invoked for each delivered invoice state update.
 */
export type InvoiceStateUpdateHandler = (update: InvoiceStateUpdate) => void;

/**
 * Handle representing an active real-time invoice state subscription.
 */
export interface InvoiceSubscriptionHandle {
  /** Unique identifier for the subscription. */
  id: string;
  /** The filter applied to this subscription, if any. */
  filter?: InvoiceStateFilter;
  /** Returns a snapshot of the subscription's current statistics. */
  getStats(): InvoiceSubscriptionStats;
  /** Unsubscribes and releases resources associated with the subscription. */
  unsubscribe(): void;
}