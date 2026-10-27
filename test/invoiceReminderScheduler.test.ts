import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  InvoiceReminderScheduler,
  DEFAULT_GRACE_PERIOD_MS,
  scheduleReminder,
  cancelReminder,
  getPendingReminders,
  clearAllReminders,
} from "../src/invoiceReminderScheduler.js";
import * as sdkIndex from "../src/index.js";
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

  it("supports cancelReminder, getPendingReminders, and clearAllReminders on InvoiceReminderScheduler instance", async () => {
    scheduler = new InvoiceReminderScheduler(() => DUE_AT);
    const events: ReminderEvent[] = [];
    scheduler.on("invoiceReminderDue", (e) => events.push(e));

    const created = await scheduler.schedule(INVOICE_ID, [60 * 60 * 1000, 30 * 60 * 1000]);
    expect(scheduler.getPendingReminders()).toHaveLength(2);

    const firstId = created[0]!.id;
    const secondId = created[1]!.id;
    expect(scheduler.cancelReminder(firstId)).toBe(true);
    expect(scheduler.cancelReminder(firstId)).toBe(false);
    expect(scheduler.cancelReminder("unknown-id")).toBe(false);

    const pending = scheduler.getPendingReminders();
    expect(pending).toEqual([
      {
        reminderId: secondId,
        invoiceId: INVOICE_ID,
        remindAt: DUE_AT - 30 * 60 * 1000,
      },
    ]);

    vi.advanceTimersByTime(24 * 60 * 60 * 1000 + 1);
    expect(events).toHaveLength(1);
    expect(events[0]!.offsetMs).toBe(30 * 60 * 1000);
    expect(scheduler.cancelReminder(secondId)).toBe(false);

    await scheduler.schedule("inv_456", [10 * 60 * 1000]);
    expect(scheduler.getPendingReminders()).toHaveLength(1);
    scheduler.clearAllReminders();
    expect(scheduler.getPendingReminders()).toEqual([]);
  });
});

describe("scheduleReminder / cancelReminder / getPendingReminders / clearAllReminders (#616)", () => {
  beforeEach(() => {
    clearAllReminders();
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });

  afterEach(() => {
    clearAllReminders();
    vi.useRealTimers();
  });

  it("re-exports reminder helpers from src/index.ts", () => {
    expect(typeof sdkIndex.scheduleReminder).toBe("function");
    expect(typeof sdkIndex.cancelReminder).toBe("function");
    expect(typeof sdkIndex.getPendingReminders).toBe("function");
    expect(typeof sdkIndex.clearAllReminders).toBe("function");
  });

  it("cancelling before fire prevents callback execution and excludes it from getPendingReminders()", () => {
    const callback = vi.fn();
    const remindAt = NOW + 60_000;
    const reminderId = scheduleReminder(INVOICE_ID, remindAt, callback);

    expect(typeof reminderId).toBe("string");
    expect(reminderId.length).toBeGreaterThan(0);
    expect(getPendingReminders()).toEqual([
      { reminderId, invoiceId: INVOICE_ID, remindAt },
    ]);

    expect(cancelReminder(reminderId)).toBe(true);
    expect(getPendingReminders()).toEqual([]);

    vi.advanceTimersByTime(120_000);
    expect(callback).not.toHaveBeenCalled();
  });

  it("returns false when cancelling an unknown ID or an already-cancelled ID", () => {
    const remindAt = NOW + 60_000;
    const reminderId = scheduleReminder(INVOICE_ID, remindAt);

    expect(cancelReminder("non-existent-id")).toBe(false);
    expect(cancelReminder(reminderId)).toBe(true);
    expect(cancelReminder(reminderId)).toBe(false);
  });

  it("returns false when cancelling an already-fired reminder and excludes fired reminders from getPendingReminders()", () => {
    const callback = vi.fn();
    const remindAt = NOW + 30_000;
    const reminderId = scheduleReminder(INVOICE_ID, remindAt, callback);

    vi.advanceTimersByTime(30_000);
    expect(callback).toHaveBeenCalledTimes(1);
    expect(callback).toHaveBeenCalledWith(INVOICE_ID);
    expect(getPendingReminders()).toEqual([]);
    expect(cancelReminder(reminderId)).toBe(false);
  });

  it("clearAllReminders() stops all pending timers and empties getPendingReminders()", () => {
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    scheduleReminder("inv_1", NOW + 10_000, cb1);
    scheduleReminder({ invoiceId: "inv_2", remindAt: NOW + 20_000, callback: cb2 });

    expect(getPendingReminders()).toHaveLength(2);
    clearAllReminders();
    expect(getPendingReminders()).toEqual([]);

    vi.advanceTimersByTime(30_000);
    expect(cb1).not.toHaveBeenCalled();
    expect(cb2).not.toHaveBeenCalled();
  });
});
