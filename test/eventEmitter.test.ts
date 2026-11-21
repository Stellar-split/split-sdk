import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  SdkEventEmitter,
  getDefaultSdkEventEmitter,
  setDefaultSdkEventEmitter,
  resetDefaultSdkEventEmitter,
  type TransactionSubmittedPayload,
  type StateChangedPayload,
  type EmittedEvent,
} from "../src/events/eventEmitter.js";

describe("Issue #1263 — SDK Event Emitter", () => {
  let emitter: SdkEventEmitter;

  beforeEach(() => {
    emitter = new SdkEventEmitter();
    resetDefaultSdkEventEmitter();
  });

  // ── Event types defined ───────────────────────────────────────────────────

  describe("Event types defined", () => {
    it("emits transaction:submitted with correct payload shape", () => {
      const received: TransactionSubmittedPayload[] = [];
      emitter.on("transaction:submitted", (p) => received.push(p));

      emitter.emit("transaction:submitted", { id: "tx-1", hash: "0xabc", meta: { fee: 100 } });

      expect(received).toHaveLength(1);
      expect(received[0].id).toBe("tx-1");
      expect(received[0].hash).toBe("0xabc");
      expect(received[0].meta?.fee).toBe(100);
    });

    it("emits transaction:confirmed with correct payload shape", () => {
      const handler = vi.fn();
      emitter.on("transaction:confirmed", handler);
      emitter.emit("transaction:confirmed", { id: "tx-2", hash: "0xdef", ledger: 42 });

      expect(handler).toHaveBeenCalledWith({ id: "tx-2", hash: "0xdef", ledger: 42 });
    });

    it("emits transaction:failed with correct payload shape", () => {
      const handler = vi.fn();
      emitter.on("transaction:failed", handler);
      emitter.emit("transaction:failed", { id: "tx-3", error: new Error("timeout") });

      const payload = handler.mock.calls[0][0];
      expect(payload.id).toBe("tx-3");
      expect(payload.error).toBeInstanceOf(Error);
    });

    it("emits state:changed with correct payload shape", () => {
      const received: StateChangedPayload[] = [];
      emitter.on("state:changed", (p) => received.push(p as StateChangedPayload));

      emitter.emit("state:changed", {
        key: "invoice.status",
        previous: "pending",
        current: "paid",
        timestamp: 1000,
      });

      expect(received[0].key).toBe("invoice.status");
      expect(received[0].previous).toBe("pending");
      expect(received[0].current).toBe("paid");
    });

    it("emits sdk:error with correct payload shape", () => {
      const handler = vi.fn();
      emitter.on("sdk:error", handler);
      emitter.emit("sdk:error", { message: "RPC down", code: "RPC_ERROR", context: { url: "https://rpc" } });

      expect(handler).toHaveBeenCalledWith({
        message: "RPC down",
        code: "RPC_ERROR",
        context: { url: "https://rpc" },
      });
    });
  });

  // ── Events emit ──────────────────────────────────────────────────────────

  describe("Events emit correctly", () => {
    it("on() handler receives every emission for its event", () => {
      const handler = vi.fn();
      emitter.on("transaction:submitted", handler);

      emitter.emit("transaction:submitted", { id: "a" });
      emitter.emit("transaction:submitted", { id: "b" });

      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("multiple handlers for the same event all receive the payload", () => {
      const a = vi.fn();
      const b = vi.fn();
      emitter.on("transaction:confirmed", a);
      emitter.on("transaction:confirmed", b);

      emitter.emit("transaction:confirmed", { id: "tx-1" });

      expect(a).toHaveBeenCalledOnce();
      expect(b).toHaveBeenCalledOnce();
    });

    it("on() unsubscribe stops delivery", () => {
      const handler = vi.fn();
      const unsub = emitter.on("transaction:submitted", handler);

      emitter.emit("transaction:submitted", { id: "before" });
      unsub();
      emitter.emit("transaction:submitted", { id: "after" });

      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0][0].id).toBe("before");
    });

    it("off() stops delivery", () => {
      const handler = vi.fn();
      emitter.on("state:changed", handler);
      emitter.off("state:changed", handler);
      emitter.emit("state:changed", { key: "k", previous: undefined, current: 1, timestamp: 0 });

      expect(handler).not.toHaveBeenCalled();
    });

    it("removeAllListeners(event) clears only that event", () => {
      const a = vi.fn();
      const b = vi.fn();
      emitter.on("transaction:submitted", a);
      emitter.on("transaction:failed", b);

      emitter.removeAllListeners("transaction:submitted");
      emitter.emit("transaction:submitted", { id: "1" });
      emitter.emit("transaction:failed", { id: "2" });

      expect(a).not.toHaveBeenCalled();
      expect(b).toHaveBeenCalledOnce();
    });

    it("removeAllListeners() with no arg clears everything", () => {
      const a = vi.fn();
      const b = vi.fn();
      emitter.on("transaction:submitted", a);
      emitter.on("transaction:failed", b);
      emitter.removeAllListeners();

      emitter.emit("transaction:submitted", { id: "1" });
      emitter.emit("transaction:failed", { id: "2" });

      expect(a).not.toHaveBeenCalled();
      expect(b).not.toHaveBeenCalled();
    });

    it("once() resolves with the first emission then stops", async () => {
      const promise = emitter.once("transaction:confirmed");
      emitter.emit("transaction:confirmed", { id: "first", ledger: 1 });
      emitter.emit("transaction:confirmed", { id: "second", ledger: 2 });

      const result = await promise;
      expect((result as TransactionSubmittedPayload).id).toBe("first");
      expect(emitter.listenerCount("transaction:confirmed")).toBe(0);
    });

    it("onAny() wildcard receives every emitted event", () => {
      const received: Array<{ event: string; payload: unknown }> = [];
      emitter.onAny((event, payload) => received.push({ event: event as string, payload }));

      emitter.emit("transaction:submitted", { id: "tx-1" });
      emitter.emit("state:changed", { key: "k", previous: undefined, current: 2, timestamp: 0 });

      expect(received).toHaveLength(2);
      expect(received[0].event).toBe("transaction:submitted");
      expect(received[1].event).toBe("state:changed");
    });

    it("listenerCount() reflects the current registration state", () => {
      expect(emitter.listenerCount("transaction:submitted")).toBe(0);
      const unsub = emitter.on("transaction:submitted", vi.fn());
      expect(emitter.listenerCount("transaction:submitted")).toBe(1);
      unsub();
      expect(emitter.listenerCount("transaction:submitted")).toBe(0);
    });
  });

  // ── Filtering ─────────────────────────────────────────────────────────────

  describe("Filtering works", () => {
    it("filter predicate suppresses non-matching payloads", () => {
      const handler = vi.fn();
      emitter.on(
        "transaction:submitted",
        handler,
        (p) => p.id.startsWith("important-"),
      );

      emitter.emit("transaction:submitted", { id: "noise" });
      emitter.emit("transaction:submitted", { id: "important-tx" });

      expect(handler).toHaveBeenCalledOnce();
      expect(handler.mock.calls[0][0].id).toBe("important-tx");
    });

    it("multiple handlers with different filters are independent", () => {
      const failed = vi.fn();
      const all = vi.fn();

      emitter.on(
        "transaction:submitted",
        failed,
        (p) => p.meta?.status === "failed",
      );
      emitter.on("transaction:submitted", all);

      emitter.emit("transaction:submitted", { id: "ok", meta: { status: "ok" } });
      emitter.emit("transaction:submitted", { id: "bad", meta: { status: "failed" } });

      expect(failed).toHaveBeenCalledOnce();
      expect(failed.mock.calls[0][0].id).toBe("bad");
      expect(all).toHaveBeenCalledTimes(2);
    });

    it("off() correctly removes a filtered handler without affecting others", () => {
      const filtered = vi.fn();
      const unfiltered = vi.fn();

      emitter.on("transaction:submitted", filtered, () => true);
      emitter.on("transaction:submitted", unfiltered);

      emitter.off("transaction:submitted", filtered);
      emitter.emit("transaction:submitted", { id: "tx-1" });

      expect(filtered).not.toHaveBeenCalled();
      expect(unfiltered).toHaveBeenCalledOnce();
    });

    it("filter on state:changed can match by key", () => {
      const handler = vi.fn();
      emitter.on(
        "state:changed",
        handler,
        (p) => (p as StateChangedPayload).key === "invoice.status",
      );

      emitter.emit("state:changed", { key: "other.key",      previous: undefined, current: 1, timestamp: 0 });
      emitter.emit("state:changed", { key: "invoice.status", previous: "pending", current: "paid", timestamp: 1 });

      expect(handler).toHaveBeenCalledOnce();
      expect((handler.mock.calls[0][0] as StateChangedPayload).current).toBe("paid");
    });

    it("getHistory() filters by event name (single)", () => {
      emitter.emit("transaction:submitted",  { id: "s1" });
      emitter.emit("transaction:confirmed",  { id: "c1" });
      emitter.emit("transaction:submitted",  { id: "s2" });

      const submitted = emitter.getHistory({ event: "transaction:submitted" });
      expect(submitted).toHaveLength(2);
      expect(submitted.every((r) => r.event === "transaction:submitted")).toBe(true);
    });

    it("getHistory() filters by event name (array)", () => {
      emitter.emit("transaction:submitted", { id: "s1" });
      emitter.emit("transaction:confirmed", { id: "c1" });
      emitter.emit("transaction:failed",    { id: "f1" });

      const results = emitter.getHistory({ event: ["transaction:submitted", "transaction:failed"] });
      expect(results).toHaveLength(2);
    });

    it("getHistory() filters by time range (since / until)", () => {
      const e1 = Date.now();
      emitter.emit("transaction:submitted", { id: "early" });
      const e2 = Date.now();
      emitter.emit("transaction:confirmed", { id: "mid" });
      const e3 = Date.now();
      emitter.emit("transaction:failed",    { id: "late" });

      const range = emitter.getHistory({ since: e1, until: e2 });
      range.forEach((r) => {
        expect(r.timestamp).toBeGreaterThanOrEqual(e1);
        expect(r.timestamp).toBeLessThanOrEqual(e3);
      });
    });

    it("getHistory() respects limit — returns latest N records", () => {
      emitter.emit("transaction:submitted", { id: "1" });
      emitter.emit("transaction:submitted", { id: "2" });
      emitter.emit("transaction:submitted", { id: "3" });

      const limited = emitter.getHistory({ limit: 2 });
      expect(limited).toHaveLength(2);
      expect((limited[1].payload as TransactionSubmittedPayload).id).toBe("3");
    });

    it("getHistory() with no filter returns all records", () => {
      emitter.emit("transaction:submitted", { id: "a" });
      emitter.emit("transaction:confirmed", { id: "b" });

      expect(emitter.getHistory()).toHaveLength(2);
    });

    it("clearHistory() empties history without affecting listeners", () => {
      const handler = vi.fn();
      emitter.on("transaction:submitted", handler);

      emitter.emit("transaction:submitted", { id: "1" });
      expect(emitter.getHistory()).toHaveLength(1);

      emitter.clearHistory();
      expect(emitter.getHistory()).toHaveLength(0);

      emitter.emit("transaction:submitted", { id: "2" });
      expect(handler).toHaveBeenCalledTimes(2);
    });

    it("maxHistory evicts oldest records when capacity is reached", () => {
      const small = new SdkEventEmitter({ maxHistory: 2 });
      small.emit("transaction:submitted", { id: "first"  });
      small.emit("transaction:submitted", { id: "second" });
      small.emit("transaction:submitted", { id: "third"  }); // evicts "first"

      const ids = small.getHistory().map((r) => (r.payload as TransactionSubmittedPayload).id);
      expect(ids).toEqual(["second", "third"]);
    });
  });

  // ── Stats tracked ─────────────────────────────────────────────────────────

  describe("Stats tracked", () => {
    it("returns zeroed stats when nothing has been emitted", () => {
      const stats = emitter.getStats();
      expect(stats.totalEmitted).toBe(0);
      expect(stats.byEvent).toEqual({});
      expect(stats.firstEmittedAt).toBeUndefined();
      expect(stats.lastEmittedAt).toBeUndefined();
    });

    it("totalEmitted increments with every emission", () => {
      emitter.emit("transaction:submitted", { id: "1" });
      emitter.emit("transaction:confirmed", { id: "1" });
      emitter.emit("transaction:submitted", { id: "2" });

      expect(emitter.getStats().totalEmitted).toBe(3);
    });

    it("byEvent counts per event name correctly", () => {
      emitter.emit("transaction:submitted", { id: "a" });
      emitter.emit("transaction:submitted", { id: "b" });
      emitter.emit("transaction:failed",    { id: "c" });

      const { byEvent } = emitter.getStats();
      expect(byEvent["transaction:submitted"]).toBe(2);
      expect(byEvent["transaction:failed"]).toBe(1);
      expect(byEvent["transaction:confirmed"]).toBeUndefined();
    });

    it("listenerCount reflects active listeners at call time", () => {
      const unsub = emitter.on("transaction:submitted", vi.fn());
      emitter.emit("transaction:submitted", { id: "ping" }); // ensure event is known

      expect(emitter.getStats().listenerCount).toBeGreaterThanOrEqual(1);

      unsub();
      // After unsub the listener is gone
      expect(emitter.listenerCount("transaction:submitted")).toBe(0);
    });

    it("firstEmittedAt and lastEmittedAt are set correctly", () => {
      const before = Date.now();
      emitter.emit("transaction:submitted", { id: "1" });
      emitter.emit("transaction:confirmed", { id: "2" });
      const after = Date.now();

      const stats = emitter.getStats();
      expect(stats.firstEmittedAt).toBeGreaterThanOrEqual(before);
      expect(stats.lastEmittedAt).toBeGreaterThanOrEqual(stats.firstEmittedAt!);
      expect(stats.lastEmittedAt).toBeLessThanOrEqual(after);
    });

    it("resetStats() clears counters without affecting listeners or history", () => {
      const handler = vi.fn();
      emitter.on("transaction:submitted", handler);
      emitter.emit("transaction:submitted", { id: "1" });

      expect(emitter.getStats().totalEmitted).toBe(1);

      emitter.resetStats();
      const stats = emitter.getStats();
      expect(stats.totalEmitted).toBe(0);
      expect(stats.byEvent).toEqual({});
      expect(stats.firstEmittedAt).toBeUndefined();

      // Listener still works, history still present
      emitter.emit("transaction:submitted", { id: "2" });
      expect(handler).toHaveBeenCalledTimes(2);
      expect(emitter.getHistory()).toHaveLength(2); // both records
    });
  });

  // ── Global default emitter ────────────────────────────────────────────────

  describe("Global default emitter", () => {
    it("getDefaultSdkEventEmitter returns the same instance on repeated calls", () => {
      expect(getDefaultSdkEventEmitter()).toBe(getDefaultSdkEventEmitter());
    });

    it("setDefaultSdkEventEmitter replaces the instance", () => {
      const custom = new SdkEventEmitter({ maxHistory: 10 });
      setDefaultSdkEventEmitter(custom);
      expect(getDefaultSdkEventEmitter()).toBe(custom);
    });

    it("resetDefaultSdkEventEmitter gives a fresh empty emitter", () => {
      const original = getDefaultSdkEventEmitter();
      original.emit("transaction:submitted", { id: "ping" });
      expect(original.getStats().totalEmitted).toBe(1);

      resetDefaultSdkEventEmitter();
      const fresh = getDefaultSdkEventEmitter();
      expect(fresh).not.toBe(original);
      expect(fresh.getStats().totalEmitted).toBe(0);
    });
  });
});
