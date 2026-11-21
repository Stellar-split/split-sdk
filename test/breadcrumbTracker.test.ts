import { describe, it, expect, beforeEach } from "vitest";
import {
  BreadcrumbTracker,
  RingBufferBreadcrumbStorage,
  getDefaultBreadcrumbTracker,
  setDefaultBreadcrumbTracker,
  resetDefaultBreadcrumbTracker,
  addBreadcrumb,
  getBreadcrumbs,
  clearBreadcrumbs,
  getBreadcrumbStats,
} from "../src/breadcrumbTracker.js";

describe("Issue #1070 — Breadcrumb Tracking", () => {
  beforeEach(() => {
    resetDefaultBreadcrumbTracker();
  });

  describe("Storage Efficiency (RingBufferBreadcrumbStorage)", () => {
    it("maintains a fixed maximum capacity and evicts oldest items in FIFO order", () => {
      const storage = new RingBufferBreadcrumbStorage(3);
      expect(storage.size()).toBe(0);

      storage.add({
        id: "1",
        timestamp: 100,
        category: "ui",
        message: "Click 1",
      });
      storage.add({
        id: "2",
        timestamp: 200,
        category: "ui",
        message: "Click 2",
      });
      storage.add({
        id: "3",
        timestamp: 300,
        category: "ui",
        message: "Click 3",
      });

      expect(storage.size()).toBe(3);
      expect(storage.getAll().map((b) => b.id)).toEqual(["1", "2", "3"]);

      // Add 4th item -> should evict item "1" and preserve chronological order
      storage.add({
        id: "4",
        timestamp: 400,
        category: "ui",
        message: "Click 4",
      });

      expect(storage.size()).toBe(3);
      expect(storage.getAll().map((b) => b.id)).toEqual(["2", "3", "4"]);

      // Add 5th item -> should evict item "2"
      storage.add({
        id: "5",
        timestamp: 500,
        category: "ui",
        message: "Click 5",
      });

      expect(storage.size()).toBe(3);
      expect(storage.getAll().map((b) => b.id)).toEqual(["3", "4", "5"]);
    });

    it("clears storage efficiently", () => {
      const storage = new RingBufferBreadcrumbStorage(5);
      storage.add({ id: "1", timestamp: 100, category: "http", message: "req" });
      expect(storage.size()).toBe(1);

      storage.clear();
      expect(storage.size()).toBe(0);
      expect(storage.getAll()).toEqual([]);
    });
  });

  describe("Tracker Implementation & Rich Context Helpers", () => {
    it("records basic breadcrumbs with automatic timestamp and ID", () => {
      const tracker = new BreadcrumbTracker({ maxBreadcrumbs: 10 });
      const crumb = tracker.addBreadcrumb({
        category: "custom",
        message: "Manual step",
        level: "info",
        data: { step: 1 },
      });

      expect(crumb).not.toBeNull();
      expect(crumb!.id).toBeDefined();
      expect(crumb!.timestamp).toBeGreaterThan(0);
      expect(crumb!.message).toBe("Manual step");
      expect(crumb!.data).toEqual({ step: 1 });
      expect(tracker.count()).toBe(1);
    });

    it("tracks rich HTTP request/response breadcrumbs", () => {
      const tracker = new BreadcrumbTracker();
      const crumb = tracker.trackHttp("POST", "https://horizon-testnet.stellar.org/transactions", 200, 150, {
        txId: "tx-abc",
      });

      expect(crumb).not.toBeNull();
      expect(crumb!.category).toBe("http");
      expect(crumb!.message).toContain("POST https://horizon-testnet.stellar.org/transactions [200]");
      expect(crumb!.data?.method).toBe("POST");
      expect(crumb!.data?.status).toBe(200);
      expect(crumb!.data?.durationMs).toBe(150);
      expect(crumb!.data?.txId).toBe("tx-abc");
    });

    it("tracks rich transaction lifecycle events", () => {
      const tracker = new BreadcrumbTracker();
      tracker.trackTransaction("0xabcdef123456", "payInvoice", "submitted");
      const failed = tracker.trackTransaction("0xabcdef123456", "payInvoice", "failed", { reason: "insufficient_balance" });

      expect(tracker.count()).toBe(2);
      expect(failed!.level).toBe("error");
      expect(failed!.data?.status).toBe("failed");
      expect(failed!.data?.reason).toBe("insufficient_balance");
    });

    it("tracks rich RPC calls, state changes, and user actions", () => {
      const tracker = new BreadcrumbTracker();

      tracker.trackRpc("simulateTransaction", "https://soroban-rpc.stellar.org", "success", 42);
      tracker.trackStateChange("Pending", "Paid", "inv-999");
      tracker.trackUserAction("submit_payment_button_clicked", { buttonId: "btn-pay" });
      tracker.trackError(new Error("Network timeout"), { retryAttempt: 2 });

      expect(tracker.count()).toBe(4);
      const crumbs = tracker.getBreadcrumbs();
      expect(crumbs[0].category).toBe("rpc");
      expect(crumbs[1].category).toBe("state");
      expect(crumbs[1].data?.fromState).toBe("Pending");
      expect(crumbs[1].data?.toState).toBe("Paid");
      expect(crumbs[2].category).toBe("ui");
      expect(crumbs[3].category).toBe("error");
      expect(crumbs[3].level).toBe("error");
    });

    it("respects beforeAddBreadcrumb sanitization hook", () => {
      const tracker = new BreadcrumbTracker({
        beforeAddBreadcrumb: (crumb) => {
          if (crumb.message.includes("ignore_me")) return null;
          return {
            ...crumb,
            message: `Sanitized: ${crumb.message}`,
          };
        },
      });

      tracker.addBreadcrumb({ message: "normal message" });
      tracker.addBreadcrumb({ message: "ignore_me message" });

      expect(tracker.count()).toBe(1);
      expect(tracker.getLastBreadcrumb()?.message).toBe("Sanitized: normal message");
    });
  });

  describe("Fast Retrieval & Filtering", () => {
    it("filters breadcrumbs by category, level, time window, and limit", () => {
      const tracker = new BreadcrumbTracker({ maxBreadcrumbs: 20 });

      tracker.addBreadcrumb({ category: "http", message: "req 1", timestamp: 100, level: "info" });
      tracker.addBreadcrumb({ category: "rpc", message: "rpc 1", timestamp: 200, level: "debug" });
      tracker.addBreadcrumb({ category: "http", message: "req 2", timestamp: 300, level: "warn" });
      tracker.addBreadcrumb({ category: "transaction", message: "tx 1", timestamp: 400, level: "error" });

      // Filter by category
      expect(tracker.getBreadcrumbs({ category: "http" })).toHaveLength(2);
      expect(tracker.getBreadcrumbs({ category: ["http", "rpc"] })).toHaveLength(3);

      // Filter by level
      expect(tracker.getBreadcrumbs({ level: "error" })).toHaveLength(1);

      // Filter by time range
      expect(tracker.getBreadcrumbs({ since: 150, until: 350 })).toHaveLength(2);

      // Limit to latest N
      const latest2 = tracker.getBreadcrumbs({ limit: 2 });
      expect(latest2).toHaveLength(2);
      expect(latest2.map((b) => b.message)).toEqual(["req 2", "tx 1"]);
    });

    it("snapshot returns a safe independent copy of current breadcrumbs", () => {
      const tracker = new BreadcrumbTracker();
      tracker.addBreadcrumb({ message: "Crumb A" });

      const snap = tracker.snapshot();
      expect(snap).toHaveLength(1);

      tracker.addBreadcrumb({ message: "Crumb B" });
      expect(snap).toHaveLength(1);
      expect(tracker.count()).toBe(2);
    });
  });

  describe("Global Default BreadcrumbTracker", () => {
    it("supports top-level addBreadcrumb, getBreadcrumbs, and clearBreadcrumbs", () => {
      addBreadcrumb({ category: "ui", message: "Global step 1" });
      addBreadcrumb({ category: "http", message: "Global step 2" });

      expect(getBreadcrumbs()).toHaveLength(2);

      clearBreadcrumbs();
      expect(getBreadcrumbs()).toHaveLength(0);
    });

    it("allows replacing the default tracker instance", () => {
      const customTracker = new BreadcrumbTracker({ maxBreadcrumbs: 5 });
      setDefaultBreadcrumbTracker(customTracker);

      expect(getDefaultBreadcrumbTracker()).toBe(customTracker);
    });
  });

  describe("Breadcrumb Stats (#1266)", () => {
    it("returns zero counts and undefined timestamps for an empty tracker", () => {
      const tracker = new BreadcrumbTracker();
      const stats = tracker.getStats();

      expect(stats.total).toBe(0);
      expect(stats.byCategory).toEqual({});
      expect(stats.byLevel.info).toBe(0);
      expect(stats.byLevel.error).toBe(0);
      expect(stats.oldestTimestamp).toBeUndefined();
      expect(stats.newestTimestamp).toBeUndefined();
      expect(stats.spanMs).toBe(0);
    });

    it("counts breadcrumbs correctly by category and level", () => {
      const tracker = new BreadcrumbTracker({ maxBreadcrumbs: 20 });

      tracker.addBreadcrumb({ category: "http",        message: "req 1",  level: "info",  timestamp: 1000 });
      tracker.addBreadcrumb({ category: "rpc",         message: "rpc 1",  level: "debug", timestamp: 2000 });
      tracker.addBreadcrumb({ category: "http",        message: "req 2",  level: "warn",  timestamp: 3000 });
      tracker.addBreadcrumb({ category: "transaction", message: "tx 1",   level: "error", timestamp: 4000 });
      tracker.addBreadcrumb({ category: "transaction", message: "tx 2",   level: "info",  timestamp: 5000 });

      const stats = tracker.getStats();

      expect(stats.total).toBe(5);
      expect(stats.byCategory["http"]).toBe(2);
      expect(stats.byCategory["rpc"]).toBe(1);
      expect(stats.byCategory["transaction"]).toBe(2);
      expect(stats.byLevel.info).toBe(2);
      expect(stats.byLevel.debug).toBe(1);
      expect(stats.byLevel.warn).toBe(1);
      expect(stats.byLevel.error).toBe(1);
    });

    it("reports correct oldest/newest timestamps and span", () => {
      const tracker = new BreadcrumbTracker({ maxBreadcrumbs: 10 });

      tracker.addBreadcrumb({ message: "first",  timestamp: 1000 });
      tracker.addBreadcrumb({ message: "middle", timestamp: 3000 });
      tracker.addBreadcrumb({ message: "last",   timestamp: 7000 });

      const stats = tracker.getStats();
      expect(stats.oldestTimestamp).toBe(1000);
      expect(stats.newestTimestamp).toBe(7000);
      expect(stats.spanMs).toBe(6000);
    });

    it("spanMs is 0 when only one breadcrumb is stored", () => {
      const tracker = new BreadcrumbTracker();
      tracker.addBreadcrumb({ message: "solo", timestamp: 5000 });

      const stats = tracker.getStats();
      expect(stats.total).toBe(1);
      expect(stats.spanMs).toBe(0);
    });

    it("module-level getBreadcrumbStats delegates to the default tracker", () => {
      addBreadcrumb({ category: "http",  message: "g1", level: "info",  timestamp: 100 });
      addBreadcrumb({ category: "error", message: "g2", level: "error", timestamp: 200 });

      const stats = getBreadcrumbStats();
      expect(stats.total).toBe(2);
      expect(stats.byCategory["http"]).toBe(1);
      expect(stats.byCategory["error"]).toBe(1);
      expect(stats.byLevel.error).toBe(1);
      expect(stats.spanMs).toBe(100);
    });
  });
});
