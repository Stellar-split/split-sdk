import { randomUUID } from "crypto";

export interface ScheduledPayment {
  id: string;
  invoiceId: string;
  amount: bigint;
  executeAt: number;
  status: "pending" | "executed" | "failed";
}

type PayFn = (invoiceId: string, amount: bigint) => Promise<void>;

const STORAGE_KEY = "stellar_split_scheduled_payments";

function serialize(payments: ScheduledPayment[]): string {
  return JSON.stringify(payments.map((p) => ({ ...p, amount: p.amount.toString() })));
}

function deserialize(raw: string): ScheduledPayment[] {
  return (JSON.parse(raw) as Array<Omit<ScheduledPayment, "amount"> & { amount: string }>).map(
    (p) => ({ ...p, amount: BigInt(p.amount) })
  );
}

function load(): ScheduledPayment[] {
  try {
    if (typeof localStorage !== "undefined") {
      const raw = localStorage.getItem(STORAGE_KEY);
      return raw ? deserialize(raw) : [];
    }
  } catch { /* no-op */ }
  return [];
}

function save(payments: ScheduledPayment[]): void {
  try {
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(STORAGE_KEY, serialize(payments));
    }
  } catch { /* no-op */ }
}

// ---------------------------------------------------------------------------
// Generic job scheduler — recurring (interval) jobs and one-shot jobs
// (issue #685).
// ---------------------------------------------------------------------------

/** Handle returned by `schedule`/`once`, allowing the caller to cancel the job. */
export interface JobHandle {
  id: string;
  cancel: () => void;
}

interface RecurringJob {
  id: string;
  intervalMs: number;
  fn: () => void | Promise<void>;
  timer: ReturnType<typeof setInterval>;
}

interface OneShotJob {
  id: string;
  fn: () => void | Promise<void>;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Lightweight in-process job scheduler supporting both recurring
 * (interval-based) jobs via `schedule()` and one-shot, run-once-after-a-delay
 * jobs via `once()`. The two APIs coexist and share the same job list.
 */
export class JobScheduler {
  private _recurring = new Map<string, RecurringJob>();
  private _oneShot = new Map<string, OneShotJob>();

  /** Schedule a recurring job that runs every `intervalMs` milliseconds. */
  schedule(intervalMs: number, fn: () => void | Promise<void>): JobHandle {
    const id = randomUUID();
    const timer = setInterval(() => {
      void fn();
    }, intervalMs);
    this._recurring.set(id, { id, intervalMs, fn, timer });

    return {
      id,
      cancel: () => this._cancelRecurring(id),
    };
  }

  /**
   * Schedule a job to run exactly once, `delayMs` milliseconds from now.
   * Once it runs (or is cancelled), the job is removed from the scheduler's
   * internal job list.
   */
  once(delayMs: number, fn: () => void | Promise<void>): JobHandle {
    const id = randomUUID();
    const timer = setTimeout(() => {
      this._oneShot.delete(id);
      void fn();
    }, delayMs);
    this._oneShot.set(id, { id, fn, timer });

    return {
      id,
      cancel: () => this._cancelOneShot(id),
    };
  }

  /** Cancel a job (recurring or one-shot) by id. No-op if it no longer exists. */
  cancel(id: string): void {
    this._cancelRecurring(id);
    this._cancelOneShot(id);
  }

  /** Number of jobs currently scheduled (recurring + pending one-shot). */
  get jobCount(): number {
    return this._recurring.size + this._oneShot.size;
  }

  /** Cancel every scheduled job. */
  clear(): void {
    for (const id of [...this._recurring.keys()]) this._cancelRecurring(id);
    for (const id of [...this._oneShot.keys()]) this._cancelOneShot(id);
  }

  private _cancelRecurring(id: string): void {
    const job = this._recurring.get(id);
    if (!job) return;
    clearInterval(job.timer);
    this._recurring.delete(id);
  }

  private _cancelOneShot(id: string): void {
    const job = this._oneShot.get(id);
    if (!job) return;
    clearTimeout(job.timer);
    this._oneShot.delete(id);
  }
}

export class ScheduledPaymentManager {
  private _payments: ScheduledPayment[] = load();
  private _timers = new Map<string, ReturnType<typeof setTimeout>>();
  private _pay: PayFn;

  constructor(pay: PayFn) {
    this._pay = pay;
    for (const p of this._payments.filter((p) => p.status === "pending")) {
      this._arm(p);
    }
  }

  schedule(invoiceId: string, amount: bigint, executeAt: number): string {
    const id = randomUUID();
    const entry: ScheduledPayment = { id, invoiceId, amount, executeAt, status: "pending" };
    this._payments.push(entry);
    save(this._payments);
    this._arm(entry);
    return id;
  }

  cancel(scheduleId: string): void {
    const entry = this._payments.find((p) => p.id === scheduleId);
    if (!entry || entry.status !== "pending") return;
    const timer = this._timers.get(scheduleId);
    if (timer !== undefined) clearTimeout(timer);
    this._timers.delete(scheduleId);
    entry.status = "failed";
    save(this._payments);
  }

  list(): ScheduledPayment[] {
    return [...this._payments];
  }

  private _arm(entry: ScheduledPayment): void {
    const delayMs = Math.max(0, entry.executeAt * 1000 - Date.now());
    const timer = setTimeout(async () => {
      this._timers.delete(entry.id);
      const live = this._payments.find((p) => p.id === entry.id);
      if (!live || live.status !== "pending") return;
      try {
        await this._pay(live.invoiceId, live.amount);
        live.status = "executed";
      } catch {
        live.status = "failed";
      }
      save(this._payments);
    }, delayMs);
    this._timers.set(entry.id, timer);
  }
}
