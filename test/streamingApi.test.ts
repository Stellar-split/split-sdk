import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  setDefaultDedupTokenStore,
  InMemoryDedupTokenStore,
} from "../src/snapshot.js";
import { StreamDeduplicator } from "../src/streamDeduplicator.js";
import { TooManySubscriptionsError } from "../src/errors.js";
import { _resetCursorTrackerForTesting } from "../src/cursorTracker.js";

const rec = (token: string) => ({ paging_token: token });

describe("StreamDeduplicator (stream chunks)", () => {
  beforeEach(() => {
    setDefaultDedupTokenStore(new InMemoryDedupTokenStore());
  });

  it("passes new records and discards redelivered chunks", () => {
    const d = new StreamDeduplicator();
    const out = ["1", "2", "2", "3", "1"].filter((t) => d.filter(rec(t)));
    expect(out).toEqual(["1", "2", "3"]);
    expect(d.size).toBe(3);
  });

  it("emits duplicateEventDiscarded with the paging token", () => {
    const d = new StreamDeduplicator();
    const spy = vi.fn();
    d.on("duplicateEventDiscarded", spy);
    d.filter(rec("a"));
    d.filter(rec("a"));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith({ pagingToken: "a" });
  });

  it("bounds memory: oldest token is evicted once the window is full", () => {
    const d = new StreamDeduplicator({ windowSize: 3 });
    for (const t of ["1", "2", "3", "4"]) d.filter(rec(t));
    expect(d.size).toBe(3);
    expect(d.filter(rec("4"))).toBe(false);
    expect(d.filter(rec("2"))).toBe(false);
    // "1" was evicted so it is accepted again
    expect(d.filter(rec("1"))).toBe(true);
    expect(d.size).toBe(3);
  });

  it("never grows beyond the window under a large stream", () => {
    const d = new StreamDeduplicator({ windowSize: 50, flushIntervalTokens: 1000 });
    for (let i = 0; i < 1000; i++) d.filter(rec(String(i)));
    expect(d.size).toBe(50);
  });

  it("persists tokens after the flush interval and restores them", async () => {
    const a = new StreamDeduplicator({ namespace: "ns", flushIntervalTokens: 2 });
    a.filter(rec("x"));
    a.filter(rec("y"));
    await Promise.resolve();
    await Promise.resolve();

    const b = new StreamDeduplicator({ namespace: "ns" });
    await b.restore();
    expect(b.size).toBe(2);
    expect(b.filter(rec("x"))).toBe(false);
    expect(b.filter(rec("z"))).toBe(true);
  });

  it("restore with nothing persisted leaves the deduplicator empty", async () => {
    const d = new StreamDeduplicator({ namespace: "empty" });
    await d.restore();
    expect(d.size).toBe(0);
  });
});

describe("subscribeToInvoice (errors and cleanup)", () => {
  beforeEach(() => {
    _resetCursorTrackerForTesting();
    vi.useFakeTimers();
  });

  const makeServer = () => ({
    getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
    getEvents: vi.fn().mockResolvedValue({ events: [] }),
  });

  it("stops polling after unsubscribe", async () => {
    const { subscribeToInvoice } = await import("../src/stream.js");
    const server = makeServer();
    const unsub = subscribeToInvoice(server as never, "c", "inv-cleanup", vi.fn(), 1000);
    await vi.advanceTimersByTimeAsync(0);
    unsub();
    const calls = server.getEvents.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(server.getEvents.mock.calls.length).toBe(calls);
    vi.useRealTimers();
  });

  it("enforces the concurrent subscription limit and frees slots on unsubscribe", async () => {
    const { subscribeToInvoice } = await import("../src/stream.js");
    const server = makeServer();
    const unsubs = Array.from({ length: 10 }, (_, i) =>
      subscribeToInvoice(server as never, "c", `inv-limit-${i}`, vi.fn(), 1000),
    );
    expect(() =>
      subscribeToInvoice(server as never, "c", "inv-over", vi.fn(), 1000),
    ).toThrow(TooManySubscriptionsError);
    unsubs[0]();
    const extra = subscribeToInvoice(server as never, "c", "inv-after", vi.fn(), 1000);
    extra();
    unsubs.slice(1).forEach((u) => u());
    vi.useRealTimers();
  });

  it("does not throw out of the stream when the RPC call fails", async () => {
    const { subscribeToInvoice } = await import("../src/stream.js");
    const server = {
      getLatestLedger: vi.fn().mockRejectedValue(new Error("rpc down")),
      getEvents: vi.fn().mockRejectedValue(new Error("rpc down")),
    };
    const handler = vi.fn();
    const unsub = subscribeToInvoice(server as never, "c", "inv-err", handler, 1000);
    await vi.advanceTimersByTimeAsync(5000);
    expect(handler).not.toHaveBeenCalled();
    unsub();
    vi.useRealTimers();
  });
});
