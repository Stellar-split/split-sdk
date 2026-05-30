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
});
