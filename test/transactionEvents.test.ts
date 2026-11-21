import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  TransactionEventTracker,
  getDefaultTransactionEventTracker,
  setDefaultTransactionEventTracker,
  resetDefaultTransactionEventTracker,
  type TransactionEvent,
  type TransactionCreatedEvent,
  type TransactionErrorEvent,
} from "../src/transactionEvents.js";

describe("Issue #1264 — Transaction Event Tracking", () => {
  let tracker: TransactionEventTracker;

  beforeEach(() => {
    tracker = new TransactionEventTracker();
    resetDefaultTransactionEventTracker();
  });

  // ── Event types & lifecycle coverage ───────────────────────────────────────

  describe("Event types defined", () => {
    it("emitCreated returns a correctly typed created event", () => {
      const event = tracker.emitCreated("tx-1", "payInvoice", {
        sourceAccount: "GABC",
        details: { invoiceId: "inv-1" },
      });

      expect(event.transactionId).toBe("tx-1");
      expect(event.step).toBe("created");
      expect(event.operation).toBe("payInvoice");
      expect(event.sourceAccount).toBe("GABC");
      expect(event.details).toEqual({ invoiceId: "inv-1" });
      expect(event.timestamp).toBeGreaterThan(0);
    });

    it("emitSimulated returns a correctly typed simulated event", () => {
      const event = tracker.emitSimulated("tx-2", { success: true, fee: "100", result: { ok: true } });
      expect(event.step).toBe("simulated");
      expect(event.success).toBe(true);
      expect(event.fee).toBe("100");
    });

    it("emitSigned returns a correctly typed signed event", () => {
      const event = tracker.emitSigned("tx-3", { signer: "GXYZ", signatureCount: 2 });
      expect(event.step).toBe("signed");
      expect(event.signer).toBe("GXYZ");
      expect(event.signatureCount).toBe(2);
    });

    it("emitSubmitted returns a correctly typed submitted event", () => {
      const event = tracker.emitSubmitted("tx-4", { hash: "0xabc", ledger: 42 });
      expect(event.step).toBe("submitted");
      expect(event.hash).toBe("0xabc");
      expect(event.ledger).toBe(42);
    });

    it("emitConfirmed returns a correctly typed confirmed event", () => {
      const event = tracker.emitConfirmed("tx-5", { success: true, hash: "0xdef", ledger: 43 });
      expect(event.step).toBe("confirmed");
      expect(event.success).toBe(true);
      expect(event.hash).toBe("0xdef");
    });

    it("emitError returns a correctly typed error event with failedStep", () => {
      const event = tracker.emitError("tx-6", "submitted", {
        message: "Network timeout",
        code: "TIMEOUT",
        details: { attempt: 3 },
      });
      expect(event.step).toBe("error");
      expect(event.failedStep).toBe("submitted");
      expect(event.error.message).toBe("Network timeout");
      expect(event.error.code).toBe("TIMEOUT");
    });
  });

  // ── Event tracking ─────────────────────────────────────────────────────────

  describe("Events tracked", () => {
    it("stores every emitted event in history", () => {
      tracker.emitCreated("tx-1", "payInvoice");
      tracker.emitSimulated("tx-1", { success: true });
      tracker.emitSigned("tx-1");
      tracker.emitSubmitted("tx-1", { hash: "0xabc" });
      tracker.emitConfirmed("tx-1", { success: true });

      expect(tracker.count()).toBe(5);
    });

    it("respects the maxHistory capacity — evicts oldest events", () => {
      const small = new TransactionEventTracker({ maxHistory: 3 });

      small.emitCreated("tx-1", "op");
      small.emitCreated("tx-2", "op");
      small.emitCreated("tx-3", "op");
      small.emitCreated("tx-4", "op"); // should evict tx-1

      expect(small.count()).toBe(3);
      const ids = small.getEvents().map((e) => e.transactionId);
      expect(ids).toEqual(["tx-2", "tx-3", "tx-4"]);
    });

    it("getLastEvent returns the most recently emitted event", () => {
      tracker.emitCreated("tx-1", "op");
      tracker.emitSigned("tx-1");

      expect(tracker.getLastEvent()?.step).toBe("signed");
    });

    it("clear() resets the history buffer", () => {
      tracker.emitCreated("tx-1", "op");
      expect(tracker.count()).toBe(1);

      tracker.clear();
      expect(tracker.count()).toBe(0);
      expect(tracker.getLastEvent()).toBeUndefined();
    });
  });

  // ── Subscriptions ──────────────────────────────────────────────────────────

  describe("Subscriptions fire correctly", () => {
    it("subscribe() catch-all listener receives every event", () => {
      const received: TransactionEvent[] = [];
      tracker.subscribe((e) => received.push(e));

      tracker.emitCreated("tx-1", "op");
      tracker.emitConfirmed("tx-1", { success: true });

      expect(received).toHaveLength(2);
      expect(received[0].step).toBe("created");
      expect(received[1].step).toBe("confirmed");
    });

    it("subscribe() returns an unsubscribe function that stops delivery", () => {
      const received: TransactionEvent[] = [];
      const unsub = tracker.subscribe((e) => received.push(e));

      tracker.emitCreated("tx-1", "op");
      unsub();
      tracker.emitConfirmed("tx-1", { success: true });

      expect(received).toHaveLength(1);
    });

    it("on() per-step listener receives only its step", () => {
      const created: TransactionCreatedEvent[] = [];
      const errors: TransactionErrorEvent[] = [];

      tracker.on("transaction:created", (e) => created.push(e));
      tracker.on("transaction:error", (e) => errors.push(e));

      tracker.emitCreated("tx-1", "op");
      tracker.emitSimulated("tx-1", { success: false });
      tracker.emitError("tx-1", "simulated", { message: "sim failed" });

      expect(created).toHaveLength(1);
      expect(errors).toHaveLength(1);
      expect(errors[0].failedStep).toBe("simulated");
    });

    it("on('transaction:any') wildcard receives every event", () => {
      const all: TransactionEvent[] = [];
      tracker.on("transaction:any", (e) => all.push(e));

      tracker.emitCreated("tx-1", "op");
      tracker.emitSigned("tx-1");
      tracker.emitConfirmed("tx-1", { success: true });

      expect(all).toHaveLength(3);
    });

    it("multiple listeners all receive the same event", () => {
      const spy1 = vi.fn();
      const spy2 = vi.fn();

      tracker.subscribe(spy1);
      tracker.subscribe(spy2);
      tracker.emitCreated("tx-1", "op");

      expect(spy1).toHaveBeenCalledOnce();
      expect(spy2).toHaveBeenCalledOnce();
      expect(spy1.mock.calls[0][0].step).toBe("created");
    });
  });

  // ── Filtering ──────────────────────────────────────────────────────────────

  describe("Filtering works", () => {
    beforeEach(() => {
      tracker.emitCreated("tx-1", "payInvoice");
      tracker.emitSimulated("tx-1", { success: true });
      tracker.emitCreated("tx-2", "cloneInvoice");
      tracker.emitError("tx-2", "created", { message: "Not found", code: "NOT_FOUND" });
      tracker.emitConfirmed("tx-1", { success: true });
    });

    it("filters by transactionId (single)", () => {
      const events = tracker.getEvents({ transactionId: "tx-1" });
      expect(events.every((e) => e.transactionId === "tx-1")).toBe(true);
      expect(events).toHaveLength(3);
    });

    it("filters by transactionId (array)", () => {
      const events = tracker.getEvents({ transactionId: ["tx-1", "tx-2"] });
      expect(events).toHaveLength(5);
    });

    it("filters by step (single)", () => {
      const events = tracker.getEvents({ step: "created" });
      expect(events).toHaveLength(2);
      expect(events.every((e) => e.step === "created")).toBe(true);
    });

    it("filters by step (array)", () => {
      const events = tracker.getEvents({ step: ["error", "confirmed"] });
      expect(events).toHaveLength(2);
    });

    it("filters by time range (since / until)", () => {
      const t = Date.now();
      const small = new TransactionEventTracker();
      // Inject events with known timestamps via the emit helpers (approximate)
      const e1 = small.emitCreated("tx-a", "op");
      const e2 = small.emitConfirmed("tx-a", { success: true });

      const all = small.getEvents({ since: e1.timestamp, until: e2.timestamp });
      expect(all.length).toBeGreaterThanOrEqual(2);
      all.forEach((e) => {
        expect(e.timestamp).toBeGreaterThanOrEqual(e1.timestamp);
        expect(e.timestamp).toBeLessThanOrEqual(e2.timestamp);
      });
    });

    it("respects the limit option — returns latest N events", () => {
      const limited = tracker.getEvents({ limit: 2 });
      expect(limited).toHaveLength(2);
      // Limit returns latest, so last two are confirmed (tx-1) and error (tx-2)
      const steps = limited.map((e) => e.step);
      expect(steps).toContain("confirmed");
    });

    it("returns all events when no filter is applied", () => {
      expect(tracker.getEvents()).toHaveLength(5);
    });
  });

  // ── Stats ──────────────────────────────────────────────────────────────────

  describe("Stats complete", () => {
    it("returns zeroed stats for an empty tracker", () => {
      const stats = tracker.getStats();
      expect(stats.total).toBe(0);
      expect(stats.uniqueTransactions).toBe(0);
      expect(stats.byStep.created).toBe(0);
      expect(stats.byStep.error).toBe(0);
      expect(stats.oldestTimestamp).toBeUndefined();
      expect(stats.newestTimestamp).toBeUndefined();
      expect(stats.spanMs).toBe(0);
    });

    it("counts events per step and unique transaction IDs", () => {
      tracker.emitCreated("tx-1", "pay");
      tracker.emitCreated("tx-2", "pay");
      tracker.emitSimulated("tx-1", { success: true });
      tracker.emitError("tx-2", "created", { message: "fail" });
      tracker.emitConfirmed("tx-1", { success: true });

      const stats = tracker.getStats();
      expect(stats.total).toBe(5);
      expect(stats.byStep.created).toBe(2);
      expect(stats.byStep.simulated).toBe(1);
      expect(stats.byStep.error).toBe(1);
      expect(stats.byStep.confirmed).toBe(1);
      expect(stats.uniqueTransactions).toBe(2);
    });

    it("reports correct oldest/newest timestamps and span", () => {
      const small = new TransactionEventTracker();
      const e1 = small.emitCreated("tx-a", "op");
      const e3 = small.emitConfirmed("tx-a", { success: true });

      const stats = small.getStats();
      expect(stats.oldestTimestamp).toBe(e1.timestamp);
      expect(stats.newestTimestamp).toBe(e3.timestamp);
      expect(stats.spanMs).toBe(e3.timestamp - e1.timestamp);
    });

    it("spanMs is 0 for a single-event history", () => {
      tracker.emitCreated("tx-1", "op");
      expect(tracker.getStats().spanMs).toBe(0);
    });
  });

  // ── Global default tracker ─────────────────────────────────────────────────

  describe("Global default tracker", () => {
    it("getDefaultTransactionEventTracker returns a shared instance", () => {
      const a = getDefaultTransactionEventTracker();
      const b = getDefaultTransactionEventTracker();
      expect(a).toBe(b);
    });

    it("setDefaultTransactionEventTracker replaces the instance", () => {
      const custom = new TransactionEventTracker({ maxHistory: 10 });
      setDefaultTransactionEventTracker(custom);
      expect(getDefaultTransactionEventTracker()).toBe(custom);
    });

    it("resetDefaultTransactionEventTracker gives a fresh empty tracker", () => {
      const original = getDefaultTransactionEventTracker();
      original.emitCreated("tx-1", "op");
      expect(original.count()).toBe(1);

      resetDefaultTransactionEventTracker();
      const fresh = getDefaultTransactionEventTracker();
      expect(fresh).not.toBe(original);
      expect(fresh.count()).toBe(0);
    });
  });
});
