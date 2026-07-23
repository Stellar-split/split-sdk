import type { Payment } from "./types.js";
import type { ContractEvent } from "./events.js";

export type AnomalyFlagKind =
  | "HIGH_FREQUENCY"
  | "SMALL_PAYMENT_SMURFING"
  | "RAPID_CYCLE"
  | "HIGH_AMOUNT_VARIANCE";

export interface AnomalyFlag {
  kind: AnomalyFlagKind;
  reason: string;
  /** Unix timestamp (seconds) when the flag was raised. */
  detectedAt: number;
}

export interface AnomalyDetectorOptions {
  /** Overall detection window in seconds. Events older than this are pruned. Default: 3600 */
  windowSeconds?: number;
  /** Maximum payments per window before HIGH_FREQUENCY is raised. Default: 10 */
  maxPaymentsPerWindow?: number;
  /**
   * Payments strictly below this amount (stroops) count as "small".
   * Default: 1_000_000n (0.1 USDC).
   */
  smallPaymentThreshold?: bigint;
  /** Number of small payments in the window to trigger SMALL_PAYMENT_SMURFING. Default: 5 */
  smallPaymentCount?: number;
  /** Number of rapid create→refund cycles to trigger RAPID_CYCLE. Default: 3 */
  maxRapidCycles?: number;
  /** Seconds between a created and refunded event to consider the cycle "rapid". Default: 300 */
  rapidCycleSeconds?: number;
  /**
   * Coefficient of variation (stddev / mean) threshold for payment amounts.
   * Triggers HIGH_AMOUNT_VARIANCE when exceeded. Default: 0.8
   */
  maxAmountVariance?: number;
  /** Override the time source (Unix seconds). Inject in tests to control time. */
  now?: () => number;
}

interface TimedPayment {
  payer: string;
  amount: bigint;
  timestamp: number;
}

interface TimedCycleEvent {
  invoiceId: string;
  creator: string;
  type: "created" | "refunded";
  timestamp: number;
}

export class AnomalyDetector {
  private readonly windowSeconds: number;
  private readonly maxPaymentsPerWindow: number;
  private readonly smallPaymentThreshold: bigint;
  private readonly smallPaymentCount: number;
  private readonly maxRapidCycles: number;
  private readonly rapidCycleSeconds: number;
  private readonly maxAmountVariance: number;
  private readonly now: () => number;

  private payments: TimedPayment[] = [];
  private cycleEvents: TimedCycleEvent[] = [];

  constructor(options: AnomalyDetectorOptions = {}) {
    this.windowSeconds = options.windowSeconds ?? 3600;
    this.maxPaymentsPerWindow = options.maxPaymentsPerWindow ?? 10;
    this.smallPaymentThreshold = options.smallPaymentThreshold ?? 1_000_000n;
    this.smallPaymentCount = options.smallPaymentCount ?? 5;
    this.maxRapidCycles = options.maxRapidCycles ?? 3;
    this.rapidCycleSeconds = options.rapidCycleSeconds ?? 300;
    this.maxAmountVariance = options.maxAmountVariance ?? 0.8;
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
  }

  /**
   * Record a payment for anomaly tracking.
   * Falls back to the current clock if `payment.timestamp` is absent.
   */
  recordPayment(payment: Payment): void {
    const timestamp = payment.timestamp ?? this.now();
    this.payments.push({ payer: payment.payer, amount: payment.amount, timestamp });
    this.prune();
  }

  /**
   * Record a contract event for invoice-lifecycle anomaly tracking.
   * Only `created` and `refunded` events are relevant; all others are ignored.
   *
   * @param event - The contract event (reuses src/events.ts shape).
   * @param creator - The invoice creator address. When omitted the detector
   *   attempts to extract it from `event.data.creator`.
   */
  recordInvoiceEvent(event: ContractEvent, creator?: string): void {
    if (event.type !== "created" && event.type !== "refunded") return;

    const resolved =
      creator ??
      (event.data !== null &&
      typeof event.data === "object" &&
      "creator" in (event.data as object)
        ? (event.data as { creator: unknown }).creator
        : undefined);

    if (typeof resolved !== "string" || resolved === "") return;

    this.cycleEvents.push({
      invoiceId: event.invoiceId,
      creator: resolved,
      type: event.type,
      timestamp: event.timestamp,
    });
    this.prune();
  }

  /**
   * Return all active anomaly flags for the given payer or creator address.
   * Pruning runs before evaluation, so flags clear automatically once all
   * contributing events fall outside the detection window.
   */
  getFlags(payerOrCreator: string): AnomalyFlag[] {
    this.prune();

    const now = this.now();
    const flags: AnomalyFlag[] = [];
    const actorPayments = this.payments.filter((p) => p.payer === payerOrCreator);

    // Rule: HIGH_FREQUENCY — too many payments in the window
    if (actorPayments.length >= this.maxPaymentsPerWindow) {
      flags.push({
        kind: "HIGH_FREQUENCY",
        reason: `${actorPayments.length} payments in ${this.windowSeconds}s window (limit: ${this.maxPaymentsPerWindow})`,
        detectedAt: now,
      });
    }

    // Rule: SMALL_PAYMENT_SMURFING — many payments just under the threshold
    const smallCount = actorPayments.filter(
      (p) => p.amount < this.smallPaymentThreshold
    ).length;
    if (smallCount >= this.smallPaymentCount) {
      flags.push({
        kind: "SMALL_PAYMENT_SMURFING",
        reason: `${smallCount} payments below ${this.smallPaymentThreshold} stroops in window (limit: ${this.smallPaymentCount})`,
        detectedAt: now,
      });
    }

    // Rule: HIGH_AMOUNT_VARIANCE — coefficient of variation exceeds threshold
    if (actorPayments.length >= 2) {
      const amounts = actorPayments.map((p) => Number(p.amount));
      const mean = amounts.reduce((s, a) => s + a, 0) / amounts.length;
      if (mean > 0) {
        const variance =
          amounts.reduce((s, a) => s + (a - mean) ** 2, 0) / amounts.length;
        const cv = Math.sqrt(variance) / mean;
        if (cv >= this.maxAmountVariance) {
          flags.push({
            kind: "HIGH_AMOUNT_VARIANCE",
            reason: `Payment amount coefficient of variation ${cv.toFixed(2)} exceeds threshold ${this.maxAmountVariance}`,
            detectedAt: now,
          });
        }
      }
    }

    // Rule: RAPID_CYCLE — repeated fast create→refund cycles by a creator
    const cycles = this.countRapidCycles(payerOrCreator);
    if (cycles >= this.maxRapidCycles) {
      flags.push({
        kind: "RAPID_CYCLE",
        reason: `${cycles} rapid create→refund cycles within ${this.rapidCycleSeconds}s (limit: ${this.maxRapidCycles})`,
        detectedAt: now,
      });
    }

    return flags;
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Drop events that have aged out of the detection window. */
  private prune(): void {
    const cutoff = this.now() - this.windowSeconds;
    this.payments = this.payments.filter((p) => p.timestamp > cutoff);
    this.cycleEvents = this.cycleEvents.filter((e) => e.timestamp > cutoff);
  }

  /**
   * Count how many invoices for `creator` went through a create→refund cycle
   * within `rapidCycleSeconds`.
   */
  private countRapidCycles(creator: string): number {
    const events = this.cycleEvents.filter((e) => e.creator === creator);

    const byInvoice = new Map<string, { created?: number; refunded?: number }>();
    for (const e of events) {
      const entry = byInvoice.get(e.invoiceId) ?? {};
      if (e.type === "created" && entry.created === undefined) {
        entry.created = e.timestamp;
      } else if (e.type === "refunded" && entry.refunded === undefined) {
        entry.refunded = e.timestamp;
      }
      byInvoice.set(e.invoiceId, entry);
    }

    let cycles = 0;
    for (const { created, refunded } of byInvoice.values()) {
      if (
        created !== undefined &&
        refunded !== undefined &&
        refunded >= created &&
        refunded - created <= this.rapidCycleSeconds
      ) {
        cycles++;
      }
    }
    return cycles;
  }
}
