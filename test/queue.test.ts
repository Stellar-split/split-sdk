/**
 * Unit tests for TxQueue – priority ordering, FIFO tie-breaking, peek(),
 * and the existing zero-priority FIFO contract.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { TxQueue } from "../src/queue.js";
import { QueueFailedError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Mock @stellar/stellar-sdk
// ---------------------------------------------------------------------------

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual("@stellar/stellar-sdk");
  return {
    ...(actual as Record<string, unknown>),
    rpc: {
      Server: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

type MockServer = {
  getAccount: ReturnType<typeof vi.fn>;
};

function makeMockServer(): MockServer {
  return {
    getAccount: vi.fn().mockResolvedValue({
      accountId: () => "GSOURCE",
      sequenceNumber: () => "1",
      incrementSequenceNumber: vi.fn(),
    }),
  };
}

function makeQueue(server: MockServer): TxQueue {
  const { rpc } = require("@stellar/stellar-sdk");
  // Point the constructor to our mock — cast through unknown for DI
  return new TxQueue(
    server as unknown as import("@stellar/stellar-sdk").rpc.Server,
    "Test SDF Network ; September 2015",
    "GSOURCE000000000000000000000000000000000000000000000000000"
  );
}

/** Returns a simple operation that records itself in `order` and resolves. */
function makeOp(id: string, order: string[]) {
  return async (_account: unknown) => {
    order.push(id);
    return { txHash: `tx-${id}`, returnValue: null };
  };
}

// ---------------------------------------------------------------------------
// Zero-priority FIFO contract (existing behaviour preserved)
// ---------------------------------------------------------------------------

describe("TxQueue – zero-priority FIFO", () => {
  it("processes operations in insertion order when all priorities are 0", async () => {
    const server = makeMockServer();
    const queue = makeQueue(server);
    const order: string[] = [];

    const p1 = queue.enqueue(makeOp("first", order));
    const p2 = queue.enqueue(makeOp("second", order));
    const p3 = queue.enqueue(makeOp("third", order));

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(["first", "second", "third"]);
  });

  it("resolves with the correct txHash", async () => {
    const server = makeMockServer();
    const queue = makeQueue(server);
    const result = await queue.enqueue(makeOp("a", []));
    expect(result.txHash).toBe("tx-a");
  });
});

// ---------------------------------------------------------------------------
// Priority ordering
// ---------------------------------------------------------------------------

describe("TxQueue – priority ordering", () => {
  it("processes the highest-priority item first", async () => {
    const server = makeMockServer();
    // Make getAccount block until we release it so all items can be enqueued
    // before processing starts.
    let resolveFirst!: () => void;
    let firstCall = true;
    server.getAccount = vi.fn().mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        // The very first drain iteration will block here until we release it
        return new Promise<void>((r) => { resolveFirst = r; }).then(() => ({
          accountId: () => "GSOURCE",
          sequenceNumber: () => "1",
          incrementSequenceNumber: vi.fn(),
        }));
      }
      return Promise.resolve({
        accountId: () => "GSOURCE",
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      });
    });

    const queue = makeQueue(server);
    const order: string[] = [];

    // Enqueue low-priority first, then high before the first item finishes
    const pLow = queue.enqueue(makeOp("low", order), 1);
    const pHigh = queue.enqueue(makeOp("high", order), 10);
    const pUrgent = queue.enqueue(makeOp("urgent", order), 100);

    // Release the first blocked getAccount so drain can proceed
    resolveFirst();

    await Promise.all([pLow, pHigh, pUrgent]);

    // After the first item ("low" was first in queue but then higher-priority items were added)
    // the drain processes them in priority order: urgent → high → low
    // However "low" was already dequeued and processing when high/urgent arrived.
    // So the real sequence is: low (already running), then urgent, then high.
    // This is the correct priority-queue behaviour: once dequeued, an item runs.
    // Items still waiting are processed in priority order.
    expect(order[0]).toBe("low"); // already dequeued
    expect(order[1]).toBe("urgent");
    expect(order[2]).toBe("high");
  });

  it("FIFO ordering preserved among equal-priority items", async () => {
    const server = makeMockServer();
    const queue = makeQueue(server);
    const order: string[] = [];

    // All at the same non-zero priority
    const p1 = queue.enqueue(makeOp("alpha", order), 5);
    const p2 = queue.enqueue(makeOp("beta", order), 5);
    const p3 = queue.enqueue(makeOp("gamma", order), 5);

    await Promise.all([p1, p2, p3]);
    expect(order).toEqual(["alpha", "beta", "gamma"]);
  });

  it("mixes zero and non-zero priorities correctly", async () => {
    const server = makeMockServer();

    let resolveFirst!: () => void;
    let firstCall = true;
    server.getAccount = vi.fn().mockImplementation(() => {
      if (firstCall) {
        firstCall = false;
        return new Promise<void>((r) => { resolveFirst = r; }).then(() => ({
          accountId: () => "GSOURCE",
          sequenceNumber: () => "1",
          incrementSequenceNumber: vi.fn(),
        }));
      }
      return Promise.resolve({
        accountId: () => "GSOURCE",
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      });
    });

    const queue = makeQueue(server);
    const order: string[] = [];

    const pNormal = queue.enqueue(makeOp("normal", order), 0);
    const pPriority = queue.enqueue(makeOp("priority", order), 50);

    resolveFirst();
    await Promise.all([pNormal, pPriority]);

    // "normal" was already dequeued (first item), then "priority" runs next
    expect(order[0]).toBe("normal");
    expect(order[1]).toBe("priority");
  });
});

// ---------------------------------------------------------------------------
// peek()
// ---------------------------------------------------------------------------

describe("TxQueue – peek()", () => {
  it("returns undefined when the queue is empty", () => {
    const server = makeMockServer();
    const queue = makeQueue(server);
    expect(queue.peek()).toBeUndefined();
  });

  it("reflects the priority of items waiting in the queue", async () => {
    const server = makeMockServer();

    // Capture the resolve function so we can unblock getAccount on demand
    let unblockFirst!: (v: unknown) => void;
    let callCount = 0;
    server.getAccount = vi.fn().mockImplementation(() => {
      callCount++;
      if (callCount === 1) {
        // First call blocks — this holds p1 in flight inside the drain loop
        return new Promise((resolve) => { unblockFirst = resolve; });
      }
      return Promise.resolve({
        accountId: () => "GSOURCE",
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      });
    });

    const queue2 = makeQueue(server);
    const order: string[] = [];

    // p1 enqueued — drain loop starts and blocks on the first getAccount
    const p1 = queue2.enqueue(makeOp("p1", order), 1);

    // Let the drain loop tick so it dequeues p1 and starts awaiting getAccount
    await Promise.resolve();

    // p2 arrives while p1 is in flight — it sits in items[]
    const p2 = queue2.enqueue(makeOp("p2", order), 10);

    // peek() reflects the waiting items (p2), not the in-flight p1
    expect(queue2.peek()).toEqual({ priority: 10 });

    // Unblock p1 and let both complete normally
    unblockFirst({
      accountId: () => "GSOURCE",
      sequenceNumber: () => "1",
      incrementSequenceNumber: vi.fn(),
    });

    await Promise.all([p1, p2]);
    expect(order).toEqual(["p1", "p2"]);
  });

  it("returns undefined after all items have been processed", async () => {
    const server = makeMockServer();
    const queue = makeQueue(server);
    await queue.enqueue(makeOp("x", []));
    // After processing, queue is empty
    expect(queue.peek()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// Failure propagation
// ---------------------------------------------------------------------------

describe("TxQueue – failure propagation", () => {
  it("throws QueueFailedError for new enqueues after a failure", async () => {
    const server = makeMockServer();
    server.getAccount = vi.fn().mockRejectedValue(new Error("rpc down"));

    const queue = makeQueue(server);
    await expect(queue.enqueue(makeOp("fail", []))).rejects.toThrow("rpc down");

    await expect(queue.enqueue(makeOp("after-fail", []))).rejects.toThrow(QueueFailedError);
  });

  it("clear() resets the failed state", async () => {
    const server = makeMockServer();
    server.getAccount = vi.fn()
      .mockRejectedValueOnce(new Error("rpc down"))
      .mockResolvedValue({
        accountId: () => "GSOURCE", sequenceNumber: () => "1", incrementSequenceNumber: vi.fn(),
      });

    const queue = makeQueue(server);
    await expect(queue.enqueue(makeOp("fail", []))).rejects.toThrow("rpc down");

    queue.clear();

    const result = await queue.enqueue(makeOp("recovery", []));
    expect(result.txHash).toBe("tx-recovery");
  });
});
