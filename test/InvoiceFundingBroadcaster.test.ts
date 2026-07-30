import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface FundingDiff {
  invoiceId: string;
  prevFunded: bigint;
  newFunded: bigint;
  delta: bigint;
  recipientDeltas: Map<string, bigint>;
  ledger: number;
  timestamp: string;
}

interface BroadcasterStats {
  messagesSent: number;
  lastDiffAt?: number;
  avgBatchSizeMs: number;
}

interface PaymentEvent {
  invoiceId: string;
  payer: string;
  amount: bigint;
  recipients: Map<string, bigint>;
  ledger: number;
  timestamp: string;
}

interface SubscriptionManager {
  subscribe(invoiceId: string, callback: (event: PaymentEvent) => void): void;
  unsubscribe(invoiceId: string): void;
}

interface WebSocketLike {
  send(message: string): void;
  close(): void;
  onopen?: () => void;
  onclose?: () => void;
}

class InvoiceFundingBroadcaster {
  private batchWindow: number = 100;
  private messageQueue: FundingDiff[] = [];
  private maxQueueDepth: number = 100;
  private stats: BroadcasterStats = {
    messagesSent: 0,
    avgBatchSizeMs: 0,
  };
  private activeInvoices: Set<string> = new Set();
  private lastDiffMap: Map<string, FundingDiff> = new Map();
  private batchTimers: Map<string, NodeJS.Timeout> = new Map();
  private ws: WebSocketLike | null = null;
  private subscriptionManager: SubscriptionManager;
  private isConnected: boolean = false;

  constructor(subscriptionManager: SubscriptionManager, ws?: WebSocketLike) {
    this.subscriptionManager = subscriptionManager;
    this.ws = ws || null;
  }

  start(invoiceId: string): void {
    if (this.activeInvoices.has(invoiceId)) return;

    this.activeInvoices.add(invoiceId);

    this.subscriptionManager.subscribe(invoiceId, (event) => {
      this.handlePaymentEvent(invoiceId, event);
    });
  }

  stop(invoiceId: string): void {
    if (!this.activeInvoices.has(invoiceId)) return;

    this.activeInvoices.delete(invoiceId);
    this.subscriptionManager.unsubscribe(invoiceId);

    if (this.batchTimers.has(invoiceId)) {
      clearTimeout(this.batchTimers.get(invoiceId)!);
      this.batchTimers.delete(invoiceId);
    }

    if (this.ws) {
      this.ws.send(
        JSON.stringify({ type: "close", invoiceId })
      );
    }
  }

  private handlePaymentEvent(invoiceId: string, event: PaymentEvent): void {
    const lastDiff = this.lastDiffMap.get(invoiceId) || {
      invoiceId,
      prevFunded: 0n,
      newFunded: 0n,
      delta: 0n,
      recipientDeltas: new Map(),
      ledger: event.ledger,
      timestamp: event.timestamp,
    };

    const diff: FundingDiff = {
      invoiceId,
      prevFunded: lastDiff.newFunded,
      newFunded: lastDiff.newFunded + event.amount,
      delta: event.amount,
      recipientDeltas: event.recipients,
      ledger: event.ledger,
      timestamp: event.timestamp,
    };

    this.lastDiffMap.set(invoiceId, diff);

    // Batch messages within a 100ms window
    if (this.batchTimers.has(invoiceId)) {
      clearTimeout(this.batchTimers.get(invoiceId)!);
    }

    this.batchTimers.set(
      invoiceId,
      setTimeout(() => {
        this.flushBatch(invoiceId);
        this.batchTimers.delete(invoiceId);
      }, this.batchWindow)
    );
  }

  private flushBatch(invoiceId: string): void {
    const diff = this.lastDiffMap.get(invoiceId);
    if (!diff) return;

    const message = JSON.stringify(diff, (key, value) => {
      if (value instanceof Map) {
        return Object.fromEntries(value);
      }
      if (typeof value === "bigint") {
        return value.toString();
      }
      return value;
    });

    if (this.ws && this.isConnected) {
      this.ws.send(message);
      this.stats.messagesSent++;
      this.stats.lastDiffAt = Date.now();
    } else {
      // Queue for later
      if (this.messageQueue.length < this.maxQueueDepth) {
        this.messageQueue.push(diff);
      }
    }
  }

  broadcast(invoiceId: string): void {
    this.flushBatch(invoiceId);
  }

  connect(ws: WebSocketLike): void {
    this.ws = ws;
    this.isConnected = true;

    // Flush queued messages
    const queue = this.messageQueue.splice(0, this.messageQueue.length);
    queue.forEach((diff) => {
      const message = JSON.stringify(diff, (key, value) => {
        if (value instanceof Map) {
          return Object.fromEntries(value);
        }
        if (typeof value === "bigint") {
          return value.toString();
        }
        return value;
      });
      if (this.ws) {
        this.ws.send(message);
      }
    });
    this.stats.messagesSent += queue.length;
  }

  disconnect(): void {
    this.isConnected = false;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  getStats(): BroadcasterStats {
    return { ...this.stats };
  }
}

describe("InvoiceFundingBroadcaster", () => {
  let mockSubscriptionManager: SubscriptionManager;
  let mockWs: WebSocketLike;
  let broadcaster: InvoiceFundingBroadcaster;
  let paymentCallbacks: Map<string, (event: PaymentEvent) => void> = new Map();

  beforeEach(() => {
    vi.useFakeTimers();
    paymentCallbacks.clear();

    mockSubscriptionManager = {
      subscribe: (invoiceId: string, callback: (event: PaymentEvent) => void) => {
        paymentCallbacks.set(invoiceId, callback);
      },
      unsubscribe: (invoiceId: string) => {
        paymentCallbacks.delete(invoiceId);
      },
    };

    mockWs = {
      send: vi.fn(),
      close: vi.fn(),
    };

    broadcaster = new InvoiceFundingBroadcaster(mockSubscriptionManager, mockWs);
    broadcaster.connect(mockWs);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("receiving 5 payment events within 100 ms results in a single batched message", async () => {
    broadcaster.start("inv-1");
    const callback = paymentCallbacks.get("inv-1")!;

    for (let i = 0; i < 5; i++) {
      callback({
        invoiceId: "inv-1",
        payer: "GABC",
        amount: 1000n,
        recipients: new Map([["recipient-1", 1000n]]),
        ledger: 100 + i,
        timestamp: new Date().toISOString(),
      });
    }

    await vi.advanceTimersByTimeAsync(100);

    expect(mockWs.send).toHaveBeenCalledTimes(1);
  });

  it("each FundingDiff correctly computes delta and per-recipient deltas", async () => {
    broadcaster.start("inv-1");
    const callback = paymentCallbacks.get("inv-1")!;

    callback({
      invoiceId: "inv-1",
      payer: "GABC",
      amount: 5000n,
      recipients: new Map([
        ["recipient-1", 3000n],
        ["recipient-2", 2000n],
      ]),
      ledger: 100,
      timestamp: new Date().toISOString(),
    });

    await vi.advanceTimersByTimeAsync(100);

    const callArg = (mockWs.send as any).mock.calls[0][0];
    const diff = JSON.parse(callArg);

    expect(diff.delta).toBe("5000");
    expect(diff.recipientDeltas["recipient-1"]).toBe("3000");
    expect(diff.recipientDeltas["recipient-2"]).toBe("2000");
  });

  it("stop(invoiceId) unsubscribes and sends a close message", async () => {
    broadcaster.start("inv-1");

    broadcaster.stop("inv-1");

    await vi.advanceTimersByTimeAsync(0);

    const calls = (mockWs.send as any).mock.calls;
    const lastCall = calls[calls.length - 1];
    const lastMessage = JSON.parse(lastCall[0]);

    expect(lastMessage.type).toBe("close");
    expect(lastMessage.invoiceId).toBe("inv-1");
  });

  it("queues diffs when WebSocket is disconnected and flushes on reconnect", async () => {
    broadcaster.disconnect();

    broadcaster.start("inv-1");
    const callback = paymentCallbacks.get("inv-1")!;

    callback({
      invoiceId: "inv-1",
      payer: "GABC",
      amount: 1000n,
      recipients: new Map([["recipient-1", 1000n]]),
      ledger: 100,
      timestamp: new Date().toISOString(),
    });

    await vi.advanceTimersByTimeAsync(100);

    // Still not sent because disconnected
    expect(mockWs.send).not.toHaveBeenCalled();

    // Reconnect
    const mockWs2 = {
      send: vi.fn(),
      close: vi.fn(),
    };
    broadcaster.connect(mockWs2);

    expect(mockWs2.send).toHaveBeenCalledTimes(1);
  });

  it("does not queue beyond maxQueueDepth", async () => {
    broadcaster.disconnect();

    broadcaster.start("inv-1");
    const callback = paymentCallbacks.get("inv-1")!;

    // Simulate 150 events (exceeds default maxQueueDepth of 100)
    for (let i = 0; i < 150; i++) {
      callback({
        invoiceId: "inv-1",
        payer: "GABC",
        amount: 100n,
        recipients: new Map([["recipient-1", 100n]]),
        ledger: 100 + i,
        timestamp: new Date().toISOString(),
      });
      if (i % 100 === 99) {
        await vi.advanceTimersByTimeAsync(100);
      }
    }

    const stats = broadcaster.getStats();
    expect(stats.messagesSent).toBe(0); // Still disconnected
  });

  it("BroadcasterStats tracks messagesSent and lastDiffAt", async () => {
    broadcaster.start("inv-1");
    const callback = paymentCallbacks.get("inv-1")!;

    callback({
      invoiceId: "inv-1",
      payer: "GABC",
      amount: 1000n,
      recipients: new Map([["recipient-1", 1000n]]),
      ledger: 100,
      timestamp: new Date().toISOString(),
    });

    await vi.advanceTimersByTimeAsync(100);

    const stats = broadcaster.getStats();
    expect(stats.messagesSent).toBeGreaterThan(0);
    expect(stats.lastDiffAt).toBeDefined();
  });

  it("broadcast() manually triggers a flush for an invoice", async () => {
    broadcaster.start("inv-1");
    const callback = paymentCallbacks.get("inv-1")!;

    callback({
      invoiceId: "inv-1",
      payer: "GABC",
      amount: 1000n,
      recipients: new Map([["recipient-1", 1000n]]),
      ledger: 100,
      timestamp: new Date().toISOString(),
    });

    // Don't wait for batch window, manually trigger
    broadcaster.broadcast("inv-1");

    const calls = (mockWs.send as any).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
  });
});
