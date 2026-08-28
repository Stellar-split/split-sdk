import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InvoiceStateBroadcaster, createInvoiceStateBroadcaster } from "../src/broadcaster.js";
import { Invoice } from "../src/types.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("InvoiceStateBroadcaster", () => {
  let broadcaster: InvoiceStateBroadcaster;

  beforeEach(() => {
    broadcaster = new InvoiceStateBroadcaster();
  });

  it("should allow multiple subscribers for same invoice ID", () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    
    const unsubscribe1 = broadcaster.subscribe("123", handler1);
    const unsubscribe2 = broadcaster.subscribe("123", handler2);
    
    // Should have 2 subscribers
    expect(broadcaster.getSubscriberCount("123")).toBe(2);
    
    // Broadcast should call both handlers
    const mockInvoice: Invoice = {
      id: "123",
      creator: "GABC123...",
      recipients: [{ address: "GDEF456...", amount: 1000n }],
      token: "USDC_CONTRACT",
      deadline: 1234567890,
      funded: 0n,
      status: "Pending",
      payments: [],
      recurring: false,
    };
    
    broadcaster.broadcast("123", mockInvoice);
    
    expect(handler1).toHaveBeenCalledWith("123", mockInvoice);
    expect(handler2).toHaveBeenCalledWith("123", mockInvoice);
  });

  it("should return unsubscribe function that removes only that subscriber", () => {
    const handler1 = vi.fn();
    const handler2 = vi.fn();
    
    const unsubscribe1 = broadcaster.subscribe("123", handler1);
    broadcaster.subscribe("123", handler2);
    
    // Unsubscribe first handler
    unsubscribe1();
    
    // Should have 1 subscriber left
    expect(broadcaster.getSubscriberCount("123")).toBe(1);
    
    // Broadcast should only call second handler
    const mockInvoice: Invoice = {
      id: "123",
      creator: "GABC123...",
      recipients: [{ address: "GDEF456...", amount: 1000n }],
      token: "USDC_CONTRACT",
      deadline: 1234567890,
      funded: 0n,
      status: "Pending",
      payments: [],
      recurring: false,
    };
    
    broadcaster.broadcast("123", mockInvoice);
    
    expect(handler1).not.toHaveBeenCalled();
    expect(handler2).toHaveBeenCalled();
  });

  it("should be a no-op when no subscribers for that ID", () => {
    // No subscribers for "456"
    const mockInvoice: Invoice = {
      id: "456",
      creator: "GABC123...",
      recipients: [{ address: "GDEF456...", amount: 1000n }],
      token: "USDC_CONTRACT",
      deadline: 1234567890,
      funded: 0n,
      status: "Pending",
      payments: [],
      recurring: false,
    };
    
    // This should not throw an error
    expect(() => broadcaster.broadcast("456", mockInvoice)).not.toThrow();
  });

  it("should export createInvoiceStateBroadcaster function", () => {
    expect(createInvoiceStateBroadcaster).toBeDefined();
  });

  // ---------------------------------------------------------------------------
  // Message ordering tests
  // ---------------------------------------------------------------------------

  it("delivers three messages to a subscriber in the order they were broadcast", () => {
    const received: Invoice[] = [];
    broadcaster.subscribe("order-test", (_, invoice) => {
      received.push(invoice);
    });

    const makeInvoice = (id: string): Invoice => ({
      id,
      creator: "GABC123...",
      recipients: [{ address: "GDEF456...", amount: 1000n }],
      token: "USDC_CONTRACT",
      deadline: 1234567890,
      funded: 0n,
      status: "Pending",
      payments: [],
      recurring: false,
    });

    const inv1 = makeInvoice("1");
    const inv2 = makeInvoice("2");
    const inv3 = makeInvoice("3");

    broadcaster.broadcast("order-test", inv1);
    broadcaster.broadcast("order-test", inv2);
    broadcaster.broadcast("order-test", inv3);

    expect(received).toHaveLength(3);
    expect(received[0].id).toBe("1");
    expect(received[1].id).toBe("2");
    expect(received[2].id).toBe("3");
  });

  it("a subscriber added after some broadcasts does not receive missed messages", () => {
    const lateReceived: Invoice[] = [];

    const makeInvoice = (id: string): Invoice => ({
      id,
      creator: "GABC123...",
      recipients: [{ address: "GDEF456...", amount: 1000n }],
      token: "USDC_CONTRACT",
      deadline: 1234567890,
      funded: 0n,
      status: "Pending",
      payments: [],
      recurring: false,
    });

    // Broadcast first message BEFORE the late subscriber joins
    broadcaster.broadcast("late-test", makeInvoice("early"));

    // Late subscriber registers after the first broadcast
    broadcaster.subscribe("late-test", (_, invoice) => {
      lateReceived.push(invoice);
    });

    // Broadcast a second message AFTER the late subscriber joins
    broadcaster.broadcast("late-test", makeInvoice("late"));

    // Late subscriber must only receive the message sent after it joined
    expect(lateReceived).toHaveLength(1);
    expect(lateReceived[0].id).toBe("late");
  });

  it("removing a subscriber mid-sequence stops delivery for subsequent messages only", () => {
    const received: string[] = [];

    const makeInvoice = (id: string): Invoice => ({
      id,
      creator: "GABC123...",
      recipients: [{ address: "GDEF456...", amount: 1000n }],
      token: "USDC_CONTRACT",
      deadline: 1234567890,
      funded: 0n,
      status: "Pending",
      payments: [],
      recurring: false,
    });

    const unsubscribe = broadcaster.subscribe("mid-unsub-test", (_, invoice) => {
      received.push(invoice.id);
    });

    // First message — subscriber is still active
    broadcaster.broadcast("mid-unsub-test", makeInvoice("msg1"));

    // Unsubscribe between broadcasts
    unsubscribe();

    // Second message — subscriber has been removed
    broadcaster.broadcast("mid-unsub-test", makeInvoice("msg2"));

    // Third message — subscriber has been removed
    broadcaster.broadcast("mid-unsub-test", makeInvoice("msg3"));

    // Only the first message should have been received
    expect(received).toEqual(["msg1"]);
  });
});
