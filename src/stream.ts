import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type { InvoiceEventCallbacks, Payment } from "./types.js";
import type { SSEInvoiceEvent } from "./sse.js";
import { TooManySubscriptionsError } from "./errors.js";

/** Maximum concurrent subscriptions allowed. */
const MAX_SUBSCRIPTIONS = 10;

/** Current number of active subscriptions. */
let subscriptionCount = 0;

/**
 * Poll-based handler receives all events since the last poll as an array.
 */
export type PollingInvoiceEventHandler = (events: SSEInvoiceEvent[]) => void;

/** Check if the page visibility API is available and the page is hidden. */
function isPageHidden(): boolean {
  return typeof document !== "undefined" && document.hidden === true;
}

/** Setup page visibility change handlers for pausing/resuming polling. Only active in browser environments. */
function setupVisibilityHandlers(
  pause: () => void,
  resume: () => void
): () => void {
  if (typeof document === "undefined") {
    return () => {};
  }

  const handleChange = () => {
    if (isPageHidden()) {
      pause();
    } else {
      resume();
    }
  };

  document.addEventListener("visibilitychange", handleChange);
  return () => {
    document.removeEventListener("visibilitychange", handleChange);
  };
}

/** Convert internal event to SSEInvoiceEvent format. */
function convertToInvoiceEvent(
  eventType: string,
  invoiceId: string,
  payment: Payment | null
): SSEInvoiceEvent | null {
  let type: "payment_received" | "invoice_released" | "invoice_refunded" | null = null;

  if (eventType === "payment") {
    type = "payment_received";
  } else if (eventType === "released") {
    type = "invoice_released";
  } else if (eventType === "refunded") {
    type = "invoice_refunded";
  }

  if (!type) return null;

  return {
    type,
    invoiceId,
    data: payment
      ? { payer: payment.payer, amount: payment.amount.toString() }
      : {},
  };
}

/** Extract invoice ID from a raw event. */
function extractInvoiceId(event: SorobanRpc.Api.EventResponse): string | null {
  const topic = event.topic as unknown[];
  if (Array.isArray(topic) && topic.length > 1) {
    const id = topic[1];
    if (typeof id === "string") return id;
    if (typeof id === "number" || typeof id === "bigint") return String(id);
  }

  const value = (event.value as unknown) as Record<string, unknown> | undefined;
  const id = value?.invoiceId;
  if (typeof id === "string") return id;
  if (typeof id === "number" || typeof id === "bigint") return String(id);
  return null;
}

/** Extract a Payment from a payment event. */
function extractPayment(event: SorobanRpc.Api.EventResponse): Payment | null {
  const value = (event.value as unknown) as Record<string, unknown> | undefined;
  if (!value) return null;

  const payer = value.payer;
  const amount = value.amount;

  if (typeof payer !== "string") return null;
  if (typeof amount !== "string" && typeof amount !== "number" && typeof amount !== "bigint") return null;

  return {
    payer,
    amount: BigInt(amount as string | number),
  };
}

/**
 * Subscribe to live invoice events via polling.
 *
 * - Polls every 5 seconds initially; backs off to 30 seconds after 3 unchanged polls
 * - Resets to 5 seconds immediately when a change is detected
 * - Handler receives InvoiceEvent[] containing only events since the last poll
 * - Polling pauses when document.hidden is true (Page Visibility API); resumes on focus
 * - Supports up to 10 concurrent subscriptions
 *
 * @param server - Soroban RPC server instance
 * @param contractId - The deployed StellarSplit contract ID
 * @param invoiceId - The invoice ID to watch
 * @param handlerOrCallbacks - Called with InvoiceEvent[] (events since last poll), or callbacks object for legacy API
 * @param intervalMs - Poll interval in milliseconds (default: 5000, max: 30000)
 * @returns Unsubscribe function that stops the stream
 * @throws TooManySubscriptionsError if more than 10 subscriptions are created
 */
export function subscribeToInvoice(
  server: SorobanRpc.Server,
  contractId: string,
  invoiceId: string,
  handlerOrCallbacks: ((events: SSEInvoiceEvent[]) => void) | InvoiceEventCallbacks,
  intervalMs: number = 5000
): () => void {
  // Check subscription limit
  if (subscriptionCount >= MAX_SUBSCRIPTIONS) {
    throw new TooManySubscriptionsError(MAX_SUBSCRIPTIONS);
  }
  subscriptionCount++;

  let stopped = false;
  let paused = false;
  let lastLedger: number | null = null;
  let backoffMs = intervalMs;
  const initialIntervalMs = intervalMs;
  const maxBackoffMs = 30000;
  const unchangedThreshold = 3;
  let unchangedCount = 0;
  let timerId: ReturnType<typeof setTimeout> | null = null;

  const isHandler = typeof handlerOrCallbacks === "function";
  const callbacks = isHandler ? null : handlerOrCallbacks;
  const handler = isHandler ? handlerOrCallbacks : null;

  const pause = () => {
    paused = true;
  };

  const resume = () => {
    paused = false;
    poll();
  };

  const cleanupVisibility = setupVisibilityHandlers(pause, resume);

  const clearTimer = () => {
    if (timerId !== null) {
      clearTimeout(timerId);
      timerId = null;
    }
  };

  const poll = async (): Promise<void> => {
    if (stopped || paused) {
      clearTimer();
      if (!stopped) {
        timerId = setTimeout(poll, backoffMs);
      }
      return;
    }

    const eventsSinceLastPoll: SSEInvoiceEvent[] = [];

    try {
      if (lastLedger === null) {
        const latest = await server.getLatestLedger();
        lastLedger = latest.sequence;
      }

      const response = await server.getEvents({
        startLedger: lastLedger,
        filters: [{ type: "contract", contractIds: [contractId] }],
      });

      const events = response.events;
      let maxLedger = lastLedger;
      let hasChanges = false;

      for (const event of events) {
        if (event.ledger > maxLedger) maxLedger = event.ledger;

        const topic = event.topic as unknown[];
        if (!Array.isArray(topic) || topic.length === 0) continue;

        const eventType = typeof topic[0] === "string" ? topic[0] : null;
        if (!eventType) continue;

        const eventInvoiceId = extractInvoiceId(event);
        if (eventInvoiceId !== invoiceId) continue;

        hasChanges = true;

        const invoiceEvent = convertToInvoiceEvent(
          eventType,
          eventInvoiceId,
          eventType === "payment" ? extractPayment(event) : null
        );

        if (invoiceEvent) {
          eventsSinceLastPoll.push(invoiceEvent);

          // Legacy callback support
          if (callbacks) {
            if (eventType === "payment" && callbacks.onPayment) {
              const payment = extractPayment(event);
              if (payment) callbacks.onPayment(payment);
            } else if (eventType === "released" && callbacks.onReleased) {
              callbacks.onReleased();
            } else if (eventType === "refunded" && callbacks.onRefunded) {
              callbacks.onRefunded();
            }
          }
        }
      }

      if (hasChanges) {
        // Reset backoff immediately when a change is detected
        backoffMs = initialIntervalMs;
        unchangedCount = 0;

        // Call handler with all events since last poll
        if (handler && eventsSinceLastPoll.length > 0) {
          handler(eventsSinceLastPoll);
        }
      } else {
        unchangedCount++;
        // Back off to 30 seconds after 3 unchanged polls
        if (unchangedCount >= unchangedThreshold) {
          backoffMs = maxBackoffMs;
        }
      }

      lastLedger = maxLedger + 1;
    } catch {
      // Silently continue on network errors
    }

    if (!stopped && !paused) {
      timerId = setTimeout(poll, backoffMs);
    }
  };

  poll();

  const unsubscribe = () => {
    stopped = true;
    paused = false;
    clearTimer();
    cleanupVisibility();
    subscriptionCount--;
  };

  return unsubscribe;
}