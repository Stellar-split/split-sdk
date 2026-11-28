import { Invoice } from "./types.js";

/**
 * Handler function for invoice state updates.
 */
type InvoiceHandler = (invoiceId: string, invoice: Invoice) => void;

/**
 * Event emitted when a broadcast is accepted or rejected by deduplication.
 */
export type DeduplicationEvent =
  | { type: "accepted"; invoiceId: string; nonce: string }
  | { type: "duplicate"; invoiceId: string; nonce: string };

/**
 * Handler function for deduplication events.
 */
export type DeduplicationEventHandler = (event: DeduplicationEvent) => void;

/**
 * Options for optional request deduplication by nonce.
 */
export interface DeduplicationOptions {
  /**
   * Whether deduplication is enabled. Defaults to false so existing behavior
   * is unchanged unless explicitly opted in.
   */
  enabled?: boolean;
  /**
   * Time-to-live in milliseconds for a seen nonce. Defaults to 60000.
   */
  ttlMs?: number;
  /**
   * Maximum number of nonces to retain. Oldest entries are evicted first.
   * Defaults to 1000.
   */
  maxEntries?: number;
}

/**
 * Invoice state broadcaster that publishes state changes to multiple subscribers.
 */
export class InvoiceStateBroadcaster {
  private subscribers: Map<string, Set<InvoiceHandler>> = new Map();
  private dedupEnabled: boolean;
  private dedupTtlMs: number;
  private dedupMaxEntries: number;
  private seenNonces: Map<string, number> = new Map();
  private dedupHandlers: Set<DeduplicationEventHandler> = new Set();

  constructor(options: DeduplicationOptions = {}) {
    this.dedupEnabled = options.enabled ?? false;
    this.dedupTtlMs = options.ttlMs ?? 60000;
    this.dedupMaxEntries = options.maxEntries ?? 1000;
  }

  /**
   * Subscribe to invoice state updates for a specific invoice ID.
   * 
   * @param invoiceId - The invoice ID to subscribe to
   * @param handler - The handler function to call when updates are received
   * @returns Unsubscribe function that removes only this subscriber
   */
  subscribe(invoiceId: string, handler: InvoiceHandler): () => void {
    if (!this.subscribers.has(invoiceId)) {
      this.subscribers.set(invoiceId, new Set());
    }
    
    const handlers = this.subscribers.get(invoiceId)!;
    handlers.add(handler);
    
    return () => {
      handlers.delete(handler);
      // Clean up empty sets
      if (handlers.size === 0) {
        this.subscribers.delete(invoiceId);
      }
    };
  }

  /**
   * Subscribe to deduplication events (accepted / duplicate).
   *
   * @param handler - The handler function to call for each dedup event
   * @returns Unsubscribe function that removes only this handler
   */
  onDeduplication(handler: DeduplicationEventHandler): () => void {
    this.dedupHandlers.add(handler);
    return () => {
      this.dedupHandlers.delete(handler);
    };
  }

  /**
   * Broadcast an invoice state update to all subscribers of the given invoice ID.
   * 
   * When deduplication is enabled and a nonce is provided, duplicate nonces are
   * rejected and no subscribers are notified.
   * 
   * @param invoiceId - The invoice ID to broadcast to
   * @param invoice - The updated invoice state
   * @param nonce - Optional nonce used for request deduplication
   * @returns True if the broadcast was delivered, false if rejected as duplicate
   */
  broadcast(invoiceId: string, invoice: Invoice, nonce?: string): boolean {
    if (this.dedupEnabled && nonce !== undefined) {
      if (this.isDuplicate(nonce)) {
        this.emitDeduplication({ type: "duplicate", invoiceId, nonce });
        return false;
      }
      this.recordNonce(nonce);
      this.emitDeduplication({ type: "accepted", invoiceId, nonce });
    }

    const handlers = this.subscribers.get(invoiceId);
    if (!handlers || handlers.size === 0) {
      return true; // No subscribers for this invoice ID
    }
    
    // Call all handlers with the updated invoice
    handlers.forEach((handler) => {
      try {
        handler(invoiceId, invoice);
      } catch (error) {
        console.error(`Error in invoice handler for ${invoiceId}:`, error);
      }
    });

    return true;
  }

  /**
   * Get the number of subscribers for a given invoice ID.
   * 
   * @param invoiceId - The invoice ID to check
   * @returns Number of subscribers
   */
  getSubscriberCount(invoiceId: string): number {
    return this.subscribers.get(invoiceId)?.size ?? 0;
  }

  /**
   * Check whether a nonce has already been seen and is still within its TTL.
   */
  private isDuplicate(nonce: string): boolean {
    const seenAt = this.seenNonces.get(nonce);
    if (seenAt === undefined) {
      return false;
    }
    if (Date.now() - seenAt >= this.dedupTtlMs) {
      this.seenNonces.delete(nonce);
      return false;
    }
    return true;
  }

  /**
   * Record a nonce as seen, evicting expired and oldest entries as needed.
   */
  private recordNonce(nonce: string): void {
    const now = Date.now();
    for (const [key, seenAt] of this.seenNonces) {
      if (now - seenAt >= this.dedupTtlMs) {
        this.seenNonces.delete(key);
      }
    }
    this.seenNonces.set(nonce, now);
    while (this.seenNonces.size > this.dedupMaxEntries) {
      const oldest = this.seenNonces.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.seenNonces.delete(oldest);
    }
  }

  /**
   * Emit a deduplication event to all registered handlers.
   */
  private emitDeduplication(event: DeduplicationEvent): void {
    this.dedupHandlers.forEach((handler) => {
      try {
        handler(event);
      } catch (error) {
        console.error("Error in deduplication handler:", error);
      }
    });
  }
}

/**
 * Creates a new InvoiceStateBroadcaster instance.
 * 
 * @param options - Optional deduplication configuration
 * @returns A new InvoiceStateBroadcaster instance
 */
export function createInvoiceStateBroadcaster(
  options: DeduplicationOptions = {},
): InvoiceStateBroadcaster {
  return new InvoiceStateBroadcaster(options);
}

/**
 * Estimates SDK fees using historical fee observations.
 *
 * The estimate is derived from the provided history: the most recent
 * observation is weighted against the historical average so that recent
 * network conditions inform the result without discarding past data.
 * Emits lifecycle events so callers can react to estimates and errors.
 */
/** A single historical fee-rate observation. */
export interface FeeHistoryEntry {
  /** Observed fee rate, in stroops. */
  feeRate: number;
  /** Unix ms timestamp the observation was recorded. */
  timestamp: number;
}

/** A fee estimate derived from recent {@link FeeHistoryEntry} history. */
export interface FeeEstimate {
  feeRate: number;
  minFeeRate: number;
  maxFeeRate: number;
  averageFeeRate: number;
  sampleCount: number;
}

/** Lifecycle event emitted by {@link FeeEstimator}. */
export type FeeEstimationEvent = "estimate" | "error";

/** Handler function for {@link FeeEstimator} lifecycle events. */
export type FeeEstimationHandler = (event: FeeEstimationEvent, payload: FeeEstimate | Error) => void;

export class FeeEstimator {
  private history: FeeHistoryEntry[] = [];
  private handlers: Set<FeeEstimationHandler> = new Set();

  /**
   * Subscribe to fee estimation lifecycle events.
   *
   * @param handler - Handler invoked on "estimate" and "error" events
   * @returns Unsubscribe function that removes only this handler
   */
  on(handler: FeeEstimationHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Record a historical fee observation.
   *
   * @param entry - The fee history entry to record
   */
  record(entry: FeeHistoryEntry): void {
    this.history.push(entry);
  }

  /**
   * Get a copy of the recorded fee history.
   *
   * @returns The recorded fee history entries
   */
  getHistory(): FeeHistoryEntry[] {
    return [...this.history];
  }

  /**
   * Estimate the current fee rate using historical analysis.
   *
   * @param windowSize - Optional number of most recent samples to analyze
   * @returns The fee estimate, or null when no history is available
   */
  estimate(windowSize?: number): FeeEstimate | null {
    try {
      const samples =
        windowSize && windowSize > 0
          ? this.history.slice(-windowSize)
          : this.history;

      if (samples.length === 0) {
        return null;
      }

      const rates = samples.map((entry) => entry.feeRate);
      const minFeeRate = Math.min(...rates);
      const maxFeeRate = Math.max(...rates);
      const averageFeeRate =
        rates.reduce((sum, rate) => sum + rate, 0) / rates.length;

      // Weight the most recent observation against the historical average.
      const latest = samples[samples.length - 1]!.feeRate;
      const feeRate = Math.round((latest + averageFeeRate) / 2);

      const estimate: FeeEstimate = {
        feeRate,
        minFeeRate,
        maxFeeRate,
        averageFeeRate,
        sampleCount: samples.length,
      };

      this.emit("estimate", estimate);
      return estimate;
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
      return null;
    }
  }

  private emit(event: FeeEstimationEvent, payload: FeeEstimate | Error): void {
    this.handlers.forEach((handler) => {
      try {
        handler(event, payload);
      } catch (error) {
        console.error(`Error in fee estimation handler for ${event}:`, error);
      }
    });
  }
}

/**
 * Creates a new FeeEstimator instance.
 *
 * @returns A new FeeEstimator instance
 */
export function createFeeEstimator(): FeeEstimator {
  return new FeeEstimator();
}

/**
 * Optimizes payment pathways by scoring candidates on cost and reliability.
 *
 * Each candidate is scored so that cheaper fees and higher success
 * probabilities rank higher. The optimizer emits lifecycle events so callers
 * can react to optimization results and errors.
 */
/** A candidate payment pathway to be scored by {@link PaymentPathwayOptimizer}. */
export interface PaymentPathway {
  /** Identifier for this pathway (e.g. the intermediary asset/route). */
  id: string;
  /** Probability the payment succeeds via this pathway, in `[0, 1]`. */
  successProbability: number;
  /** Fee rate charged by this pathway, in stroops. */
  feeRate: number;
}

/** A {@link PaymentPathway} annotated with its composite score. */
export interface ScoredPaymentPathway extends PaymentPathway {
  /** Composite score (higher is better): success probability divided by fee rate. */
  score: number;
}

/** Result of optimizing a set of candidate payment pathways. */
export interface PaymentPathwayOptimization {
  /** All evaluated pathways, ordered from best to worst. */
  pathways: ScoredPaymentPathway[];
  /** The highest-scored pathway, or `null` when none were evaluated. */
  recommended: ScoredPaymentPathway | null;
  /** Number of pathways evaluated. */
  evaluatedCount: number;
}

/** Lifecycle event emitted by {@link PaymentPathwayOptimizer}. */
export type PaymentPathwayEvent = "optimized" | "error";

/** Handler function for {@link PaymentPathwayOptimizer} lifecycle events. */
export type PaymentPathwayHandler = (
  event: PaymentPathwayEvent,
  payload: PaymentPathwayOptimization | Error,
) => void;

export class PaymentPathwayOptimizer {
  private handlers: Set<PaymentPathwayHandler> = new Set();

  /**
   * Subscribe to payment pathway optimization lifecycle events.
   *
   * @param handler - Handler invoked on "optimized" and "error" events
   * @returns Unsubscribe function that removes only this handler
   */
  on(handler: PaymentPathwayHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Score a single payment pathway.
   *
   * The score rewards higher success probability and penalizes higher fees.
   * A zero or negative fee rate is treated as the cheapest possible pathway.
   *
   * @param pathway - The candidate pathway to score
   * @returns The pathway annotated with its composite score
   */
  scorePathway(pathway: PaymentPathway): ScoredPaymentPathway {
    const probability = Math.min(Math.max(pathway.successProbability, 0), 1);
    const feeRate = pathway.feeRate > 0 ? pathway.feeRate : 1;
    const score = probability / feeRate;
    return { ...pathway, score };
  }

  /**
   * Optimize a set of candidate payment pathways.
   *
   * @param pathways - The candidate pathways to evaluate
   * @returns The optimization result, ordered from best to worst
   */
  optimize(pathways: PaymentPathway[]): PaymentPathwayOptimization {
    try {
      const scored = pathways
        .map((pathway) => this.scorePathway(pathway))
        .sort((a, b) => b.score - a.score);

      const result: PaymentPathwayOptimization = {
        pathways: scored,
        recommended: scored.length > 0 ? scored[0]! : null,
        evaluatedCount: scored.length,
      };

      this.emit("optimized", result);
      return result;
    } catch (error) {
      this.emit("error", error instanceof Error ? error : new Error(String(error)));
      return { pathways: [], recommended: null, evaluatedCount: 0 };
    }
  }

  private emit(event: PaymentPathwayEvent, payload: PaymentPathwayOptimization | Error): void {
    this.handlers.forEach((handler) => {
      try {
        handler(event, payload);
      } catch (error) {
        console.error(`Error in payment pathway handler for ${event}:`, error);
      }
    });
  }
}

/**
 * Creates a new PaymentPathwayOptimizer instance.
 *
 * @returns A new PaymentPathwayOptimizer instance
 */
export function createPaymentPathwayOptimizer(): PaymentPathwayOptimizer {
  return new PaymentPathwayOptimizer();
}

/**
 * Lifecycle phase of a simulated transaction rollback.
 */
export type RollbackPhase = "start" | "success" | "failure";

/**
 * Event emitted during a transaction rollback simulation.
 */
export interface RollbackEvent {
  /** The transaction identifier being rolled back. */
  transactionId: string;
  /** The lifecycle phase this event represents. */
  phase: RollbackPhase;
  /** Optional error when the rollback fails. */
  error?: Error;
}

/**
 * Handler invoked for each rollback lifecycle event.
 */
export type RollbackEventHandler = (event: RollbackEvent) => void;

/**
 * Simulates SDK transaction rollbacks, emitting lifecycle events for the
 * start, success, and failure phases of each rollback.
 */
export class TransactionRollbackSimulator {
  private handlers: Set<RollbackEventHandler> = new Set();

  /**
   * Register a handler for rollback lifecycle events.
   *
   * @param handler - The handler to invoke on each event
   * @returns Unsubscribe function that removes only this handler
   */
  onRollback(handler: RollbackEventHandler): () => void {
    this.handlers.add(handler);
    return () => {
      this.handlers.delete(handler);
    };
  }

  /**
   * Simulate rolling back a transaction. Emits a "start" event, then either a
   * "success" event or a "failure" event depending on the outcome.
   *
   * @param transactionId - The transaction identifier to roll back
   * @param shouldFail - When true, the rollback fails and emits a failure event
   * @returns True when the rollback succeeded, false otherwise
   */
  simulateRollback(transactionId: string, shouldFail = false): boolean {
    this.emit({ transactionId, phase: "start" });

    if (shouldFail) {
      const error = new Error(`Rollback failed for transaction ${transactionId}`);
      this.emit({ transactionId, phase: "failure", error });
      return false;
    }

    this.emit({ transactionId, phase: "success" });
    return true;
  }

  private emit(event: RollbackEvent): void {
    this.handlers.forEach((handler) => {
      try {
        handler(event);
      } catch (error) {
        console.error(`Error in rollback handler for ${event.transactionId}:`, error);
      }
    });
  }
}

/**
 * Creates a new TransactionRollbackSimulator instance.
 *
 * @returns A new TransactionRollbackSimulator instance
 */
export function createTransactionRollbackSimulator(): TransactionRollbackSimulator {
  return new TransactionRollbackSimulator();
}

/**
 * Manages invoice notification subscriptions on top of an
 * {@link InvoiceStateBroadcaster}, emitting lifecycle events for
 * subscribe, unsubscribe, and notify operations.
 */
/** Lifecycle event emitted by {@link InvoiceNotificationSubscriptionManager}. */
export type InvoiceNotificationEvent =
  | { type: "subscribed"; invoiceId: string }
  | { type: "unsubscribed"; invoiceId: string }
  | { type: "notified"; invoiceId: string; invoice: Invoice };

/** Handler function for {@link InvoiceNotificationSubscriptionManager} lifecycle events. */
export type NotificationEventHandler = (event: InvoiceNotificationEvent) => void;

export class InvoiceNotificationSubscriptionManager {
  private readonly broadcaster: InvoiceStateBroadcaster;
  private readonly eventHandlers: Set<NotificationEventHandler> = new Set();
  private readonly unsubscribers: Map<string, Map<InvoiceHandler, () => void>> =
    new Map();

  constructor(broadcaster: InvoiceStateBroadcaster = createInvoiceStateBroadcaster()) {
    this.broadcaster = broadcaster;
  }

  /**
   * Register a handler for notification lifecycle events.
   *
   * @param handler - The event handler to register
   * @returns Unsubscribe function that removes only this handler
   */
  onEvent(handler: NotificationEventHandler): () => void {
    this.eventHandlers.add(handler);
    return () => {
      this.eventHandlers.delete(handler);
    };
  }

  /**
   * Subscribe to invoice notifications for a specific invoice ID.
   *
   * @param invoiceId - The invoice ID to subscribe to
   * @param handler - The handler function to call when notifications are received
   * @returns Unsubscribe function that removes only this subscriber
   */
  subscribe(invoiceId: string, handler: InvoiceHandler): () => void {
    const unsubscribe = this.broadcaster.subscribe(invoiceId, handler);

    if (!this.unsubscribers.has(invoiceId)) {
      this.unsubscribers.set(invoiceId, new Map());
    }
    this.unsubscribers.get(invoiceId)!.set(handler, unsubscribe);

    this.emit({ type: "subscribed", invoiceId });

    return () => {
      const handlers = this.unsubscribers.get(invoiceId);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.unsubscribers.delete(invoiceId);
        }
      }
      unsubscribe();
      this.emit({ type: "unsubscribed", invoiceId });
    };
  }

  /**
   * Notify all subscribers of an invoice state update.
   *
   * @param invoiceId - The invoice ID to notify
   * @param invoice - The updated invoice state
   */
  notify(invoiceId: string, invoice: Invoice): void {
    this.broadcaster.broadcast(invoiceId, invoice);
    this.emit({ type: "notified", invoiceId, invoice });
  }

  /**
   * Get the number of subscribers for a given invoice ID.
   *
   * @param invoiceId - The invoice ID to check
   * @returns Number of subscribers
   */
  getSubscriberCount(invoiceId: string): number {
    return this.broadcaster.getSubscriberCount(invoiceId);
  }

  /**
   * Remove all subscriptions and event handlers.
   */
  clear(): void {
    this.unsubscribers.forEach((handlers) => {
      handlers.forEach((unsubscribe) => unsubscribe());
    });
    this.unsubscribers.clear();
    this.eventHandlers.clear();
  }

  private emit(event: InvoiceNotificationEvent): void {
    this.eventHandlers.forEach((handler) => {
      try {
        handler(event);
      } catch (error) {
        console.error("Error in invoice notification event handler:", error);
      }
    });
  }
}

/**
 * Creates a new InvoiceNotificationSubscriptionManager instance.
 *
 * @param broadcaster - Optional broadcaster to use for state updates
 * @returns A new InvoiceNotificationSubscriptionManager instance
 */
export function createInvoiceNotificationSubscriptionManager(
  broadcaster?: InvoiceStateBroadcaster
): InvoiceNotificationSubscriptionManager {
  return new InvoiceNotificationSubscriptionManager(broadcaster);
}
