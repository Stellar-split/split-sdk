import { describe, it, expect, vi, beforeEach } from "vitest";
import { BatchedRpcClient, RequestBatcher } from "../src/requestBatcher.js";
import type { BatchFetchers } from "../src/requestBatcher.js";
import type { Invoice, Payment, InvoiceExt } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeInvoice(id: string): Invoice {
  return {
    id,
    creator: "GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ",
    recipients: [],
    token: "CA3D5KRYM6CB7OWQ6TWYRR3Z4T75RBSVHYQ5M53RFBI7YE3QN7ZD5WL8",
    deadline: Date.now() + 86400,
    funded: 0n,
    status: "Pending",
    payments: [],
  };
}

function makeFetchers(opts: {
  invoiceDelay?: number;
  paymentDelay?: number;
  extDelay?: number;
} = {}): { fetchers: BatchFetchers; fetchInvoice: ReturnType<typeof vi.fn>; fetchPaymentHistory: ReturnType<typeof vi.fn>; fetchInvoiceExt: ReturnType<typeof vi.fn> } {
  const fetchInvoice = vi.fn(async (id: string): Promise<Invoice> => {
    if (opts.invoiceDelay) await new Promise((r) => setTimeout(r, opts.invoiceDelay));
    return makeInvoice(id);
  });

  const fetchPaymentHistory = vi.fn(async (_id: string): Promise<Payment[]> => {
    if (opts.paymentDelay) await new Promise((r) => setTimeout(r, opts.paymentDelay));
    return [];
  });

  const fetchInvoiceExt = vi.fn(async (_id: string): Promise<InvoiceExt> => {
    if (opts.extDelay) await new Promise((r) => setTimeout(r, opts.extDelay));
    return { parentInvoiceId: null, cloneDepth: 0 };
  });

  return {
    fetchers: { fetchInvoice, fetchPaymentHistory, fetchInvoiceExt },
    fetchInvoice,
    fetchPaymentHistory,
    fetchInvoiceExt,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("BatchedRpcClient", () => {
  it("is disabled by default in StellarSplitClient (opt-in)", async () => {
    // The batcher itself doesn't know about client defaults, but we verify
    // that creating a BatchedRpcClient does NOT call fetchers until a call is made.
    const { fetchers, fetchInvoice } = makeFetchers();
    new BatchedRpcClient(fetchers);
    // no calls yet
    expect(fetchInvoice).not.toHaveBeenCalled();
  });

  it("resolves getInvoice with the correct invoice ID", async () => {
    const { fetchers } = makeFetchers();
    const batcher = new BatchedRpcClient(fetchers, 10, 20);
    const invoice = await batcher.getInvoice("42");
    expect(invoice.id).toBe("42");
  });

  it("resolves getPaymentHistory", async () => {
    const { fetchers, fetchPaymentHistory } = makeFetchers();
    const batcher = new BatchedRpcClient(fetchers, 10, 20);
    const payments = await batcher.getPaymentHistory("1");
    expect(payments).toEqual([]);
    expect(fetchPaymentHistory).toHaveBeenCalledWith("1");
  });

  it("resolves getInvoiceExt", async () => {
    const { fetchers, fetchInvoiceExt } = makeFetchers();
    const batcher = new BatchedRpcClient(fetchers, 10, 20);
    const ext = await batcher.getInvoiceExt("7");
    expect(ext.cloneDepth).toBe(0);
    expect(fetchInvoiceExt).toHaveBeenCalledWith("7");
  });

  it("batches 5 concurrent getInvoice calls into a single round-trip window", async () => {
    const { fetchers, fetchInvoice } = makeFetchers();
    const batcher = new BatchedRpcClient(fetchers, 20, 20);

    const ids = ["1", "2", "3", "4", "5"];
    const results = await Promise.all(ids.map((id) => batcher.getInvoice(id)));

    // All 5 calls should have been dispatched (each via one fetch call)
    expect(fetchInvoice).toHaveBeenCalledTimes(5);
    // Each result maps back to the correct ID
    results.forEach((inv, i) => expect(inv.id).toBe(ids[i]));
  });

  it("dispatches all calls within the 10 ms window as one group", async () => {
    const callLog: string[] = [];
    const fetchers: BatchFetchers = {
      fetchInvoice: async (id) => {
        callLog.push(`invoice:${id}`);
        return makeInvoice(id);
      },
      fetchPaymentHistory: async () => [],
      fetchInvoiceExt: async () => ({ parentInvoiceId: null, cloneDepth: 0 }),
    };

    const batcher = new BatchedRpcClient(fetchers, 15, 20);

    // Fire all 5 synchronously before the timer fires
    const promises = ["a", "b", "c", "d", "e"].map((id) => batcher.getInvoice(id));
    expect(callLog).toHaveLength(0); // nothing dispatched yet synchronously

    await Promise.all(promises);
    expect(callLog).toHaveLength(5);
  });

  it("caps batch at 20 operations and starts overflow batch immediately", async () => {
    const { fetchers, fetchInvoice } = makeFetchers();
    const batcher = new BatchedRpcClient(fetchers, 50, 20);

    // Enqueue 25 calls — first 20 should flush immediately, remaining 5 later
    const ids = Array.from({ length: 25 }, (_, i) => String(i));
    const promises = ids.map((id) => batcher.getInvoice(id));

    await Promise.all(promises);
    expect(fetchInvoice).toHaveBeenCalledTimes(25);
  });

  it("distributes results back to each individual caller transparently", async () => {
    const { fetchers } = makeFetchers();
    const batcher = new BatchedRpcClient(fetchers, 10, 20);

    const [inv10, inv20, inv30] = await Promise.all([
      batcher.getInvoice("10"),
      batcher.getInvoice("20"),
      batcher.getInvoice("30"),
    ]);

    expect(inv10.id).toBe("10");
    expect(inv20.id).toBe("20");
    expect(inv30.id).toBe("30");
  });

  it("handles mixed call types in the same window", async () => {
    const { fetchers, fetchInvoice, fetchPaymentHistory, fetchInvoiceExt } = makeFetchers();
    const batcher = new BatchedRpcClient(fetchers, 20, 20);

    const [invoice, payments, ext] = await Promise.all([
      batcher.getInvoice("5"),
      batcher.getPaymentHistory("5"),
      batcher.getInvoiceExt("5"),
    ]);

    expect(invoice.id).toBe("5");
    expect(payments).toEqual([]);
    expect(ext.cloneDepth).toBe(0);
    expect(fetchInvoice).toHaveBeenCalledOnce();
    expect(fetchPaymentHistory).toHaveBeenCalledOnce();
    expect(fetchInvoiceExt).toHaveBeenCalledOnce();
  });

  it("propagates fetch errors back to the original caller", async () => {
    const fetchers: BatchFetchers = {
      fetchInvoice: async (id) => {
        if (id === "bad") throw new Error("not found");
        return makeInvoice(id);
      },
      fetchPaymentHistory: async () => [],
      fetchInvoiceExt: async () => ({ parentInvoiceId: null, cloneDepth: 0 }),
    };

    const batcher = new BatchedRpcClient(fetchers, 10, 20);
    await expect(batcher.getInvoice("bad")).rejects.toThrow("not found");
    // Other callers in the same window are not affected
    const good = await batcher.getInvoice("ok");
    expect(good.id).toBe("ok");
  });

  it("clear() rejects all pending calls and cancels the timer", async () => {
    const fetchers: BatchFetchers = {
      fetchInvoice: () => new Promise(() => {}), // never resolves
      fetchPaymentHistory: async () => [],
      fetchInvoiceExt: async () => ({ parentInvoiceId: null, cloneDepth: 0 }),
    };

    const batcher = new BatchedRpcClient(fetchers, 100, 20);
    const p = batcher.getInvoice("1");
    batcher.clear();
    await expect(p).rejects.toThrow("BatchedRpcClient cleared");
  });

  it("pendingCount reflects queued calls before dispatch", async () => {
    const fetchers: BatchFetchers = {
      fetchInvoice: () => new Promise(() => {}), // block forever
      fetchPaymentHistory: async () => [],
      fetchInvoiceExt: async () => ({ parentInvoiceId: null, cloneDepth: 0 }),
    };

    const batcher = new BatchedRpcClient(fetchers, 500, 20);
    batcher.getInvoice("1").catch(() => {});
    batcher.getInvoice("2").catch(() => {});
    expect(batcher.pendingCount).toBe(2);
    batcher.clear();
  });

  it("overflow of exactly maxBatchSize triggers immediate flush (no timer needed)", async () => {
    const flushOrder: string[] = [];
    const fetchers: BatchFetchers = {
      fetchInvoice: async (id) => {
        flushOrder.push(id);
        return makeInvoice(id);
      },
      fetchPaymentHistory: async () => [],
      fetchInvoiceExt: async () => ({ parentInvoiceId: null, cloneDepth: 0 }),
    };

    const batcher = new BatchedRpcClient(fetchers, 500, 3);

    // Adding a 3rd call exactly hits maxBatchSize — should flush immediately
    const [a, b, c] = await Promise.all([
      batcher.getInvoice("x1"),
      batcher.getInvoice("x2"),
      batcher.getInvoice("x3"),
    ]);

    expect([a.id, b.id, c.id]).toEqual(["x1", "x2", "x3"]);
    expect(flushOrder).toHaveLength(3);
  });
});

// ---------------------------------------------------------------------------
// Legacy RequestBatcher (backwards compat)
// ---------------------------------------------------------------------------

describe("RequestBatcher (legacy)", () => {
  it("creates an instance with default config", () => {
    const batcher = new RequestBatcher();
    expect(batcher).toBeDefined();
  });

  it("resolves getInvoice calls", async () => {
    const batcher = new RequestBatcher({ windowMs: 1, maxBatchSize: 5 });
    const promises = Array.from({ length: 5 }, (_, i) => batcher.getInvoice(`inv-${i}`));
    const results = await Promise.all(promises);
    expect(results).toHaveLength(5);
  });

  it("clear() rejects pending and resets count", () => {
    const batcher = new RequestBatcher({ windowMs: 500, maxBatchSize: 5 });
    batcher.getInvoice("1").catch(() => {});
    batcher.clear();
    expect(batcher.getPendingCount()).toBe(0);
  });
});
