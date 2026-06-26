import type { PaymentSummary } from "./paymentAggregator.js";

export type VelocityAlertKind = "fast" | "slow";

export interface VelocityAlert {
  kind: VelocityAlertKind;
  invoiceId: string;
  velocity: number;
  threshold: number;
  amount: bigint;
  windowStart: number;
  timestamp: number;
}

export interface VelocityConfig {
  /** Funding rate in stroops/second above which a "fast" alert fires. Default: 1_000_000 (1 stroop/sec ≈ 0.0000001 USDC/sec). */
  fastThreshold: number;
  /** Funding rate in stroops/second below which a "slow" alert fires. Default: 100. */
  slowThreshold: number;
  /** Time window in milliseconds over which velocity is computed. Default: 60_000 (1 minute). */
  windowMs: number;
  /** Minimum time in milliseconds between consecutive alerts of the same kind. Default: 30_000. */
  cooldownMs: number;
}

type AlertSubscriber = (alert: VelocityAlert) => void;

const DEFAULTS: VelocityConfig = {
  fastThreshold: 1_000_000,
  slowThreshold: 100,
  windowMs: 60_000,
  cooldownMs: 30_000,
};

interface TimedSnapshot {
  totalFunded: bigint;
  timestamp: number;
}

export class FundingVelocityAlert {
  private config: VelocityConfig;
  private readonly invoiceId: string;
  private snapshots: TimedSnapshot[] = [];
  private lastAlert: Record<VelocityAlertKind, number> = {
    fast: 0,
    slow: 0,
  };
  private readonly subscribers = new Set<AlertSubscriber>();

  constructor(
    invoiceId: string,
    config: Partial<VelocityConfig> = {}
  ) {
    this.invoiceId = invoiceId;
    this.config = { ...DEFAULTS, ...config };
  }

  getConfig(): Readonly<VelocityConfig> {
    return { ...this.config };
  }

  updateConfig(overrides: Partial<VelocityConfig>): void {
    this.config = { ...this.config, ...overrides };
  }

  recordSnapshot(summary: PaymentSummary): void {
    const now = Date.now();

    this.snapshots.push({
      totalFunded: summary.totalFunded,
      timestamp: now,
    });

    this.prune(now);
    this.evaluate(now);
  }

  subscribe(callback: AlertSubscriber): () => void {
    this.subscribers.add(callback);
    return () => {
      this.subscribers.delete(callback);
    };
  }

  getVelocity(): number {
    this.prune(Date.now());
    if (this.snapshots.length < 2) return 0;

    const oldest = this.snapshots[0]!;
    const latest = this.snapshots[this.snapshots.length - 1]!;
    const elapsedMs = latest.timestamp - oldest.timestamp;

    if (elapsedMs <= 0) return 0;

    const fundedDelta = latest.totalFunded - oldest.totalFunded;
    return Number(fundedDelta) / elapsedMs;
  }

  private prune(now: number): void {
    const cutoff = now - this.config.windowMs;
    this.snapshots = this.snapshots.filter((s) => s.timestamp >= cutoff);
  }

  private evaluate(now: number): void {
    if (this.snapshots.length < 2) return;

    const oldest = this.snapshots[0]!;
    const latest = this.snapshots[this.snapshots.length - 1]!;
    const elapsedMs = latest.timestamp - oldest.timestamp;

    if (elapsedMs <= 0) return;

    const fundedDelta = latest.totalFunded - oldest.totalFunded;
    if (fundedDelta <= 0n) return;

    const velocity = Number(fundedDelta) / elapsedMs;

    if (
      velocity >= this.config.fastThreshold &&
      now - this.lastAlert.fast >= this.config.cooldownMs
    ) {
      this.lastAlert.fast = now;
      this.fire({
        kind: "fast",
        invoiceId: this.invoiceId,
        velocity,
        threshold: this.config.fastThreshold,
        amount: fundedDelta,
        windowStart: oldest.timestamp,
        timestamp: now,
      });
    }

    if (
      velocity < this.config.slowThreshold &&
      now - this.lastAlert.slow >= this.config.cooldownMs
    ) {
      this.lastAlert.slow = now;
      this.fire({
        kind: "slow",
        invoiceId: this.invoiceId,
        velocity,
        threshold: this.config.slowThreshold,
        amount: fundedDelta,
        windowStart: oldest.timestamp,
        timestamp: now,
      });
    }
  }

  private fire(alert: VelocityAlert): void {
    for (const subscriber of this.subscribers) {
      try {
        subscriber(alert);
      } catch (error) {
        console.error("Error in velocity alert subscriber:", error);
      }
    }
  }
}
