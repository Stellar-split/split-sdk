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
import type { ReminderSchedule, ReminderEvent } from "./types.js";

/**
 * A single reminder offset definition. Offsets are expressed in milliseconds
 * before the invoice due date. An optional `templateId` selects which
 * notification template (see {@link InvoiceReminderSchedulerOptions.notificationTemplates})
 * is used when the reminder is delivered.
 */
export interface ReminderOffsetConfig {
  /** Milliseconds before the due date at which the reminder fires. */
  offsetMs: number;
  /** Optional template id used to render the reminder message. */
  templateId?: string;
  /**
   * Optional recurrence: when set, the reminder repeats every `everyMs`
   * milliseconds starting at `offsetMs` before the due date, up to
   * `count` occurrences (inclusive of the first). Defaults to a single fire.
   */
  recurrence?: {
    everyMs: number;
    count: number;
  };
}

/** A rendered reminder message ready for delivery. */
export interface ReminderMessage {
  /** Stable idempotency key for this reminder occurrence. */
  idempotencyKey: string;
  invoiceId: string;
  offsetMs: number;
  dueAt: number;
  /** Rendered subject line. */
  subject: string;
  /** Rendered body text. */
  body: string;
}

/** A template used to render reminder messages. */
export interface ReminderTemplate {
  subject: string;
  body: string;
}

/** Minimal notification-center contract used for reminder delivery. */
export interface ReminderNotificationCenter {
  send(message: ReminderMessage): Promise<void> | void;
}

/** Delivery record persisted for tracking sent reminders. */
export interface ReminderDeliveryRecord {
  idempotencyKey: string;
  invoiceId: string;
  offsetMs: number;
  dueAt: number;
  /** Unix ms timestamp when delivery succeeded. */
  deliveredAt: number;
  templateId?: string;
}

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
  /**
   * Default offsets (ms before due date) applied when `schedule` is called
   * without explicit offsets. Supports recurrence via {@link ReminderOffsetConfig}.
   */
  defaultOffsets?: Array<number | ReminderOffsetConfig>;
  /**
   * Named message templates keyed by template id. The reserved id `"default"`
   * is used when a reminder does not specify a template.
   */
  notificationTemplates?: Record<string, ReminderTemplate>;
  /**
   * Notification center used to deliver reminders. When omitted, reminders
   * are only emitted as events (no delivery).
   */
  notificationCenter?: ReminderNotificationCenter;
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
  private readonly defaultOffsets: ReminderOffsetConfig[];
  private readonly templates: Record<string, ReminderTemplate>;
  private readonly notificationCenter?: ReminderNotificationCenter;
  private readonly deliveries = new Map<string, ReminderDeliveryRecord>();

  constructor(getDueAt: InvoiceDueAtResolver, options: InvoiceReminderSchedulerOptions = {}) {
    super();
    this.getDueAt = getDueAt;
    this.gracePeriodMs = options.gracePeriodMs ?? DEFAULT_GRACE_PERIOD_MS;
    this.defaultOffsets = (options.defaultOffsets ?? []).map((o) =>
      typeof o === "number" ? { offsetMs: o } : o,
    );
    this.templates = options.notificationTemplates ?? {};
    this.notificationCenter = options.notificationCenter;
    this.schedules = loadReminderSchedules();

    for (const entry of this.schedules) {
      if (entry.status === "pending") this._arm(entry);
    }
  }

  /**
   * Register reminders at each offset (ms before the invoice's due date).
   * Persists the schedule immediately so it survives a restart.
   */
  async schedule(
    invoiceId: string,
    offsets?: Array<number | ReminderOffsetConfig>,
  ): Promise<ReminderSchedule[]> {
    const dueAt = await this.getDueAt(invoiceId);
    const configs = (offsets ?? this.defaultOffsets).map((o) =>
      typeof o === "number" ? { offsetMs: o } : o,
    );
    const created: ReminderSchedule[] = [];

    for (const config of configs) {
      const occurrences = config.recurrence?.count ?? 1;
      const everyMs = config.recurrence?.everyMs ?? 0;
      for (let i = 0; i < occurrences; i++) {
        const offsetMs = config.offsetMs + i * everyMs;
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

  /** Return the current set of reminder schedules (all invoices, all statuses). */
  list(): ReminderSchedule[] {
    return [...this.schedules];
  }

  /** Return delivery records for tracking sent reminders. */
  listDeliveries(): ReminderDeliveryRecord[] {
    return [...this.deliveries.values()];
  }

  /** Return the delivery record for a given idempotency key, if any. */
  getDelivery(idempotencyKey: string): ReminderDeliveryRecord | undefined {
    return this.deliveries.get(idempotencyKey);
  }

  /** Build the stable idempotency key for a reminder occurrence. */
  private _idempotencyKey(entry: ReminderSchedule): string {
    return `${entry.invoiceId}:${entry.offsetMs}:${entry.dueAt}`;
  }

  /** Render a reminder message using the configured template. */
  private _render(entry: ReminderSchedule, templateId?: string): ReminderMessage {
    const template =
      (templateId && this.templates[templateId]) ||
      this.templates["default"] || {
        subject: "Payment reminder",
        body: "Invoice {{invoiceId}} is due at {{dueAt}}.",
      };
    const vars: Record<string, string> = {
      invoiceId: entry.invoiceId,
      offsetMs: String(entry.offsetMs),
      dueAt: String(entry.dueAt),
    };
    const interpolate = (text: string): string =>
      text.replace(/\{\{\s*(\w+)\s*\}\}/g, (_, key: string) => vars[key] ?? "");
    return {
      idempotencyKey: this._idempotencyKey(entry),
      invoiceId: entry.invoiceId,
      offsetMs: entry.offsetMs,
      dueAt: entry.dueAt,
      subject: interpolate(template.subject),
      body: interpolate(template.body),
    };
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

    const idempotencyKey = this._idempotencyKey(live);
    // Deduplicate: never deliver the same reminder occurrence twice.
    if (this.deliveries.has(idempotencyKey)) {
      live.status = "fired";
      this._persist();
      return;
    }

    live.status = "fired";
    this._persist();
    this.emit("invoiceReminderDue", {
      invoiceId: live.invoiceId,
      offsetMs: live.offsetMs,
      dueAt: live.dueAt,
    });

    const message = this._render(live);
    if (this.notificationCenter) {
      void Promise.resolve(this.notificationCenter.send(message))
        .then(() => {
          this.deliveries.set(idempotencyKey, {
            idempotencyKey,
            invoiceId: live.invoiceId,
            offsetMs: live.offsetMs,
            dueAt: live.dueAt,
            deliveredAt: Date.now(),
          });
        })
        .catch(() => {
          /* delivery failures are surfaced via the notification center */
        });
    }
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
