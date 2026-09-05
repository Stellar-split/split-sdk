import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { InvoiceReminderScheduler } from "../src/invoiceReminderScheduler.js";

describe("InvoiceReminderScheduler — cancelReminder / getPendingReminders", () => {
  let scheduler: InvoiceReminderScheduler;

  beforeEach(() => {
    vi.useFakeTimers();
    scheduler = new InvoiceReminderScheduler(() => Date.now() + 10_000, {
      gracePeriodMs: 0,
    });
  });

  afterEach(() => {
    scheduler.destroy();
    vi.useRealTimers();
  });

  it("scheduleReminder returns an opaque reminderId", async () => {
    const id = await scheduler.scheduleReminder("inv-1", 5_000);
    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  it("cancelReminder returns true and prevents the callback from firing", async () => {
    const id = await scheduler.scheduleReminder("inv-1", 5_000);
    const handler = vi.fn();
    scheduler.on("invoiceReminderDue", handler);

    expect(scheduler.cancelReminder(id)).toBe(true);
    vi.advanceTimersByTime(10_000);
    expect(handler).not.toHaveBeenCalled();
  });

  it("cancelReminder returns false for an unknown id", () => {
    expect(scheduler.cancelReminder("unknown-id")).toBe(false);
  });

  it("cancelReminder returns false for an already-fired reminder", async () => {
    const id = await scheduler.scheduleReminder("inv-1", 0);
    const handler = vi.fn();
    scheduler.on("invoiceReminderDue", handler);

    vi.advanceTimersByTime(1);
    expect(handler).toHaveBeenCalledTimes(1);
    expect(scheduler.cancelReminder(id)).toBe(false);
  });

  it("getPendingReminders excludes cancelled reminders", async () => {
    const id1 = await scheduler.scheduleReminder("inv-1", 5_000);
    const id2 = await scheduler.scheduleReminder("inv-2", 6_000);

    scheduler.cancelReminder(id1);

    const pending = scheduler.getPendingReminders();
    expect(pending).toHaveLength(1);
    expect(pending[0].reminderId).toBe(id2);
    expect(pending[0].invoiceId).toBe("inv-2");
    expect(typeof pending[0].remindAt).toBe("number");
  });

  it("getPendingReminders excludes fired reminders", async () => {
    const id = await scheduler.scheduleReminder("inv-1", 0);
    const handler = vi.fn();
    scheduler.on("invoiceReminderDue", handler);

    vi.advanceTimersByTime(1);
    expect(handler).toHaveBeenCalledTimes(1);

    const pending = scheduler.getPendingReminders();
    expect(pending).toHaveLength(0);
  });

  it("clearAllReminders removes everything", async () => {
    await scheduler.scheduleReminder("inv-1", 5_000);
    await scheduler.scheduleReminder("inv-2", 6_000);

    scheduler.clearAllReminders();
    expect(scheduler.getPendingReminders()).toHaveLength(0);
  });
});
