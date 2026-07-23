import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { FundingVelocityAlert } from "../src/velocityAlert.js";
import type { PaymentSummary } from "../src/paymentAggregator.js";
import type { VelocityAlert } from "../src/velocityAlert.js";

function makeSummary(overrides: Partial<PaymentSummary> = {}): PaymentSummary {
  return {
    totalFunded: 0n,
    percentFunded: 0,
    payerBreakdown: new Map(),
    paymentCount: 0,
    lastLedger: 0,
    ...overrides,
  };
}

describe("FundingVelocityAlert", () => {
  let alert: FundingVelocityAlert;

  beforeEach(() => {
    vi.useFakeTimers();
    alert = new FundingVelocityAlert("invoice-1", {
      fastThreshold: 1_000,
      slowThreshold: 100,
      windowMs: 60_000,
      cooldownMs: 10_000,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns zero velocity with fewer than 2 snapshots", () => {
    expect(alert.getVelocity()).toBe(0);

    alert.recordSnapshot(makeSummary({ totalFunded: 100n }));
    expect(alert.getVelocity()).toBe(0);
  });

  it("computes velocity correctly", () => {
    alert.recordSnapshot(makeSummary({ totalFunded: 0n }));
    vi.advanceTimersByTime(1_000);
    alert.recordSnapshot(makeSummary({ totalFunded: 5_000n }));

    const velocity = alert.getVelocity();
    expect(velocity).toBe(5);
  });

  it("fires fast alert when velocity exceeds threshold", () => {
    const alerts: VelocityAlert[] = [];
    alert.subscribe((a) => alerts.push(a));

    alert.recordSnapshot(makeSummary({ totalFunded: 0n }));
    vi.advanceTimersByTime(1_000);
    alert.recordSnapshot(makeSummary({ totalFunded: 2_000_000n }));

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("fast");
    expect(alerts[0]!.velocity).toBe(2_000);
    expect(alerts[0]!.threshold).toBe(1_000);
  });

  it("fires slow alert when velocity is below threshold", () => {
    const alerts: VelocityAlert[] = [];
    alert.subscribe((a) => alerts.push(a));

    alert.recordSnapshot(makeSummary({ totalFunded: 0n }));
    vi.advanceTimersByTime(1_000);
    alert.recordSnapshot(makeSummary({ totalFunded: 50n }));

    expect(alerts).toHaveLength(1);
    expect(alerts[0]!.kind).toBe("slow");
    expect(alerts[0]!.velocity).toBe(0.05);
    expect(alerts[0]!.threshold).toBe(100);
  });

  it("does not fire if funded delta is zero", () => {
    const alerts: VelocityAlert[] = [];
    alert.subscribe((a) => alerts.push(a));

    alert.recordSnapshot(makeSummary({ totalFunded: 100n }));
    vi.advanceTimersByTime(1_000);
    alert.recordSnapshot(makeSummary({ totalFunded: 100n }));

    expect(alerts).toHaveLength(0);
  });

  it("respects cooldown between alerts of same kind", () => {
    const alerts: VelocityAlert[] = [];
    alert.subscribe((a) => alerts.push(a));

    // First fast alert
    alert.recordSnapshot(makeSummary({ totalFunded: 0n }));
    vi.advanceTimersByTime(1_000);
    alert.recordSnapshot(makeSummary({ totalFunded: 2_000_000n }));
    expect(alerts).toHaveLength(1);

    // Within cooldown — should not fire again
    vi.advanceTimersByTime(5_000);
    alert.recordSnapshot(makeSummary({ totalFunded: 4_000_000n }));
    expect(alerts).toHaveLength(1);

    // After cooldown — should fire again
    vi.advanceTimersByTime(10_000);
    alert.recordSnapshot(makeSummary({ totalFunded: 20_000_000n }));
    expect(alerts).toHaveLength(2);
  });

  it("supports unsubscribe", () => {
    const alerts: VelocityAlert[] = [];
    const unsubscribe = alert.subscribe((a) => alerts.push(a));

    alert.recordSnapshot(makeSummary({ totalFunded: 0n }));
    vi.advanceTimersByTime(1_000);
    alert.recordSnapshot(makeSummary({ totalFunded: 2_000_000n }));
    expect(alerts).toHaveLength(1);

    unsubscribe();

    vi.advanceTimersByTime(20_000);
    alert.recordSnapshot(makeSummary({ totalFunded: 4_000_000n }));
    expect(alerts).toHaveLength(1);
  });

  it("prunes old snapshots outside the window", () => {
    alert.recordSnapshot(makeSummary({ totalFunded: 0n }));
    vi.advanceTimersByTime(30_000);
    alert.recordSnapshot(makeSummary({ totalFunded: 1_000n }));
    vi.advanceTimersByTime(31_000);

    // Only the second snapshot should remain
    expect(alert.getVelocity()).toBe(0);
  });

  it("updateConfig changes thresholds at runtime", () => {
    alert.updateConfig({ fastThreshold: 5_000 });

    const alerts: VelocityAlert[] = [];
    alert.subscribe((a) => alerts.push(a));

    alert.recordSnapshot(makeSummary({ totalFunded: 0n }));
    vi.advanceTimersByTime(1_000);
    alert.recordSnapshot(makeSummary({ totalFunded: 2_000_000n }));

    // 2000 < 5000, so no fast alert
    expect(alerts).toHaveLength(0);
  });
});
