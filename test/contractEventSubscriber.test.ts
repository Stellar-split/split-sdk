/**
 * Unit tests for #544 — ContractEventSubscriber
 *
 * Mocks SorobanRpc.Server.getEvents() across three poll cycles to verify
 * that only new events (no duplicates) are yielded.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { ContractEventSubscriber } from "../src/contractEventSubscriber.js";
import type { CursorStore } from "../src/types.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

function makeEvent(id: string, ledger: number, contractId: string) {
  return {
    id,
    ledger,
    contractId,
    topic: ["payment"],
    value: { amount: "100" },
    pagingToken: `${ledger}-${id}`,
  };
}

describe("ContractEventSubscriber", () => {
  let mockStore: CursorStore;
  let mockServer: {
    getEvents: ReturnType<typeof vi.fn>;
  };
  let subscriber: ContractEventSubscriber;

  beforeEach(() => {
    vi.clearAllMocks();

    // In-memory cursor store
    const storeMap = new Map<string, string>();
    mockStore = {
      async save(key: string, cursor: string) {
        storeMap.set(key, cursor);
      },
      async load(key: string) {
        return storeMap.get(key) ?? null;
      },
      async delete(key: string) {
        storeMap.delete(key);
      },
    };

    mockServer = {
      getEvents: vi.fn(),
    };
  });

  it("yields new events across three poll cycles without duplicates", async () => {
    const contractId = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";

    // Cycle 1: events at ledger 10, 11
    mockServer.getEvents
      .mockResolvedValueOnce({
        events: [
          makeEvent("ev1", 10, contractId),
          makeEvent("ev2", 11, contractId),
        ],
      })
      // Cycle 2: repeat ledger 11 (duplicate) + new event at ledger 12
      .mockResolvedValueOnce({
        events: [
          makeEvent("ev2", 11, contractId),
          makeEvent("ev3", 12, contractId),
        ],
      })
      // Cycle 3: no new events
      .mockResolvedValueOnce({
        events: [],
      });

    subscriber = new ContractEventSubscriber({
      server: mockServer as never,
      pollIntervalMs: 10,
      startLedger: 0,
      cursorStore: mockStore,
      cursorNamespace: "test",
    });

    const yielded: string[] = [];
    let pollCount = 0;

    const subscription = subscriber.subscribe(contractId, { contractIds: [contractId] });

    for await (const event of subscription) {
      yielded.push(event.id);
      pollCount++;
      if (pollCount >= 3) {
        subscriber.unsubscribe();
        break;
      }
    }

    // Should see: ev1 (ledger 10), ev2 (ledger 11), ev3 (ledger 12)
    // The duplicate "ev2" in cycle 2 is filtered out
    expect(yielded).toEqual(["ev1", "ev2", "ev3"]);
  });

  it("persists the last-processed ledger cursor after each poll", async () => {
    const contractId = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";

    mockServer.getEvents
      .mockResolvedValueOnce({
        events: [makeEvent("ev1", 50, contractId)],
      })
      // Second poll returns empty — this poll cycle saves the cursor then exits
      .mockResolvedValueOnce({
        events: [],
      });

    subscriber = new ContractEventSubscriber({
      server: mockServer as never,
      pollIntervalMs: 10,
      startLedger: 0,
      cursorStore: mockStore,
      cursorNamespace: "test",
    });

    // Collect events; after getting ev1 we keep the loop running one more cycle
    // (the second empty poll) so that the cursor is saved, then stop.
    let count = 0;
    const gen = subscriber.subscribe(contractId, { contractIds: [contractId] });
    for await (const event of gen) {
      expect(event.id).toBe("ev1");
      count++;
      // Don't unsubscribe yet — let the loop continue to the next iteration
      // where it will save the cursor and then we stop.
      if (count >= 1) {
        // Schedule unsubscribe after a tick so the cursor save runs first
        setTimeout(() => subscriber.unsubscribe(), 5);
      }
    }

    // The cursor should have been saved as "50"
    const saved = await mockStore.load("test:CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K");
    expect(saved).toBe("50");
  }, 10_000);

  it("resumes from the persisted cursor on restart", async () => {
    const contractId = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";

    // Persist cursor at ledger 100
    await mockStore.save("test:" + contractId, "100");

    mockServer.getEvents.mockResolvedValueOnce({
      events: [makeEvent("ev1", 101, contractId)],
    });

    subscriber = new ContractEventSubscriber({
      server: mockServer as never,
      pollIntervalMs: 10,
      startLedger: 0,
      cursorStore: mockStore,
      cursorNamespace: "test",
    });

    let count = 0;
    for await (const event of subscriber.subscribe(contractId, { contractIds: [contractId] })) {
      expect(event.id).toBe("ev1");
      count++;
      if (count >= 1) {
        subscriber.unsubscribe();
        break;
      }
    }

    // getEvents should have been called with startLedger = 101
    expect(mockServer.getEvents).toHaveBeenCalledWith(
      expect.objectContaining({ startLedger: 101 }),
    );
  });

  it("silently swallows network errors and retries on next interval", async () => {
    const contractId = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";

    mockServer.getEvents
      .mockRejectedValueOnce(new Error("network error"))
      .mockResolvedValueOnce({
        events: [makeEvent("ev1", 10, contractId)],
      });

    subscriber = new ContractEventSubscriber({
      server: mockServer as never,
      pollIntervalMs: 10,
      startLedger: 0,
      cursorStore: mockStore,
      cursorNamespace: "test",
    });

    let count = 0;
    for await (const event of subscriber.subscribe(contractId, { contractIds: [contractId] })) {
      expect(event.id).toBe("ev1");
      count++;
      if (count >= 1) {
        subscriber.unsubscribe();
        break;
      }
    }

    // getEvents was called twice (once failed, once succeeded)
    expect(mockServer.getEvents).toHaveBeenCalledTimes(2);
  });

  it("stops polling when unsubscribe() is called", async () => {
    const contractId = "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K";

    // Return empty events so the loop has nothing to yield
    mockServer.getEvents.mockResolvedValue({ events: [] });

    subscriber = new ContractEventSubscriber({
      server: mockServer as never,
      pollIntervalMs: 50, // short interval
      startLedger: 0,
      cursorStore: mockStore,
      cursorNamespace: "test",
    });

    // Start the subscription, unsubscribe after a short delay, then collect
    const results: ParsedContractEvent[] = [];
    const iterationPromise = (async () => {
      for await (const event of subscriber.subscribe(contractId, { contractIds: [contractId] })) {
        results.push(event);
      }
    })();

    // Give it one poll cycle then stop it
    await new Promise((r) => setTimeout(r, 80));
    subscriber.unsubscribe();

    await iterationPromise;

    expect(results).toHaveLength(0);
    // getEvents was called at least once (could be twice depending on timing)
    expect(mockServer.getEvents).toHaveBeenCalled();
  }, 5_000);

  it("defaults pollIntervalMs to 5000", () => {
    subscriber = new ContractEventSubscriber({
      server: mockServer as never,
    });
    expect((subscriber as unknown as { pollIntervalMs: number }).pollIntervalMs).toBe(5000);
  });

  it("defaults startLedger to 0", () => {
    subscriber = new ContractEventSubscriber({
      server: mockServer as never,
    });
    expect((subscriber as unknown as { startLedger: number }).startLedger).toBe(0);
  });
});
