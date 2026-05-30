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
