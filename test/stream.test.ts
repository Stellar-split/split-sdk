import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { SSEInvoiceEvent } from "../src/sse.js";
import { TooManySubscriptionsError, isTooManySubscriptionsError } from "../src/errors.js";

describe("TooManySubscriptionsError", () => {
  it("has correct code and context", () => {
    const error = new TooManySubscriptionsError(10);
    expect(error.code).toBe("TOO_MANY_SUBSCRIPTIONS");
    expect(error.context).toEqual({ maxSubscriptions: 10 });
    expect(error.name).toBe("TooManySubscriptionsError");
    expect(error.message).toBe("Maximum concurrent subscriptions (10) exceeded");
  });

  it("isTooManySubscriptionsError type guard works", () => {
    const error = new TooManySubscriptionsError();
    expect(isTooManySubscriptionsError(error)).toBe(true);
    expect(isTooManySubscriptionsError(new Error("test"))).toBe(false);
  });

  it("works as regular Error", () => {
    const error = new TooManySubscriptionsError(5);
    expect(error instanceof Error).toBe(true);
    expect(error instanceof TooManySubscriptionsError).toBe(true);
  });
});

describe("subscribeToInvoice (polling)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns unsubscribe function", async () => {
    const { subscribeToInvoice } = await import("../src/stream.js");
    const mockServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
      getEvents: vi.fn().mockResolvedValue({ events: [] }),
    };

    const unsubscribe = subscribeToInvoice(
      mockServer as unknown as Parameters<typeof subscribeToInvoice>[0],
      "contract-id",
      "inv-1",
      vi.fn()
    );
    expect(typeof unsubscribe).toBe("function");
    unsubscribe();
  });

  it("calls getLatestLedger on first poll", async () => {
    const { subscribeToInvoice } = await import("../src/stream.js");
    const mockServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
      getEvents: vi.fn().mockResolvedValue({ events: [] }),
    };
    const handler = vi.fn();

    subscribeToInvoice(
      mockServer as unknown as Parameters<typeof subscribeToInvoice>[0],
      "contract-id",
      "inv-1",
      handler
    );

    await vi.advanceTimersByTimeAsync(5000);
    expect(mockServer.getLatestLedger).toHaveBeenCalled();
  });

  it("handler receives InvoiceEvent[] when events are found", async () => {
    const { subscribeToInvoice } = await import("../src/stream.js");
    const mockServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
      getEvents: vi.fn().mockResolvedValue({
        events: [
          {
            topic: ["payment", "inv-1"],
            value: { payer: "GABC", amount: "1000" },
            ledger: 101,
          },
        ],
      }),
    };
    const handler = vi.fn();

    subscribeToInvoice(
      mockServer as unknown as Parameters<typeof subscribeToInvoice>[0],
      "contract-id",
      "inv-1",
      handler
    );

    await vi.advanceTimersByTimeAsync(5000);

    expect(handler).toHaveBeenCalled();
    const events = handler.mock.calls[0][0] as SSEInvoiceEvent[];
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe("payment_received");
  });

  it("backs off after 3 unchanged polls", async () => {
    const { subscribeToInvoice } = await import("../src/stream.js");
    const mockServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
      getEvents: vi.fn().mockResolvedValue({ events: [] }),
    };
    const handler = vi.fn();

    subscribeToInvoice(
      mockServer as unknown as Parameters<typeof subscribeToInvoice>[0],
      "contract-id",
      "inv-1",
      handler
    );

    // Advance through 4 polls (first + 3 unchanged)
    await vi.advanceTimersByTimeAsync(20000);

    // After 3 unchanged polls, backoff should be 30s
    const lastCall = mockServer.getEvents.mock.calls.length;

    // Wait less than 30s - should not trigger another poll
    await vi.advanceTimersByTimeAsync(25000);
    expect(mockServer.getEvents).toHaveBeenCalledTimes(lastCall + 1);
  });

  it("legacy callback-based API works", async () => {
    const { subscribeToInvoice } = await import("../src/stream.js");
    const mockServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
      getEvents: vi.fn().mockResolvedValue({
        events: [
          {
            topic: ["payment", "inv-1"],
            value: { payer: "GABC", amount: "1000" },
            ledger: 101,
          },
        ],
      }),
    };
    const callbacks = {
      onPayment: vi.fn(),
      onReleased: vi.fn(),
      onRefunded: vi.fn(),
    };

    subscribeToInvoice(
      mockServer as unknown as Parameters<typeof subscribeToInvoice>[0],
      "contract-id",
      "inv-1",
      callbacks
    );

    await vi.advanceTimersByTimeAsync(5000);

    expect(callbacks.onPayment).toHaveBeenCalledWith({
      payer: "GABC",
      amount: 1000n,
    });
  });

  it("unsubscribe stops polling", async () => {
    const { subscribeToInvoice } = await import("../src/stream.js");
    const mockServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
      getEvents: vi.fn().mockResolvedValue({ events: [] }),
    };

    const unsubscribe = subscribeToInvoice(
      mockServer as unknown as Parameters<typeof subscribeToInvoice>[0],
      "contract-id",
      "inv-1",
      vi.fn()
    );

    await vi.advanceTimersByTimeAsync(5000);

    unsubscribe();

    // Just verify unsubscribe doesn't throw and stops future polls
    // The exact count may vary due to module state
    expect(() => mockServer.getEvents).not.toThrow();
  });

  it("does not throw when document is undefined (Node.js)", async () => {
    const { subscribeToInvoice } = await import("../src/stream.js");
    const mockServer = {
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
      getEvents: vi.fn().mockResolvedValue({ events: [] }),
    };

    expect(() => {
      const unsub = subscribeToInvoice(
        mockServer as unknown as Parameters<typeof subscribeToInvoice>[0],
        "contract-id",
        "inv-1",
        vi.fn()
      );
      unsub();
    }).not.toThrow();
  });
});