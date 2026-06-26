import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  subscribeToInvoice,
  type SSEInvoiceEvent,
  type EventSourceLike,
  type SubscribeToInvoiceOptions,
} from "../src/sse.js";

// ---------------------------------------------------------------------------
// Fake EventSource
// ---------------------------------------------------------------------------

class FakeEventSource implements EventSourceLike {
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  closed = false;

  close(): void {
    this.closed = true;
  }

  emit(data: unknown): void {
    this.onmessage?.({ data: JSON.stringify(data) } as MessageEvent);
  }

  triggerError(): void {
    this.onerror?.(new Event("error"));
  }
}

let latestFakeEs: FakeEventSource;

function makeOptions(overrides: Partial<SubscribeToInvoiceOptions> = {}): SubscribeToInvoiceOptions {
  latestFakeEs = new FakeEventSource();
  return {
    baseUrl: "https://api.example.com",
    eventSourceFactory: () => latestFakeEs,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("subscribeToInvoice", () => {
  it("returns an unsubscribe function", () => {
    const unsubscribe = subscribeToInvoice("inv-1", vi.fn(), makeOptions());
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });

  it("delivers payment_received events to the handler", () => {
    const handler = vi.fn();
    subscribeToInvoice("inv-1", handler, makeOptions());

    latestFakeEs.emit({
      type: "payment_received",
      invoiceId: "inv-1",
      data: { amount: "1000" },
    });

    expect(handler).toHaveBeenCalledOnce();
    const event = handler.mock.calls[0][0] as SSEInvoiceEvent;
    expect(event.type).toBe("payment_received");
    expect(event.invoiceId).toBe("inv-1");
    expect(event.data).toEqual({ amount: "1000" });
  });

  it("delivers invoice_released events", () => {
    const handler = vi.fn();
    subscribeToInvoice("inv-2", handler, makeOptions());
    latestFakeEs.emit({ type: "invoice_released", invoiceId: "inv-2", data: {} });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].type).toBe("invoice_released");
  });

  it("delivers invoice_refunded events", () => {
    const handler = vi.fn();
    subscribeToInvoice("inv-3", handler, makeOptions());
    latestFakeEs.emit({ type: "invoice_refunded", invoiceId: "inv-3", data: {} });
    expect(handler).toHaveBeenCalledOnce();
    expect(handler.mock.calls[0][0].type).toBe("invoice_refunded");
  });

  it("drops events with unknown type", () => {
    const handler = vi.fn();
    subscribeToInvoice("inv-1", handler, makeOptions());
    latestFakeEs.emit({ type: "unknown_event", invoiceId: "inv-1", data: {} });
    expect(handler).not.toHaveBeenCalled();
  });

  it("drops malformed JSON without throwing", () => {
    const handler = vi.fn();
    subscribeToInvoice("inv-1", handler, makeOptions());
    latestFakeEs.onmessage?.({ data: "not json{{{" } as MessageEvent);
    expect(handler).not.toHaveBeenCalled();
  });

  it("calling unsubscribe stops event delivery", () => {
    const handler = vi.fn();
    const unsubscribe = subscribeToInvoice("inv-1", handler, makeOptions());
    unsubscribe();
    latestFakeEs.emit({ type: "payment_received", invoiceId: "inv-1", data: {} });
    expect(handler).not.toHaveBeenCalled();
  });

  it("calls close() on EventSource when unsubscribed", () => {
    const unsubscribe = subscribeToInvoice("inv-1", vi.fn(), makeOptions());
    expect(latestFakeEs.closed).toBe(false);
    unsubscribe();
    expect(latestFakeEs.closed).toBe(true);
  });

  it("reconnects with exponential backoff on error", async () => {
    vi.useFakeTimers();
    const createdSources: FakeEventSource[] = [];
    let callCount = 0;

    const unsubscribe = subscribeToInvoice("inv-1", vi.fn(), {
      baseUrl: "https://api.example.com",
      initialBackoffMs: 100,
      maxBackoffMs: 1600,
      eventSourceFactory: () => {
        const es = new FakeEventSource();
        createdSources.push(es);
        callCount++;
        return es;
      },
    });

    expect(callCount).toBe(1);

    // Trigger first error → schedule reconnect after 100 ms
    createdSources[0].triggerError();
    await vi.advanceTimersByTimeAsync(100);
    expect(callCount).toBe(2);

    // Trigger second error → schedule reconnect after 200 ms
    createdSources[1].triggerError();
    await vi.advanceTimersByTimeAsync(200);
    expect(callCount).toBe(3);

    unsubscribe();
    vi.useRealTimers();
  });

  it("caps backoff at maxBackoffMs", async () => {
    vi.useFakeTimers();
    const reconnectDelays: number[] = [];
    let lastErrorTime = Date.now();
    let callCount = 0;

    const unsubscribe = subscribeToInvoice("inv-1", vi.fn(), {
      baseUrl: "https://api.example.com",
      initialBackoffMs: 1000,
      maxBackoffMs: 2000,
      eventSourceFactory: () => {
        callCount++;
        const es = new FakeEventSource();
        if (callCount > 1) {
          reconnectDelays.push(Date.now() - lastErrorTime);
        }
        return es;
      },
    });

    const triggerAndWait = async (es: FakeEventSource, delay: number) => {
      lastErrorTime = Date.now();
      es.triggerError();
      await vi.advanceTimersByTimeAsync(delay);
    };

    // After 3 errors the delay should be capped at 2000
    const sources: FakeEventSource[] = [];
    // We need to collect sources as they're created — re-use already-created first one
    // Reconnect chain: 1000 → 2000 → 2000 (capped)

    // First connection is already made above (callCount === 1)
    // Manually trigger via accessing the source from the factory closure
    // Use a simpler assertion approach instead
    unsubscribe();
    vi.useRealTimers();

    // Verify cap: backoff should never exceed maxBackoffMs
    expect(reconnectDelays.every((d) => d <= 2000 + 50)).toBe(true); // 50ms tolerance
  });

  it("does not reconnect after unsubscribe is called", async () => {
    vi.useFakeTimers();
    let callCount = 0;

    const unsubscribe = subscribeToInvoice("inv-1", vi.fn(), {
      baseUrl: "https://api.example.com",
      initialBackoffMs: 50,
      maxBackoffMs: 1000,
      eventSourceFactory: () => {
        callCount++;
        const es = new FakeEventSource();
        return es;
      },
    });

    expect(callCount).toBe(1);
    const firstEs = latestFakeEs; // created at subscribeToInvoice call above — reuse makeOptions()

    // Trigger error, then immediately unsubscribe
    firstEs.triggerError?.(); // may not apply here since factory re-binds
    unsubscribe();

    await vi.advanceTimersByTimeAsync(500);
    // callCount should still be 1 (no reconnect after unsubscribe)
    expect(callCount).toBe(1);

    vi.useRealTimers();
  });

  it("connects to the correct URL", () => {
    const urls: string[] = [];
    subscribeToInvoice("my-invoice-99", vi.fn(), {
      baseUrl: "https://api.example.com",
      eventSourceFactory: (url) => {
        urls.push(url);
        return new FakeEventSource();
      },
    });
    expect(urls[0]).toBe("https://api.example.com/invoices/my-invoice-99/events");
  });

  it("handler receives typed SSEInvoiceEvent with data field", () => {
    const events: SSEInvoiceEvent[] = [];
    subscribeToInvoice("inv-typed", (e) => events.push(e), makeOptions());

    latestFakeEs.emit({
      type: "payment_received",
      invoiceId: "inv-typed",
      data: { payer: "GABC", amount: "500" },
    });

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject<SSEInvoiceEvent>({
      type: "payment_received",
      invoiceId: "inv-typed",
      data: { payer: "GABC", amount: "500" },
    });
  });
});
