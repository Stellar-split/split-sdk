/**
 * SSE-based real-time invoice event subscription.
 */

/** The three event types emitted by the invoice SSE stream. */
export type SSEInvoiceEventType =
  | "payment_received"
  | "invoice_released"
  | "invoice_refunded";

/** A typed invoice event delivered to the handler. */
export interface SSEInvoiceEvent {
  type: SSEInvoiceEventType;
  invoiceId: string;
  data: Record<string, unknown>;
}

/** Handler function called for each incoming event. */
export type InvoiceEventHandler = (event: SSEInvoiceEvent) => void;

/** Options for subscribeToInvoice. */
export interface SubscribeToInvoiceOptions {
  /** Base URL of the event stream server (no trailing slash). */
  baseUrl: string;
  /** Initial reconnect delay in ms (doubles each attempt). Default: 1000. */
  initialBackoffMs?: number;
  /** Maximum reconnect delay in ms. Default: 30000. */
  maxBackoffMs?: number;
  /** Factory for EventSource (injectable for testing). Default: global EventSource. */
  eventSourceFactory?: (url: string) => EventSourceLike;
}

/** Minimal EventSource interface (subset of the browser API). */
export interface EventSourceLike {
  onmessage: ((event: MessageEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  close(): void;
}

const SSE_EVENT_TYPES: SSEInvoiceEventType[] = [
  "payment_received",
  "invoice_released",
  "invoice_refunded",
];

/**
 * Subscribe to real-time invoice events via SSE.
 *
 * Connects to `{baseUrl}/invoices/{invoiceId}/events` and delivers typed
 * `SSEInvoiceEvent` objects to `handler`. Reconnects automatically with
 * exponential backoff on connection drops.
 *
 * @returns An unsubscribe function that permanently stops the subscription.
 */
export function subscribeToInvoice(
  invoiceId: string,
  handler: InvoiceEventHandler,
  options: SubscribeToInvoiceOptions,
): () => void {
  const {
    baseUrl,
    initialBackoffMs = 1000,
    maxBackoffMs = 30_000,
    eventSourceFactory,
  } = options;

  const url = `${baseUrl}/invoices/${encodeURIComponent(invoiceId)}/events`;
  const factory =
    eventSourceFactory ??
    ((u: string) => new EventSource(u) as EventSourceLike);

  let stopped = false;
  let backoff = initialBackoffMs;
  let es: EventSourceLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

  function connect(): void {
    if (stopped) return;

    es = factory(url);

    es.onmessage = (event: MessageEvent) => {
      if (stopped) return;
      try {
        const raw = JSON.parse(event.data as string) as {
          type?: unknown;
          invoiceId?: unknown;
          data?: unknown;
        };

        if (
          typeof raw.type !== "string" ||
          !(SSE_EVENT_TYPES as string[]).includes(raw.type) ||
          typeof raw.invoiceId !== "string"
        ) {
          return;
        }

        backoff = initialBackoffMs; // reset on successful message

        handler({
          type: raw.type as SSEInvoiceEventType,
          invoiceId: raw.invoiceId,
          data:
            raw.data !== null && typeof raw.data === "object"
              ? (raw.data as Record<string, unknown>)
              : {},
        });
      } catch {
        // Malformed message — skip
      }
    };

    es.onerror = () => {
      es?.close();
      es = null;
      if (stopped) return;
      reconnectTimer = setTimeout(() => {
        backoff = Math.min(backoff * 2, maxBackoffMs);
        connect();
      }, backoff);
    };
  }

  connect();

  return () => {
    stopped = true;
    if (reconnectTimer !== null) clearTimeout(reconnectTimer);
    es?.close();
    es = null;
  };
}
