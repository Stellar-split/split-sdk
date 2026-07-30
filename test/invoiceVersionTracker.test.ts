import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  InvoiceVersionTracker,
  InMemoryVersionStore,
} from "../src/invoiceVersionTracker.js";
import type { InvoiceVersion } from "../src/invoiceVersionTracker.js";
import type { Invoice } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CREATOR = "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2";
const RECIPIENT1 = "GBRPYHIL2CI3WHSCULNJJMA3CJBYWR5LK662LFXISKW3P7UKDXTX5AGE";
const RECIPIENT2 = "GDQJUTQYK2MQX2CBBFKVZBNE4RG4H3ZVJJJX5RFHPB4DXX6IQHTHYKF";

/** Minimal valid Invoice for testing. */
function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "1001",
    creator: CREATOR,
    recipients: [{ address: RECIPIENT1, amount: 100_000_000n }],
    token: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
    deadline: Math.floor(Date.now() / 1000) + 86_400,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InvoiceVersionTracker", () => {
  let tracker: InvoiceVersionTracker;

  beforeEach(() => {
    tracker = new InvoiceVersionTracker();
  });

  // ── record() ─────────────────────────────────────────────────────────────

  describe("record()", () => {
    it("creates the first version with version number 1", async () => {
      const invoice = makeInvoice();
      const version = await tracker.record(invoice.id, invoice, CREATOR);

      expect(version.version).toBe(1);
      expect(version.changedBy).toBe(CREATOR);
      expect(version.changeSummary).toBe("Initial version.");
    });

    it("creates sequential version numbers for multiple updates", async () => {
      const invoice = makeInvoice();
      const v1 = await tracker.record(invoice.id, invoice, CREATOR);
      const updated = { ...invoice, memo: "updated memo" };
      const v2 = await tracker.record(invoice.id, updated, CREATOR);
      const updated2 = { ...updated, memo: "second update" };
      const v3 = await tracker.record(invoice.id, updated2, CREATOR);

      expect(v1.version).toBe(1);
      expect(v2.version).toBe(2);
      expect(v3.version).toBe(3);
    });

    it("stores an immutable snapshot (changes to original do not affect stored version)", async () => {
      const invoice = makeInvoice({ memo: "original" });
      await tracker.record(invoice.id, invoice, CREATOR);

      // Mutating original should not affect the snapshot
      (invoice as any).memo = "mutated";

      const history = await tracker.getHistory(invoice.id);
      expect(history[0]!.snapshot.memo).toBe("original");
    });

    it("captures changedAt timestamp close to now", async () => {
      const before = Date.now();
      const invoice = makeInvoice();
      const version = await tracker.record(invoice.id, invoice, CREATOR);
      const after = Date.now();

      expect(version.changedAt.getTime()).toBeGreaterThanOrEqual(before);
      expect(version.changedAt.getTime()).toBeLessThanOrEqual(after);
    });

    it("builds a diff-based change summary for subsequent versions", async () => {
      const invoice = makeInvoice({ memo: undefined });
      await tracker.record(invoice.id, invoice, CREATOR); // v1

      const updated = { ...invoice, memo: "Added memo" };
      const v2 = await tracker.record(invoice.id, updated, CREATOR);

      expect(v2.changeSummary).toContain("memo");
      expect(v2.changeSummary).toContain("Added memo");
    });
  });

  // ── getHistory() ─────────────────────────────────────────────────────────

  describe("getHistory()", () => {
    it("returns empty array when no versions exist", async () => {
      const history = await tracker.getHistory("nonexistent-invoice");
      expect(history).toEqual([]);
    });

    it("returns all versions in ascending order", async () => {
      const invoice = makeInvoice();
      await tracker.record(invoice.id, invoice, CREATOR);
      await tracker.record(invoice.id, { ...invoice, memo: "v2" }, CREATOR);
      await tracker.record(invoice.id, { ...invoice, memo: "v3" }, CREATOR);

      const history = await tracker.getHistory(invoice.id);
      expect(history).toHaveLength(3);
      expect(history.map((v) => v.version)).toEqual([1, 2, 3]);
    });

    it("produces 3 history entries after 3 sequential updates", async () => {
      const invoice = makeInvoice();
      await tracker.record(invoice.id, invoice, CREATOR);
      await tracker.record(invoice.id, { ...invoice, funded: 50_000_000n }, CREATOR);
      await tracker.record(invoice.id, { ...invoice, funded: 100_000_000n }, CREATOR);

      const history = await tracker.getHistory(invoice.id);
      expect(history).toHaveLength(3);
    });
  });

  // ── diff() ───────────────────────────────────────────────────────────────

  describe("diff()", () => {
    it("returns empty changes for diff between identical versions", async () => {
      const invoice = makeInvoice();
      await tracker.record(invoice.id, invoice, CREATOR);
      await tracker.record(invoice.id, { ...invoice }, CREATOR); // identical copy

      const result = await tracker.diff(invoice.id, 1, 2);
      expect(result.hasChanges).toBe(false);
      expect(result.changes).toHaveLength(0);
    });

    it("captures memo change between version 1 and 2", async () => {
      const invoice = makeInvoice();
      await tracker.record(invoice.id, invoice, CREATOR);
      const updated = { ...invoice, memo: "New memo for audit" };
      await tracker.record(invoice.id, updated, CREATOR);

      const result = await tracker.diff(invoice.id, 1, 2);

      expect(result.hasChanges).toBe(true);
      expect(result.changes.some((c) => c.field === "memo")).toBe(true);
    });

    it("captures all intermediate changes between version 1 and 3", async () => {
      const invoice = makeInvoice({ memo: undefined });
      await tracker.record(invoice.id, invoice, CREATOR); // v1

      const v2 = { ...invoice, memo: "Intermediate change" };
      await tracker.record(invoice.id, v2, CREATOR); // v2

      const v3 = {
        ...v2,
        funded: 50_000_000n,
        memo: "Final memo",
      };
      await tracker.record(invoice.id, v3, CREATOR); // v3

      const diff13 = await tracker.diff(invoice.id, 1, 3);

      expect(diff13.fromVersion).toBe(1);
      expect(diff13.toVersion).toBe(3);
      expect(diff13.hasChanges).toBe(true);

      const changedFields = diff13.changes.map((c) => c.field);
      expect(changedFields).toContain("memo");
      expect(changedFields).toContain("funded");
    });

    it("throws when fromVersion does not exist", async () => {
      const invoice = makeInvoice();
      await tracker.record(invoice.id, invoice, CREATOR);

      await expect(tracker.diff(invoice.id, 99, 1)).rejects.toThrow(/Version 99 not found/);
    });

    it("throws when toVersion does not exist", async () => {
      const invoice = makeInvoice();
      await tracker.record(invoice.id, invoice, CREATOR);

      await expect(tracker.diff(invoice.id, 1, 99)).rejects.toThrow(/Version 99 not found/);
    });

    it("can diff non-consecutive versions (1 → 3 skipping 2)", async () => {
      const invoice = makeInvoice();
      await tracker.record(invoice.id, invoice, CREATOR);                       // v1
      await tracker.record(invoice.id, { ...invoice, memo: "skip" }, CREATOR);  // v2
      await tracker.record(invoice.id, { ...invoice, memo: "final" }, CREATOR); // v3

      const result = await tracker.diff(invoice.id, 1, 3);
      expect(result.changes.some((c) => c.field === "memo")).toBe(true);
    });
  });

  // ── getLatest() ───────────────────────────────────────────────────────────

  describe("getLatest()", () => {
    it("returns null when no versions exist", async () => {
      expect(await tracker.getLatest("nonexistent")).toBeNull();
    });

    it("returns the most recent version", async () => {
      const invoice = makeInvoice();
      await tracker.record(invoice.id, invoice, CREATOR);
      await tracker.record(invoice.id, { ...invoice, memo: "v2" }, CREATOR);

      const latest = await tracker.getLatest(invoice.id);
      expect(latest?.version).toBe(2);
    });
  });

  // ── InMemoryVersionStore ──────────────────────────────────────────────────

  describe("InMemoryVersionStore", () => {
    it("can clear all versions for a specific invoice", async () => {
      const store = new InMemoryVersionStore();
      const localTracker = new InvoiceVersionTracker({ store });
      const invoice = makeInvoice();

      await localTracker.record(invoice.id, invoice, CREATOR);
      await localTracker.record(invoice.id, { ...invoice, memo: "v2" }, CREATOR);

      store.clear(invoice.id);

      expect(await localTracker.getHistory(invoice.id)).toHaveLength(0);
    });

    it("keeps other invoices when clearing a specific one", async () => {
      const store = new InMemoryVersionStore();
      const localTracker = new InvoiceVersionTracker({ store });

      const inv1 = makeInvoice({ id: "1001" });
      const inv2 = makeInvoice({ id: "1002" });

      await localTracker.record(inv1.id, inv1, CREATOR);
      await localTracker.record(inv2.id, inv2, CREATOR);

      store.clear(inv1.id);

      expect(await localTracker.getHistory(inv1.id)).toHaveLength(0);
      expect(await localTracker.getHistory(inv2.id)).toHaveLength(1);
    });
  });

  // ── Integration: custom VersionStore ──────────────────────────────────────

  describe("custom VersionStore", () => {
    it("delegates storage operations to the custom store", async () => {
      const customStore: InMemoryVersionStore = new InMemoryVersionStore();
      const appendSpy = vi.spyOn(customStore, "append");
      const getAllSpy = vi.spyOn(customStore, "getAll");

      const localTracker = new InvoiceVersionTracker({ store: customStore });
      const invoice = makeInvoice();

      await localTracker.record(invoice.id, invoice, CREATOR);
      await localTracker.getHistory(invoice.id);

      expect(appendSpy).toHaveBeenCalledTimes(1);
      expect(getAllSpy).toHaveBeenCalledTimes(1);
    });
  });
});
