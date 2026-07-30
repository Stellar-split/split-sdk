/**
 * Aggregates per-recipient payment status into a single progress view for
 * long-running, multi-recipient invoices (multiple tranches or async
 * recipient claims).
 *
 * One `InvoiceStatusPoller` (see poller.ts) is run per recipient leg, keyed
 * by a composite `${invoiceId}:${accountId}` id so per-recipient pollers for
 * the same invoice don't coalesce into a single poller. Progress is recomputed
 * and emitted every time any recipient's status changes.
 */

import { InvoiceStatusPoller } from "./poller.js";
import { TypedEventEmitter } from "./events/TypedEventEmitter.js";
import { getTrancheProgress } from "./trancheProgress.js";
import type {
  Invoice,
  InvoicePaymentProgress,
  RecipientPaymentState,
} from "./types.js";

/** Statuses treated as final/settled when computing percentComplete. */
const SETTLED_STATUSES: ReadonlySet<string> = new Set([
  "Released",
  "Refunded",
  "Cancelled",
]);

/** Event map emitted by {@link PaymentProgressTracker}. */
export interface PaymentProgressEventMap {
  invoiceProgressUpdated: InvoicePaymentProgress;
}

/** Options controlling {@link PaymentProgressTracker} behaviour. */
export interface PaymentProgressTrackerOptions {
  /** Poll interval per recipient leg, in milliseconds. Default: 5000. */
  pollIntervalMs?: number;
  /** Fetch the current status of a single recipient's payment leg. */
  fetchRecipientStatus?: (invoiceId: string, accountId: string) => Promise<string>;
}

interface TrackedSubscription {
  pollers: InvoiceStatusPoller[];
  unsubscribes: Array<() => void>;
  states: Map<string, RecipientPaymentState>;
}

/**
 * Subscribes callers to aggregated payment progress for an invoice,
 * polling every recipient leg independently and reporting a single
 * `InvoicePaymentProgress` snapshot on every change.
 */
export class PaymentProgressTracker extends TypedEventEmitter<PaymentProgressEventMap> {
  private readonly subscriptions = new Map<string, TrackedSubscription>();
  private readonly pollIntervalMs: number;
  private readonly fetchRecipientStatus: (invoiceId: string, accountId: string) => Promise<string>;
  private readonly fetchInvoice: (invoiceId: string) => Promise<Invoice>;

  constructor(
    fetchInvoice: (invoiceId: string) => Promise<Invoice>,
    options: PaymentProgressTrackerOptions = {},
  ) {
    super();
    this.fetchInvoice = fetchInvoice;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.fetchRecipientStatus = options.fetchRecipientStatus ?? (async () => "Pending");
  }

  /**
   * Start polling every recipient leg of `invoiceId` and invoke `onProgress`
   * with an aggregated `InvoicePaymentProgress` snapshot on each change (and
   * once immediately with the initial state). No-op if already subscribed.
   */
  async subscribe(
    invoiceId: string,
    onProgress: (progress: InvoicePaymentProgress) => void,
  ): Promise<void> {
    if (this.subscriptions.has(invoiceId)) return;

    const invoice = await this.fetchInvoice(invoiceId);
    const trancheProgress = await getTrancheProgress(invoice).catch(() => undefined);

    const states = new Map<string, RecipientPaymentState>();
    for (const recipient of invoice.recipients) {
      states.set(recipient.address, {
        accountId: recipient.address,
        status: "Pending",
        settledAmount: 0n,
        lastUpdatedAt: Date.now(),
      });
    }

    const subscription: TrackedSubscription = { pollers: [], unsubscribes: [], states };
    this.subscriptions.set(invoiceId, subscription);

    const emitProgress = () => {
      const progress = this.computeProgress(invoiceId, states, trancheProgress);
      this.emit("invoiceProgressUpdated", progress);
      onProgress(progress);
    };

    for (const recipient of invoice.recipients) {
      const compositeId = `${invoiceId}:${recipient.address}`;
      const poller = new InvoiceStatusPoller(
        { invoiceId: compositeId, pollIntervalMs: this.pollIntervalMs },
        () => this.fetchRecipientStatus(invoiceId, recipient.address),
      );

      const off = poller.on("invoiceStatusChanged", (event) => {
        const state = states.get(recipient.address);
        if (!state) return;
        state.status = event.current;
        state.lastUpdatedAt = event.timestamp;
        if (SETTLED_STATUSES.has(event.current)) {
          state.settledAmount = recipient.amount;
        }
        emitProgress();
      });

      subscription.unsubscribes.push(off);
      subscription.pollers.push(poller);
      poller.start();
    }

    emitProgress();
  }

  /** Stop all pollers for `invoiceId` and remove its subscription. */
  unsubscribe(invoiceId: string): void {
    const subscription = this.subscriptions.get(invoiceId);
    if (!subscription) return;
    for (const poller of subscription.pollers) poller.stop();
    for (const off of subscription.unsubscribes) off();
    this.subscriptions.delete(invoiceId);
  }

  private computeProgress(
    invoiceId: string,
    states: Map<string, RecipientPaymentState>,
    trancheProgress: InvoicePaymentProgress["trancheProgress"],
  ): InvoicePaymentProgress {
    const recipientStates = Array.from(states.values());
    const settledLegs = recipientStates.filter((s) => SETTLED_STATUSES.has(s.status)).length;
    const totalLegs = recipientStates.length;
    const percentComplete = totalLegs === 0 ? 0 : (settledLegs / totalLegs) * 100;

    return {
      invoiceId,
      percentComplete,
      recipientStates,
      ...(trancheProgress ? { trancheProgress } : {}),
    };
  }
}
