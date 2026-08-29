/**
 * Invoice due-date reminder scheduler for StellarSplit.
 *
 * Registers reminders at configurable offsets before an invoice's due date
 * and fires a typed event when each one comes due. Schedules are persisted
 * (see {@link ../snapshot.js}) so reminders survive process restarts —
 * on construction, any pending reminder whose fire time has already passed
 * is either fired immediately (when still within the configurable grace
 * period) or marked `expired` (when the process was down too long for the
 * reminder to still be meaningful).
 *
 * Follows the same persist-then-arm-timer approach as {@link ../scheduler.js}
 * (`ScheduledPaymentManager`), and the typed-event-emitter pattern used by
 * {@link ../sep/sep24Handler.js}.
 */

import { randomUUID } from "crypto";
import { TypedEventEmitter } from "./events/TypedEventEmitter.js";
import { loadReminderSchedules, saveReminderSchedules } from "./snapshot.js";
import type { ReminderSchedule, ReminderEvent, PendingReminder } from "./types.js";

export type { PendingReminder };

/** Events emitted by {@link InvoiceReminderScheduler}. */
export interface InvoiceReminderSchedulerEventMap {
  invoiceReminderDue: ReminderEvent;
  [key: string]: unknown;
}

/**
 * Resolves the Unix timestamp (milliseconds) an invoice is due.
 * May be async since the due date typically comes from a contract read or DB lookup.
 */
export type InvoiceDueAtResolver = (invoiceId: string) => Promise<number> | number;

export interface InvoiceReminderSchedulerOptions {
  /**
   * How long (ms) after a reminder's scheduled fire time it is still
   * considered current on startup recovery. Reminders discovered further in
   * the past than this are marked `expired` instead of fired.
   * Defaults to 60 000 ms (60s).
   */
  gracePeriodMs?: number;
}

/** Default grace period for firing missed reminders after a restart. */
export const DEFAULT_GRACE_PERIOD_MS = 60_000;

/**
 * Schedules and fires due-date reminders for invoices.
 *
 * @example
 * ```typescript
 * const scheduler = new InvoiceReminderScheduler((invoiceId) => invoice.dueAt);
 * scheduler.on("invoiceReminderDue", ({ invoiceId, offsetMs }) => {
 *   notifyRecipient(invoiceId, offsetMs);
 * });
 * await scheduler.schedule("inv_123", [7 * 24 * 60 * 60 * 1000, 24 * 60 * 60 * 1000, 60 * 60 * 1000]);
 * ```
 */
export class InvoiceReminderScheduler extends TypedEventEmitter<InvoiceReminderSchedulerEventMap> {
  private schedules: ReminderSchedule[];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly getDueAt: InvoiceDueAtResolver;
  private readonly gracePeriodMs: number;

  constructor(getDueAt: InvoiceDueAtResolver, options: InvoiceReminderSchedulerOptions = {}) {
    super();
    this.getDueAt = getDueAt;
    this.gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
    this.schedules = loadReminderSchedules();

    for (const entry of this.schedules) {
      if (entry.status === "pending") this._arm(entry);
    }
  }

  /**
   * Register reminders at each offset (ms before the invoice's due date).
   * Persists the schedule immediately so it survives a restart.
   */
  async schedule(invoiceId: string, offsets: number[]): Promise<ReminderSchedule[]> {
    const dueAt = await this.getDueAt(invoiceId);
    const created: ReminderSchedule[] = [];

    for (const offsetMs of offsets) {
      const entry: ReminderSchedule = {
        id: randomUUID(),
        invoiceId,
        offsetMs,
        dueAt,
        fireAt: dueAt - offsetMs,
        status: "pending",
      };
      this.schedules.push(entry);
      created.push(entry);
      this._arm(entry);
    }

    this._persist();
    return created;
  }

  /** Remove all pending reminders for an invoice from the store. */
  cancel(invoiceId: string): void {
    const cancelled = this.schedules.filter(
      (s) => s.invoiceId === invoiceId && s.status === "pending",
    );
    for (const entry of cancelled) {
      const timer = this.timers.get(entry.id);
      if (timer !== undefined) clearTimeout(timer);
      this.timers.delete(entry.id);
    }
    if (cancelled.length === 0) return;

    const cancelledIds = new Set(cancelled.map((c) => c.id));
    this.schedules = this.schedules.map((s) =>
      cancelledIds.has(s.id) ? { ...s, status: "cancelled" as const } : s,
    );
    this._persist();
  }

  /**
   * Cancel a specific reminder by its unique reminderId.
   *
   * @param reminderId - Unique ID of the reminder to cancel
   * @returns true if the reminder was pending and successfully cancelled;
   *          false if the ID is unknown or already fired.
   */
  cancelReminder(reminderId: string): boolean {
    const entry = this.schedules.find((s) => s.id === reminderId);
    if (!entry || entry.status !== "pending") return false;
    const timer = this.timers.get(reminderId);
    if (timer !== undefined) clearTimeout(timer);
    this.timers.delete(reminderId);
    entry.status = "cancelled";
    this._persist();
    return true;
  }

  /**
   * Return all not-yet-fired, not-cancelled reminders for this scheduler instance.
   */
  getPendingReminders(): PendingReminder[] {
    return this.schedules
      .filter((s) => s.status === "pending")
      .map((s) => ({
        reminderId: s.id,
        invoiceId: s.invoiceId,
        remindAt: s.fireAt,
      }));
  }

  /**
   * Clear all pending reminders, stopping all timers and clearing persisted state.
   */
  clearAllReminders(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.schedules = [];
    this._persist();
  }

  /** Return the current set of reminder schedules (all invoices, all statuses). */
  list(): ReminderSchedule[] {
    return [...this.schedules];
  }

  /** Stop all pending timers and detach listeners. Does not clear persisted state. */
  destroy(): void {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    this.removeAllListeners();
  }

  /**
   * Arm a timer for `entry`. Reminders already due (delay <= 0, e.g. loaded
   * from storage after a restart) are deferred via `setTimeout(fn, 0)` so
   * that callers get a chance to attach `on("invoiceReminderDue", ...)`
   * listeners before the event can fire.
   */
  private _arm(entry: ReminderSchedule): void {
    const delayMs = Math.max(0, entry.fireAt - Date.now());
    const timer = setTimeout(() => {
      this.timers.delete(entry.id);
      const overdueBy = Date.now() - entry.fireAt;
      if (overdueBy > this.gracePeriodMs) {
        this._expire(entry.id);
      } else {
        this._fire(entry.id);
      }
    }, delayMs);
    this.timers.set(entry.id, timer);
  }

  private _fire(id: string): void {
    const live = this.schedules.find((s) => s.id === id);
    if (!live || live.status !== "pending") return;
    live.status = "fired";
    this._persist();
    this.emit("invoiceReminderDue", {
      invoiceId: live.invoiceId,
      offsetMs: live.offsetMs,
      dueAt: live.dueAt,
    });
  }

  private _expire(id: string): void {
    const live = this.schedules.find((s) => s.id === id);
    if (!live || live.status !== "pending") return;
    live.status = "expired";
    this._persist();
  }

  private _persist(): void {
    saveReminderSchedules(this.schedules);
  }
}

// ---------------------------------------------------------------------------
// Standalone / Direct Module-Level Reminder API
// ---------------------------------------------------------------------------

/** Options for scheduling a reminder. */
export interface ScheduleReminderOptions {
  invoiceId: string;
  remindAt: number;
  callback?: () => void | Promise<void>;
}

interface StandaloneReminderEntry {
  reminderId: string;
  invoiceId: string;
  remindAt: number;
  status: "pending" | "fired" | "cancelled";
  timer?: ReturnType<typeof setTimeout>;
  callback?: () => void | Promise<void>;
}

const activeStandaloneReminders = new Map<string, StandaloneReminderEntry>();

/**
 * Schedules a reminder to fire at `remindAt` (Unix timestamp in milliseconds).
 *
 * @param invoiceIdOrOptions - Invoice identifier or an options object
 * @param remindAt - Unix timestamp (ms) when the reminder should fire
 * @param callback - Optional callback executed when the reminder fires
 * @returns reminderId - Opaque unique identifier for the reminder
 */
export function scheduleReminder(
  invoiceIdOrOptions: string | ScheduleReminderOptions,
  remindAt?: number,
  callback?: () => void | Promise<void>,
): string {
  let invoiceId: string;
  let targetRemindAt: number;
  let targetCallback: (() => void | Promise<void>) | undefined;

  if (typeof invoiceIdOrOptions === "object" && invoiceIdOrOptions !== null) {
    invoiceId = invoiceIdOrOptions.invoiceId;
    targetRemindAt = invoiceIdOrOptions.remindAt;
    targetCallback = invoiceIdOrOptions.callback;
  } else {
    invoiceId = invoiceIdOrOptions;
    targetRemindAt = remindAt!;
    targetCallback = callback;
  }

  const reminderId = randomUUID();
  const delayMs = Math.max(0, targetRemindAt - Date.now());

  const entry: StandaloneReminderEntry = {
    reminderId,
    invoiceId,
    remindAt: targetRemindAt,
    status: "pending",
    callback: targetCallback,
  };

  const timer = setTimeout(async () => {
    if (entry.status !== "pending") return;
    entry.status = "fired";
    entry.timer = undefined;
    if (entry.callback) {
      try {
        await entry.callback();
      } catch {
        /* prevent unhandled rejection from bubbling to timer loop */
      }
    }
  }, delayMs);

  entry.timer = timer;
  activeStandaloneReminders.set(reminderId, entry);
  return reminderId;
}

/**
 * Cancels a reminder by its reminderId.
 *
 * @param reminderId - Unique ID of the reminder to cancel
 * @returns true if reminder was pending and cancelled; false if unknown or already fired
 */
export function cancelReminder(reminderId: string): boolean {
  const entry = activeStandaloneReminders.get(reminderId);
  if (!entry || entry.status !== "pending") {
    return false;
  }
  if (entry.timer !== undefined) {
    clearTimeout(entry.timer);
    entry.timer = undefined;
  }
  entry.status = "cancelled";
  return true;
}

/**
 * Returns all not-yet-fired, not-cancelled reminders.
 */
export function getPendingReminders(): PendingReminder[] {
  const pending: PendingReminder[] = [];
  for (const entry of activeStandaloneReminders.values()) {
    if (entry.status === "pending") {
      pending.push({
        reminderId: entry.reminderId,
        invoiceId: entry.invoiceId,
        remindAt: entry.remindAt,
      });
    }
  }
  return pending;
}

/**
 * Cancels all pending reminders and clears scheduler state (for test teardown).
 */
export function clearAllReminders(): void {
  for (const entry of activeStandaloneReminders.values()) {
    if (entry.timer !== undefined) {
      clearTimeout(entry.timer);
      entry.timer = undefined;
    }
  }
  activeStandaloneReminders.clear();
}
