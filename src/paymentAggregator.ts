import { createHash } from "crypto";
import type { Invoice, Payment } from "./types.js";

export type PaymentLedger = Payment & { ledger: number };

export interface PaymentSummary {
  totalFunded: bigint;
  percentFunded: number;
  payerBreakdown: Map<string, bigint>;
  paymentCount: number;
  lastLedger: number;
}

export interface TopPayer {
  address: string;
  amount: bigint;
}

export interface PaymentSnapshotPayer {
  address: string;
  amount: string;
}

export interface PaymentSnapshotPayment {
  payer: string;
  amount: string;
  ledger: number;
  timestamp?: number;
}

export interface PaymentSnapshot {
  snapshotId: string;
  capturedAt: number;
  invoiceId: string;
  invoiceTotal: string;
  baseFunded: string;
  totalFunded: string;
  percentFunded: number;
  payerBreakdown: PaymentSnapshotPayer[];
  paymentCount: number;
  lastLedger: number;
  payments: PaymentSnapshotPayment[];
}

type Subscriber = (summary: PaymentSummary) => void;

const PERCENT_SCALE = 10_000n;

function hasLedger(payment: Payment): payment is PaymentLedger {
  return typeof payment.ledger === "number" && Number.isInteger(payment.ledger);
}

function paymentKey(payment: PaymentLedger): string {
  return `${payment.payer}:${payment.ledger}`;
}

function comparePayments(a: PaymentLedger, b: PaymentLedger): number {
  const ledgerDelta = a.ledger - b.ledger;

  if (ledgerDelta !== 0) {
    return ledgerDelta;
  }

  const payerDelta = a.payer.localeCompare(b.payer);

  if (payerDelta !== 0) {
    return payerDelta;
  }

  if (a.amount < b.amount) {
    return -1;
  }

  if (a.amount > b.amount) {
    return 1;
  }

  return 0;
}

function comparePayers(a: TopPayer, b: TopPayer): number {
  if (a.amount === b.amount) {
    return a.address.localeCompare(b.address);
  }

  return a.amount < b.amount ? 1 : -1;
}

export class PaymentAggregator {
  public totalFunded: bigint;
  public percentFunded: number;
  public readonly payerBreakdown: Map<string, bigint>;
  public paymentCount: number;
  public lastLedger: number;

  private readonly invoice: Invoice;
  private invoiceTotal: bigint;
  private baseFunded: bigint;
  private readonly payments: PaymentLedger[];
  private readonly seenPayments: Set<string>;
  private readonly subscribers: Set<Subscriber>;

  public constructor(invoice: Invoice) {
    this.invoice = invoice;
    this.invoiceTotal = invoice.recipients.reduce(
      (total, recipient) => total + recipient.amount,
      0n
    );
    this.baseFunded = 0n;
    this.totalFunded = 0n;
    this.percentFunded = 0;
    this.payerBreakdown = new Map();
    this.paymentCount = 0;
    this.lastLedger = 0;
    this.payments = [];
    this.seenPayments = new Set();
    this.subscribers = new Set();

    const ledgeredPayments = invoice.payments.filter(hasLedger);
    const ledgeredTotal = ledgeredPayments.reduce(
      (total, payment) => total + payment.amount,
      0n
    );

    this.baseFunded = invoice.funded > ledgeredTotal ? invoice.funded - ledgeredTotal : 0n;

    for (const payment of ledgeredPayments) {
      this.addPaymentToHistory(payment);
    }

    this.recompute();
  }

  public applyPayment(payment: PaymentLedger): void {
    this.addPaymentToHistory(payment);
    this.recompute();
    this.notify();
  }

  public subscribe(callback: Subscriber): () => void {
    this.subscribers.add(callback);

    return () => {
      this.subscribers.delete(callback);
    };
  }

  public snapshot(): PaymentSnapshot {
    const capturedAt = Date.now();
    const snapshotId = createHash("sha256")
      .update(`${this.invoice.id}:${capturedAt}:${this.lastLedger}`)
      .digest("hex");
    const payerBreakdown = Array.from(this.payerBreakdown.entries())
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([address, amount]) => ({ address, amount: amount.toString() }));
    const payments = this.payments.map((payment) => ({
      payer: payment.payer,
      amount: payment.amount.toString(),
      ledger: payment.ledger,
      ...(payment.timestamp === undefined ? {} : { timestamp: payment.timestamp }),
    }));

    return Object.freeze({
      snapshotId,
      capturedAt,
      invoiceId: this.invoice.id,
      invoiceTotal: this.invoiceTotal.toString(),
      baseFunded: this.baseFunded.toString(),
      totalFunded: this.totalFunded.toString(),
      percentFunded: this.percentFunded,
      payerBreakdown,
      paymentCount: this.paymentCount,
      lastLedger: this.lastLedger,
      payments,
    });
  }

  public restore(snapshot: PaymentSnapshot): void {
    this.invoiceTotal = BigInt(snapshot.invoiceTotal);
    this.baseFunded = BigInt(snapshot.baseFunded);
    this.payments.length = 0;
    this.seenPayments.clear();

    for (const payment of snapshot.payments) {
      const restored: PaymentLedger = {
        payer: payment.payer,
        amount: BigInt(payment.amount),
        ledger: payment.ledger,
      };

      if (payment.timestamp !== undefined) {
        restored.timestamp = payment.timestamp;
      }

      this.addPaymentToHistory(restored);
    }

    this.recompute();
  }

  public getTopPayers(n: number): TopPayer[] {
    const limit = Math.max(0, Math.floor(n));

    return Array.from(this.payerBreakdown.entries())
      .map(([address, amount]) => ({ address, amount }))
      .sort(comparePayers)
      .slice(0, limit);
  }

  private addPaymentToHistory(payment: PaymentLedger): boolean {
    const key = paymentKey(payment);

    if (this.seenPayments.has(key)) {
      return false;
    }

    this.seenPayments.add(key);
    this.payments.push(payment);
    this.payments.sort(comparePayments);

    return true;
  }

  private recompute(): void {
    let totalFunded = this.baseFunded;
    const payerBreakdown = new Map<string, bigint>();
    let lastLedger = 0;

    for (const payment of this.payments) {
      totalFunded += payment.amount;
      payerBreakdown.set(
        payment.payer,
        (payerBreakdown.get(payment.payer) ?? 0n) + payment.amount
      );
      lastLedger = Math.max(lastLedger, payment.ledger);
    }

    this.totalFunded = totalFunded;
    this.percentFunded = this.calculatePercent(totalFunded);
    this.payerBreakdown.clear();

    for (const [payer, amount] of payerBreakdown) {
      this.payerBreakdown.set(payer, amount);
    }

    this.paymentCount = this.payments.length;
    this.lastLedger = lastLedger;
  }

  private calculatePercent(totalFunded: bigint): number {
    if (this.invoiceTotal <= 0n) {
      return totalFunded > 0n ? 100 : 0;
    }

    const cappedTotal = totalFunded > this.invoiceTotal ? this.invoiceTotal : totalFunded;
    const scaledPercent = (cappedTotal * PERCENT_SCALE) / this.invoiceTotal;

    return Number(scaledPercent) / 100;
  }

  private notify(): void {
    const summary = this.createSummary();

    for (const subscriber of this.subscribers) {
      subscriber(summary);
    }
  }

  private createSummary(): PaymentSummary {
    return {
      totalFunded: this.totalFunded,
      percentFunded: this.percentFunded,
      payerBreakdown: this.payerBreakdown,
      paymentCount: this.paymentCount,
      lastLedger: this.lastLedger,
    };
  }
}
