import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { MockRpcClient } from "../src/testing/mockRpcClient.js";
import { createInvoiceSubscription, _resetActiveSubscriptionsForTesting } from "../src/subscription.js";
import type { InvoiceEvent, Subscription } from "../src/types.js";

// Mock events returned by the RPC server
const mockEvents = [
  {
    topic: ["payment", "inv-123"],
    value: { payer: "GABC", amount: "1000" },
    ledger: 100,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    topic: ["released", "inv-123"],
    value: { releasedBy: "GXYZ" },
    ledger: 101,
    createdAt: "2026-01-01T00:00:01.000Z",
  },
  {
    topic: ["refunded", "inv-123"],
    value: { refundedBy: "GABC" },
    ledger: 102,
    createdAt: "2026-01-01T00:00:02.000Z",
  },
];

// Mock events with duplicate ledger/topic combination
const mockEventsWithDuplicates = [
  {
    topic: ["payment", "inv-456"],
    value: { payer: "GDEF", amount: "2000" },
    ledger: 200,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    topic: ["payment", "inv-456"],
    value: { payer: "GDEF", amount: "2000" },
    ledger: 200,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
  {
    topic: ["payment", "inv-456"],
    value: { payer: "GDEF", amount: "2000" },
    ledger: 200,
    createdAt: "2026-01-01T00:00:00.000Z",
  },
];

describe("Invoice Event Subscription (Issue #417)", () => {
  beforeEach(() => {
    _resetActiveSubscriptionsForTesting();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("should create subscription and handle normal event stream", async () => {
    const mockServer = new MockRpcClient({
      defaultGetEventsResponse: { events: mockEvents, latestLedger: 105 },
      defaultGetLatestLedgerResponse: { id: "mock", sequence: 100, protocolVersion: 21 },
    });
    const events: InvoiceEvent[] = [];

    const subscription = createInvoiceSubscription(
      mockServer as unknown as Parameters<typeof createInvoiceSubscription>[0],
      "contract-id",
      "inv-123",
      (event) => events.push(event),
      { pollIntervalMs: 100 }
    );

    expect(subscription.getInvoiceId()).toBe("inv-123");
    expect(subscription.isActive()).toBe(true);
    expect(subscription.isPaused()).toBe(false);

    await vi.advanceTimersByTimeAsync(0);

    expect(mockServer.calls.getEvents.length).toBe(1);
    expect(events.length).toBe(3);

    expect(events[0].type).toBe("payment");
    expect(events[0].payer).toBe("GABC");
    expect(events[0].amount).toBe(1000n);

    expect(events[1].type).toBe("released");
    expect(events[1].releasedBy).toBe("GXYZ");

    expect(events[2].type).toBe("refunded");
    expect(events[2].refundedTo).toBe("GABC");

    subscription.unsubscribe();
    await vi.advanceTimersByTimeAsync(100);

    expect(subscription.isActive()).toBe(false);
  });

  it("should deduplicate events by ledger sequence + topic hash", async () => {
    const mockServer = new MockRpcClient({
      defaultGetEventsResponse: { events: mockEventsWithDuplicates, latestLedger: 205 },
      defaultGetLatestLedgerResponse: { id: "mock", sequence: 200, protocolVersion: 21 },
    });
    const events: InvoiceEvent[] = [];

    const subscription = createInvoiceSubscription(
      mockServer as unknown as Parameters<typeof createInvoiceSubscription>[0],
      "contract-id",
      "inv-456",
      (event) => events.push(event),
      { pollIntervalMs: 100 }
    );

    await vi.advanceTimersByTimeAsync(0);

    expect(events.length).toBe(1);
    expect(events[0].type).toBe("payment");
    expect(events[0].payer).toBe("GDEF");

    subscription.unsubscribe();
  });

  it("should reconnect with exponential backoff after failure", async () => {
    const mockServer = new MockRpcClient({
      defaultGetEventsResponse: { events: [], latestLedger: 105 },
      defaultGetLatestLedgerResponse: { id: "mock", sequence: 100, protocolVersion: 21 },
    });

    const events: InvoiceEvent[] = [];
    const lifecycleEvents: any[] = [];

    vi.spyOn(mockServer, "getEvents").mockRejectedValueOnce(new Error("RPC connection failed"));

    const subscription = createInvoiceSubscription(
      mockServer as unknown as Parameters<typeof createInvoiceSubscription>[0],
      "contract-id",
      "inv-123",
      (event) => events.push(event),
      {
        pollIntervalMs: 100,
        initialBackoffMs: 200,
        maxBackoffMs: 1000,
        onLifecycleEvent: (e) => lifecycleEvents.push(e),
      }
    );

    // Let the initial poll reject
    await vi.waitFor(() => {
      expect(lifecycleEvents.some((e) => e.type === "reconnect")).toBe(true);
    });

    // Reconnect timer fires at initialBackoffMs (200ms)
    await vi.advanceTimersByTimeAsync(200);

    await vi.waitFor(() => {
      expect(mockServer.calls.getEvents.length).toBe(2);
    });

    subscription.unsubscribe();
  });

  it("should stop polling after unsubscribe", async () => {
    const mockServer = new MockRpcClient({
      defaultGetEventsResponse: { events: [], latestLedger: 100 },
      defaultGetLatestLedgerResponse: { id: "mock", sequence: 100, protocolVersion: 21 },
    });

    const subscription = createInvoiceSubscription(
      mockServer as unknown as Parameters<typeof createInvoiceSubscription>[0],
      "contract-id",
      "inv-789",
      vi.fn(),
      { pollIntervalMs: 100 }
    );

    await vi.advanceTimersByTimeAsync(0);
    const pollCountBefore = mockServer.calls.getEvents.length;

    subscription.unsubscribe();

    await vi.advanceTimersByTimeAsync(100);

    expect(mockServer.calls.getEvents.length).toBe(pollCountBefore);
    expect(subscription.isActive()).toBe(false);
  });

  it("should pause and resume subscription", async () => {
    const mockServer = new MockRpcClient({
      defaultGetEventsResponse: { events: mockEvents, latestLedger: 105 },
      defaultGetLatestLedgerResponse: { id: "mock", sequence: 100, protocolVersion: 21 },
    });
    const events: InvoiceEvent[] = [];

    const subscription = createInvoiceSubscription(
      mockServer as unknown as Parameters<typeof createInvoiceSubscription>[0],
      "contract-id",
      "inv-123",
      (event) => events.push(event),
      { pollIntervalMs: 100 }
    );

    await vi.advanceTimersByTimeAsync(0);
    expect(events.length).toBe(3);

    subscription.pause();
    expect(subscription.isPaused()).toBe(true);

    events.length = 0;
    await vi.advanceTimersByTimeAsync(200);

    expect(events.length).toBe(0);

    subscription.resume();
    await vi.advanceTimersByTimeAsync(0);

    expect(subscription.isPaused()).toBe(false);

    subscription.unsubscribe();
  });

  it("should respect subscription limits (max concurrent)", async () => {
    const mockServer = new MockRpcClient({
      defaultGetEventsResponse: { events: mockEvents, latestLedger: 105 },
      defaultGetLatestLedgerResponse: { id: "mock", sequence: 100, protocolVersion: 21 },
    });

    const subscriptions: Subscription[] = [];

    for (let i = 0; i < 12; i++) {
      const sub = createInvoiceSubscription(
        mockServer as unknown as Parameters<typeof createInvoiceSubscription>[0],
        "contract-id",
        `inv-limit-${i}`,
        vi.fn(),
        { pollIntervalMs: 100 }
      );
      subscriptions.push(sub);
    }

    expect(subscriptions.filter((s) => s.isActive()).length).toBe(10);

    subscriptions.forEach((sub) => sub.unsubscribe());
  });

  it("should emit lifecycle events (error, reconnect, close)", async () => {
    const mockServer = new MockRpcClient({
      defaultGetEventsResponse: { events: mockEvents, latestLedger: 105 },
      defaultGetLatestLedgerResponse: { id: "mock", sequence: 100, protocolVersion: 21 },
    });
    const lifecycleEvents: any[] = [];

    vi.spyOn(mockServer, "getEvents").mockRejectedValueOnce(new Error("Network glitch"));

    const subscription = createInvoiceSubscription(
      mockServer as unknown as Parameters<typeof createInvoiceSubscription>[0],
      "contract-id",
      "inv-lifecycle",
      vi.fn(),
      {
        pollIntervalMs: 100,
        maxRetries: 2,
        initialBackoffMs: 100,
        maxBackoffMs: 200,
        onLifecycleEvent: (event) => lifecycleEvents.push(event),
      }
    );

    await vi.waitFor(() => {
      expect(lifecycleEvents.some((e) => e.type === "reconnect")).toBe(true);
    });

    subscription.unsubscribe();
    await vi.advanceTimersByTimeAsync(100);

    expect(lifecycleEvents.some((e) => e.type === "close")).toBe(true);
  });
});