/**
 * Typed event system for state changes and transaction lifecycle events.
 *
 * Supports synchronous and asynchronous handlers, event filtering, and
 * listener registration/deregistration without leaking listeners.
 */

export type EventHandler<T = unknown> = (payload: T) => void | Promise<void>;

export type EventFilter<T = unknown> = (payload: T) => boolean;

export interface EventSubscription {
  /** Remove this listener. Safe to call multiple times. */
  unsubscribe(): void;
}

export interface TransactionEventPayload {
  /** Unique identifier for the transaction. */
  id: string;
  /** Optional transaction hash once available. */
  hash?: string;
  /** Arbitrary transaction metadata. */
  meta?: Record<string, unknown>;
  /** Error details for failed transactions. */
  error?: unknown;
}

export interface StateChangeEventPayload<T = unknown> {
  /** Key of the state slice that changed. */
  key: string;
  /** Previous value, if any. */
  previous: T | undefined;
  /** New value. */
  current: T;
}

export interface EventMap {
  'transaction:submitted': TransactionEventPayload;
  'transaction:confirmed': TransactionEventPayload;
  'transaction:failed': TransactionEventPayload;
  'state:changed': StateChangeEventPayload;
  [event: string]: unknown;
}

export type EventName = keyof EventMap;

export interface EventEmitter {
  /** Register a listener for an event. Returns a subscription handle. */
  on<K extends EventName>(
    event: K,
    handler: EventHandler<EventMap[K]>,
    filter?: EventFilter<EventMap[K]>
  ): EventSubscription;

  /** Register a one-time listener that is removed after first invocation. */
  once<K extends EventName>(
    event: K,
    handler: EventHandler<EventMap[K]>,
    filter?: EventFilter<EventMap[K]>
  ): EventSubscription;

  /** Remove a previously registered listener. */
  off<K extends EventName>(event: K, handler: EventHandler<EventMap[K]>): void;

  /** Emit an event to all matching listeners. Awaits async handlers. */
  emit<K extends EventName>(event: K, payload: EventMap[K]): Promise<void>;

  /** Remove all listeners, optionally scoped to a single event. */
  removeAllListeners(event?: EventName): void;

  /** Number of listeners registered for an event. */
  listenerCount(event: EventName): number;
}

/** Lifecycle step/event name for {@link TransactionBuilder} and {@link TransactionSigner}. */
export type TransactionEventType =
  | "created"
  | "simulated"
  | "signed"
  | "submitted"
  | "confirmed"
  | "transaction.created"
  | "transaction.simulated"
  | "transaction.signed"
  | "transaction.submitted"
  | "transaction.confirmed"
  | "transaction.error"
  | "error";

/** A single transaction lifecycle event, as emitted on the plain `EventEmitter` channel. */
export interface TransactionEvent {
  type: TransactionEventType;
  transactionId: string;
  timestamp: number | string;
  success?: boolean;
  error?: unknown;
  details?: Record<string, unknown>;
}
