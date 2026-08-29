import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  InvoiceReminderScheduler,
  DEFAULT_GRACE_PERIOD_MS,
} from "../src/invoiceReminderScheduler.js";
import { loadReminderSchedules } from "../src/snapshot.js";
import type { ReminderEvent } from "../src/types.js";

const INVOICE_ID = "inv_123";
const NOW = 1_700_000_000_000;
const DUE_AT = NOW + 24 * 60 * 60 * 1000; // due in 24h

describe("InvoiceReminderScheduler", () => {
  let scheduler: InvoiceReminderScheduler | null = null;

  beforeEach(() => {
    localStorage.clear();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    scheduler?.destroy();
    scheduler = null;
    vi.useRealTimers();
  });

  it("registers a reminder per offset and persists the schedule", async () => {
    scheduler = new InvoiceReminderScheduler(() => DUE_AT);

    const offsets = [60 * 60 * 1000, 10 * 60 * 1000];
    const created = await scheduler.schedule(INVOICE_ID, offsets);

    expect(created).toHaveLength(2);
    expect(created.map((r) => r.offsetMs).sort()).toEqual(offsets.slice().sort());
    for (const entry of created) {
      expect(entry.invoiceId).toBe(INVOICE_ID);
      expect(entry.dueAt).toBe(DUE_AT);
      expect(entry.fireAt).toBe(DUE_AT - entry.offsetMs);
      expect(entry.status).toBe("pending");
    }

    const persisted = loadReminderSchedules();
    expect(persisted).toHaveLength(2);
  });

  it("emits invoiceReminderDue with { invoiceId, offsetMs, dueAt } when a reminder fires", async () => {
    scheduler = new InvoiceReminderScheduler(() => DUE_AT);
    const events: ReminderEvent[] = [];
    scheduler.on("invoiceReminderDue", (e) => events.push(e));

    const offsetMs = 60 * 60 * 1000; // 1h before due
    await scheduler.schedule(INVOICE_ID, [offsetMs]);

    // Not due yet.
    vi.advanceTimersByTime(DUE_AT - offsetMs - NOW - 1);
    expect(events).toHaveLength(0);

    // Reaches fire time.
    vi.advanceTimersByTime(1);
    expect(events).toEqual([{ invoiceId: INVOICE_ID, offsetMs, dueAt: DUE_AT }]);

    const persisted = loadReminderSchedules();
    expect(persisted[0]!.status).toBe("fired");
  });

  it("cancel() removes all pending reminders for an invoice and stops their timers", async () => {
    scheduler = new InvoiceReminderScheduler(() => DUE_AT);
    const events: ReminderEvent[] = [];
    scheduler.on("invoiceReminderDue", (e) => events.push(e));

    await scheduler.schedule(INVOICE_ID, [60 * 60 * 1000, 30 * 60 * 1000]);
    scheduler.cancel(INVOICE_ID);

    expect(scheduler.list().every((s) => s.invoiceId !== INVOICE_ID || s.status === "cancelled")).toBe(true);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    expect(events).toHaveLength(0);

    const persisted = loadReminderSchedules();
    expect(persisted.every((s) => s.status === "cancelled")).toBe(true);
  });

  it("on startup, fires reminders that are past due but within the grace period", async () => {
    const fireAt = NOW - 5_000; // 5s ago, well within the 60s default grace period
    localStorage.setItem(
      "stellar_split_reminder_schedules",
      JSON.stringify([
        {
          id: "r1",
          invoiceId: INVOICE_ID,
          offsetMs: 60_000,
          dueAt: fireAt + 60_000,
          fireAt,
          status: "pending",
        },
      ]),
    );

    scheduler = new InvoiceReminderScheduler(() => DUE_AT);
    const events: ReminderEvent[] = [];
    scheduler.on("invoiceReminderDue", (e) => events.push(e));

    // Recovery fire is deferred via setTimeout(0) so listeners can attach first.
    expect(events).toHaveLength(0);
    vi.advanceTimersByTime(0);

    expect(events).toEqual([{ invoiceId: INVOICE_ID, offsetMs: 60_000, dueAt: fireAt + 60_000 }]);
  });

  it("on startup, marks reminders past the grace period as expired without firing them", async () => {
    const fireAt = NOW - (DEFAULT_GRACE_PERIOD_MS + 5_000); // well outside the grace window
    localStorage.setItem(
      "stellar_split_reminder_schedules",
      JSON.stringify([
        {
          id: "r1",
          invoiceId: INVOICE_ID,
          offsetMs: 60_000,
          dueAt: fireAt + 60_000,
          fireAt,
          status: "pending",
        },
      ]),
    );

    scheduler = new InvoiceReminderScheduler(() => DUE_AT);
    const events: ReminderEvent[] = [];
    scheduler.on("invoiceReminderDue", (e) => events.push(e));

    vi.advanceTimersByTime(0);

    expect(events).toHaveLength(0);
    expect(scheduler.list()[0]!.status).toBe("expired");
  });

  it("respects a custom gracePeriodMs", async () => {
    const fireAt = NOW - 10_000;
    localStorage.setItem(
      "stellar_split_reminder_schedules",
      JSON.stringify([
        { id: "r1", invoiceId: INVOICE_ID, offsetMs: 1000, dueAt: fireAt + 1000, fireAt, status: "pending" },
      ]),
    );

    scheduler = new InvoiceReminderScheduler(() => DUE_AT, { gracePeriodMs: 5_000 });
    const events: ReminderEvent[] = [];
    scheduler.on("invoiceReminderDue", (e) => events.push(e));

    vi.advanceTimersByTime(0);

    expect(events).toHaveLength(0);
    expect(scheduler.list()[0]!.status).toBe("expired");
  });

  describe("cancelReminder and getPendingReminders (instance methods)", () => {
    it("cancels a specific reminder by ID and prevents its event from firing", async () => {
      scheduler = new InvoiceReminderScheduler(() => DUE_AT);
      const events: ReminderEvent[] = [];
      scheduler.on("invoiceReminderDue", (e) => events.push(e));

      const schedules = await scheduler.schedule(INVOICE_ID, [60 * 60 * 1000, 30 * 60 * 1000]);
      const [first, second] = schedules;

      const cancelRes = scheduler.cancelReminder(first.id);
      expect(cancelRes).toBe(true);

      const pending = scheduler.getPendingReminders();
      expect(pending).toHaveLength(1);
      expect(pending[0].reminderId).toBe(second.id);
      expect(pending[0].invoiceId).toBe(INVOICE_ID);
      expect(pending[0].remindAt).toBe(second.fireAt);

      // Advance past both reminder times
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);

      // Only the second uncancelled reminder should have fired
      expect(events).toHaveLength(1);
      expect(events[0].offsetMs).toBe(second.offsetMs);
    });

    it("returns false when cancelling unknown ID or already-fired reminder", async () => {
      scheduler = new InvoiceReminderScheduler(() => DUE_AT);
      expect(scheduler.cancelReminder("non_existent_id")).toBe(false);

      const [reminder] = await scheduler.schedule(INVOICE_ID, [60 * 60 * 1000]);
      vi.advanceTimersByTime(24 * 60 * 60 * 1000);

      expect(scheduler.cancelReminder(reminder.id)).toBe(false);
    });

    it("clearAllReminders() cancels all pending reminders on the instance", async () => {
      scheduler = new InvoiceReminderScheduler(() => DUE_AT);
      const events: ReminderEvent[] = [];
      scheduler.on("invoiceReminderDue", (e) => events.push(e));

      await scheduler.schedule(INVOICE_ID, [60 * 60 * 1000, 30 * 60 * 1000]);
      expect(scheduler.getPendingReminders()).toHaveLength(2);

      scheduler.clearAllReminders();
      expect(scheduler.getPendingReminders()).toHaveLength(0);

      vi.advanceTimersByTime(24 * 60 * 60 * 1000);
      expect(events).toHaveLength(0);
    });
  });
});

describe("Direct module-level reminder functions", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(async () => {
    const { clearAllReminders } = await import("../src/invoiceReminderScheduler.js");
    clearAllReminders();
    vi.useRealTimers();
  });

  it("scheduleReminder returns a unique reminderId", async () => {
    const { scheduleReminder } = await import("../src/invoiceReminderScheduler.js");
    const id1 = scheduleReminder(INVOICE_ID, NOW + 10_000);
    const id2 = scheduleReminder(INVOICE_ID, NOW + 20_000);

    expect(typeof id1).toBe("string");
    expect(typeof id2).toBe("string");
    expect(id1).not.toBe(id2);
    expect(id1.length).toBeGreaterThan(0);
  });

  it("cancel before fire prevents callback and returns true", async () => {
    const { scheduleReminder, cancelReminder } = await import("../src/invoiceReminderScheduler.js");
    let called = false;
    const reminderId = scheduleReminder(INVOICE_ID, NOW + 5_000, () => {
      called = true;
    });

    const result = cancelReminder(reminderId);
    expect(result).toBe(true);

    vi.advanceTimersByTime(10_000);
    expect(called).toBe(false);
  });

  it("cancel unknown ID returns false", async () => {
    const { cancelReminder } = await import("../src/invoiceReminderScheduler.js");
    const result = cancelReminder("unknown_id_xyz");
    expect(result).toBe(false);
  });

  it("cancel already-fired returns false", async () => {
    const { scheduleReminder, cancelReminder } = await import("../src/invoiceReminderScheduler.js");
    let called = false;
    const reminderId = scheduleReminder(INVOICE_ID, NOW + 5_000, () => {
      called = true;
    });

    vi.advanceTimersByTime(6_000);
    expect(called).toBe(true);

    const result = cancelReminder(reminderId);
    expect(result).toBe(false);
  });

  it("cancel already-cancelled returns false", async () => {
    const { scheduleReminder, cancelReminder } = await import("../src/invoiceReminderScheduler.js");
    const reminderId = scheduleReminder(INVOICE_ID, NOW + 5_000);

    expect(cancelReminder(reminderId)).toBe(true);
    expect(cancelReminder(reminderId)).toBe(false);
  });

  it("getPendingReminders excludes cancelled and fired reminders", async () => {
    const { scheduleReminder, cancelReminder, getPendingReminders } = await import(
      "../src/invoiceReminderScheduler.js"
    );

    const id1 = scheduleReminder("inv_1", NOW + 5_000);
    const id2 = scheduleReminder("inv_2", NOW + 10_000);
    const id3 = scheduleReminder("inv_3", NOW + 15_000);

    const initialPending = getPendingReminders();
    expect(initialPending).toHaveLength(3);
    expect(initialPending).toContainEqual({ reminderId: id1, invoiceId: "inv_1", remindAt: NOW + 5_000 });
    expect(initialPending).toContainEqual({ reminderId: id2, invoiceId: "inv_2", remindAt: NOW + 10_000 });
    expect(initialPending).toContainEqual({ reminderId: id3, invoiceId: "inv_3", remindAt: NOW + 15_000 });

    // Cancel id2
    cancelReminder(id2);
    const afterCancel = getPendingReminders();
    expect(afterCancel).toHaveLength(2);
    expect(afterCancel.some((r) => r.reminderId === id2)).toBe(false);

    // Fire id1
    vi.advanceTimersByTime(6_000);
    const afterFire = getPendingReminders();
    expect(afterFire).toHaveLength(1);
    expect(afterFire[0].reminderId).toBe(id3);
  });

  it("clearAllReminders cancels all pending reminders and prevents callbacks", async () => {
    const { scheduleReminder, clearAllReminders, getPendingReminders } = await import(
      "../src/invoiceReminderScheduler.js"
    );

    let called1 = false;
    let called2 = false;

    scheduleReminder("inv_1", NOW + 5_000, () => {
      called1 = true;
    });
    scheduleReminder("inv_2", NOW + 10_000, () => {
      called2 = true;
    });

    expect(getPendingReminders()).toHaveLength(2);

    clearAllReminders();
    expect(getPendingReminders()).toHaveLength(0);

    vi.advanceTimersByTime(20_000);
    expect(called1).toBe(false);
    expect(called2).toBe(false);
  });

  it("functions and types are accessible from module export", async () => {
    const exports = await import("../src/invoiceReminderScheduler.js");
    expect(typeof exports.scheduleReminder).toBe("function");
    expect(typeof exports.cancelReminder).toBe("function");
    expect(typeof exports.getPendingReminders).toBe("function");
    expect(typeof exports.clearAllReminders).toBe("function");
    expect(typeof exports.InvoiceReminderScheduler).toBe("function");
    expect(typeof exports.DEFAULT_GRACE_PERIOD_MS).toBe("number");
  });
});
