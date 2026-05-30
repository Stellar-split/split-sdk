import { EventEmitter } from "events";
import type { Invoice, Payment } from "./types.js";

type NotificationEvent =
  | "payment"
  | "released"
  | "refunded"
  | "expiring"
  | "expired";

export class NotificationCenter extends EventEmitter {
  private _watchers = new Map<string, NodeJS.Timeout>();
  private _fetchInvoice: (invoiceId: string) => Promise<Invoice>;

  constructor(fetchInvoice: (invoiceId: string) => Promise<Invoice>) {
    super();
    this._fetchInvoice = fetchInvoice;
  }

  watch(invoiceId: string, intervalMs = 1000): void {
    if (this._watchers.has(invoiceId)) return;
    let lastFunded = 0n;
    const timer = setInterval(async () => {
      try {
        const inv = await this._fetchInvoice(invoiceId);
        if (inv.funded > lastFunded) {
          const payment: Payment = inv.payments[inv.payments.length - 1]!;
          lastFunded = inv.funded;
          this.emit("payment", invoiceId, payment);
        }
        if (inv.status === "Released") this.emit("released", invoiceId);
        if (inv.status === "Refunded") this.emit("refunded", invoiceId);
        const secondsLeft = inv.deadline - Math.floor(Date.now() / 1000);
        if (secondsLeft <= 60 && secondsLeft > 0) this.emit("expiring", invoiceId, secondsLeft);
        if (secondsLeft <= 0) this.emit("expired", invoiceId);
      } catch {
        // ignore fetch errors
      }
    }, intervalMs);
    this._watchers.set(invoiceId, timer);
  }

  unwatch(invoiceId: string): void {
    const t = this._watchers.get(invoiceId);
    if (!t) return;
    clearInterval(t);
    this._watchers.delete(invoiceId);
  }

  on(event: NotificationEvent, listener: (...args: unknown[]) => void): this {
    return super.on(event, listener);
  }
}
