import { describe, expect, it } from "vitest";
import { AnomalyDetector } from "../src/anomalyDetector.js";
import type { Payment } from "../src/types.js";
import type { ContractEvent } from "../src/events.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makePayment(overrides: Partial<Payment> = {}): Payment {
  return {
    payer: "GPAYER000000000000000000000000000000000000000000000000000",
    amount: 5_000_000n,
    ...overrides,
  };
}

function makeEvent(overrides: Partial<ContractEvent> = {}): ContractEvent {
  return {
    type: "created",
    invoiceId: "inv-1",
    data: {},
    ledger: 1000,
    timestamp: 1_000_000,
    ...overrides,
  };
}

const CREATOR = "GCREATOR00000000000000000000000000000000000000000000000000";
const PAYER = "GPAYER000000000000000000000000000000000000000000000000000";
const OTHER = "GOTHER0000000000000000000000000000000000000000000000000000";

// ---------------------------------------------------------------------------
// HIGH_FREQUENCY
// ---------------------------------------------------------------------------

describe("HIGH_FREQUENCY", () => {
  it("triggers when payment count meets the threshold", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({
      maxPaymentsPerWindow: 3,
      now: () => now,
    });

    for (let i = 0; i < 3; i++) {
      detector.recordPayment(makePayment({ payer: PAYER, timestamp: now }));
    }

    expect(detector.getFlags(PAYER).some((f) => f.kind === "HIGH_FREQUENCY")).toBe(true);
  });

  it("does not trigger below the threshold", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({
      maxPaymentsPerWindow: 3,
      now: () => now,
    });

    for (let i = 0; i < 2; i++) {
      detector.recordPayment(makePayment({ payer: PAYER, timestamp: now }));
    }

    expect(detector.getFlags(PAYER).some((f) => f.kind === "HIGH_FREQUENCY")).toBe(false);
  });

  it("clears once all payments age out of the detection window", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({
      maxPaymentsPerWindow: 3,
      windowSeconds: 3600,
      now: () => now,
    });

    for (let i = 0; i < 3; i++) {
      detector.recordPayment(makePayment({ payer: PAYER, timestamp: now }));
    }

    expect(detector.getFlags(PAYER).some((f) => f.kind === "HIGH_FREQUENCY")).toBe(true);

    now += 3601;
    expect(detector.getFlags(PAYER).some((f) => f.kind === "HIGH_FREQUENCY")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SMALL_PAYMENT_SMURFING
// ---------------------------------------------------------------------------

describe("SMALL_PAYMENT_SMURFING", () => {
  it("triggers when small payment count meets the threshold", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({
      smallPaymentThreshold: 1_000_000n,
      smallPaymentCount: 3,
      maxPaymentsPerWindow: 100,
      now: () => now,
    });

    for (let i = 0; i < 3; i++) {
      detector.recordPayment(makePayment({ payer: PAYER, amount: 999_999n, timestamp: now }));
    }

    expect(detector.getFlags(PAYER).some((f) => f.kind === "SMALL_PAYMENT_SMURFING")).toBe(true);
  });

  it("does not flag payments at or above the threshold amount", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({
      smallPaymentThreshold: 1_000_000n,
      smallPaymentCount: 3,
      maxPaymentsPerWindow: 100,
      now: () => now,
    });

    for (let i = 0; i < 3; i++) {
      detector.recordPayment(makePayment({ payer: PAYER, amount: 1_000_000n, timestamp: now }));
    }

    expect(detector.getFlags(PAYER).some((f) => f.kind === "SMALL_PAYMENT_SMURFING")).toBe(false);
  });

  it("clears once all small payments age out of the detection window", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({
      smallPaymentThreshold: 1_000_000n,
      smallPaymentCount: 3,
      windowSeconds: 3600,
      now: () => now,
    });

    for (let i = 0; i < 3; i++) {
      detector.recordPayment(makePayment({ payer: PAYER, amount: 500_000n, timestamp: now }));
    }

    expect(detector.getFlags(PAYER).some((f) => f.kind === "SMALL_PAYMENT_SMURFING")).toBe(true);

    now += 3601;
    expect(detector.getFlags(PAYER).some((f) => f.kind === "SMALL_PAYMENT_SMURFING")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// HIGH_AMOUNT_VARIANCE
// ---------------------------------------------------------------------------

describe("HIGH_AMOUNT_VARIANCE", () => {
  it("triggers when coefficient of variation exceeds the threshold", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({
      maxAmountVariance: 0.5,
      maxPaymentsPerWindow: 100,
      now: () => now,
    });

    // 100 stroops vs 10_000_000 stroops: wildly different → high CV
    detector.recordPayment(makePayment({ payer: PAYER, amount: 100n, timestamp: now }));
    detector.recordPayment(makePayment({ payer: PAYER, amount: 10_000_000n, timestamp: now }));

    expect(detector.getFlags(PAYER).some((f) => f.kind === "HIGH_AMOUNT_VARIANCE")).toBe(true);
  });

  it("does not trigger when amounts are uniform", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({ maxAmountVariance: 0.5, maxPaymentsPerWindow: 100, now: () => now });

    detector.recordPayment(makePayment({ payer: PAYER, amount: 1_000_000n, timestamp: now }));
    detector.recordPayment(makePayment({ payer: PAYER, amount: 1_000_000n, timestamp: now }));

    expect(detector.getFlags(PAYER).some((f) => f.kind === "HIGH_AMOUNT_VARIANCE")).toBe(false);
  });

  it("requires at least 2 payments before it can trigger", () => {
    let now = 1_000_000;
    // threshold of 0 would flag anything, but a single payment has no variance
    const detector = new AnomalyDetector({ maxAmountVariance: 0, maxPaymentsPerWindow: 100, now: () => now });

    detector.recordPayment(makePayment({ payer: PAYER, amount: 1_000_000n, timestamp: now }));

    expect(detector.getFlags(PAYER).some((f) => f.kind === "HIGH_AMOUNT_VARIANCE")).toBe(false);
  });

  it("clears once all contributing payments age out of the detection window", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({
      maxAmountVariance: 0.5,
      windowSeconds: 3600,
      maxPaymentsPerWindow: 100,
      now: () => now,
    });

    detector.recordPayment(makePayment({ payer: PAYER, amount: 100n, timestamp: now }));
    detector.recordPayment(makePayment({ payer: PAYER, amount: 10_000_000n, timestamp: now }));

    expect(detector.getFlags(PAYER).some((f) => f.kind === "HIGH_AMOUNT_VARIANCE")).toBe(true);

    now += 3601;
    expect(detector.getFlags(PAYER).some((f) => f.kind === "HIGH_AMOUNT_VARIANCE")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RAPID_CYCLE
// ---------------------------------------------------------------------------

describe("RAPID_CYCLE", () => {
  it("triggers when rapid create→refund cycle count meets the threshold", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({
      maxRapidCycles: 2,
      rapidCycleSeconds: 300,
      now: () => now,
    });

    detector.recordInvoiceEvent(makeEvent({ type: "created", invoiceId: "inv-1", timestamp: now }), CREATOR);
    detector.recordInvoiceEvent(makeEvent({ type: "refunded", invoiceId: "inv-1", timestamp: now + 60 }), CREATOR);

    detector.recordInvoiceEvent(makeEvent({ type: "created", invoiceId: "inv-2", timestamp: now + 70 }), CREATOR);
    detector.recordInvoiceEvent(makeEvent({ type: "refunded", invoiceId: "inv-2", timestamp: now + 120 }), CREATOR);

    expect(detector.getFlags(CREATOR).some((f) => f.kind === "RAPID_CYCLE")).toBe(true);
  });

  it("does not trigger below the cycle count threshold", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({
      maxRapidCycles: 2,
      rapidCycleSeconds: 300,
      now: () => now,
    });

    detector.recordInvoiceEvent(makeEvent({ type: "created", invoiceId: "inv-1", timestamp: now }), CREATOR);
    detector.recordInvoiceEvent(makeEvent({ type: "refunded", invoiceId: "inv-1", timestamp: now + 60 }), CREATOR);

    expect(detector.getFlags(CREATOR).some((f) => f.kind === "RAPID_CYCLE")).toBe(false);
  });

  it("does not flag a cancel that falls outside the rapid-cycle window", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({
      maxRapidCycles: 2,
      rapidCycleSeconds: 300,
      now: () => now,
    });

    // Both invoices cancelled slowly — 400s > rapidCycleSeconds(300)
    detector.recordInvoiceEvent(makeEvent({ type: "created", invoiceId: "inv-1", timestamp: now }), CREATOR);
    detector.recordInvoiceEvent(makeEvent({ type: "refunded", invoiceId: "inv-1", timestamp: now + 400 }), CREATOR);

    detector.recordInvoiceEvent(makeEvent({ type: "created", invoiceId: "inv-2", timestamp: now + 500 }), CREATOR);
    detector.recordInvoiceEvent(makeEvent({ type: "refunded", invoiceId: "inv-2", timestamp: now + 950 }), CREATOR);

    expect(detector.getFlags(CREATOR).some((f) => f.kind === "RAPID_CYCLE")).toBe(false);
  });

  it("clears once all cycle events age out of the detection window", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({
      maxRapidCycles: 2,
      rapidCycleSeconds: 300,
      windowSeconds: 3600,
      now: () => now,
    });

    // Record all events at `now` so they all expire at the same time
    detector.recordInvoiceEvent(makeEvent({ type: "created", invoiceId: "inv-1", timestamp: now }), CREATOR);
    detector.recordInvoiceEvent(makeEvent({ type: "refunded", invoiceId: "inv-1", timestamp: now }), CREATOR);

    detector.recordInvoiceEvent(makeEvent({ type: "created", invoiceId: "inv-2", timestamp: now }), CREATOR);
    detector.recordInvoiceEvent(makeEvent({ type: "refunded", invoiceId: "inv-2", timestamp: now }), CREATOR);

    expect(detector.getFlags(CREATOR).some((f) => f.kind === "RAPID_CYCLE")).toBe(true);

    now += 3601;
    expect(detector.getFlags(CREATOR).some((f) => f.kind === "RAPID_CYCLE")).toBe(false);
  });

  it("extracts creator from event.data.creator when no explicit creator is passed", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({
      maxRapidCycles: 1,
      rapidCycleSeconds: 300,
      now: () => now,
    });

    detector.recordInvoiceEvent(
      makeEvent({ type: "created", invoiceId: "inv-1", timestamp: now, data: { creator: CREATOR } })
    );
    detector.recordInvoiceEvent(
      makeEvent({ type: "refunded", invoiceId: "inv-1", timestamp: now + 30, data: { creator: CREATOR } })
    );

    expect(detector.getFlags(CREATOR).some((f) => f.kind === "RAPID_CYCLE")).toBe(true);
  });

  it("ignores events with no resolvable creator", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({ maxRapidCycles: 1, now: () => now });

    // data has no creator field and no explicit creator argument
    detector.recordInvoiceEvent(makeEvent({ type: "created", invoiceId: "inv-1", timestamp: now, data: {} }));

    expect(detector.getFlags(CREATOR)).toEqual([]);
  });

  it("ignores payment and released event types", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({ maxRapidCycles: 1, now: () => now });

    detector.recordInvoiceEvent(makeEvent({ type: "payment", invoiceId: "inv-1", timestamp: now }), CREATOR);
    detector.recordInvoiceEvent(makeEvent({ type: "released", invoiceId: "inv-1", timestamp: now }), CREATOR);

    expect(detector.getFlags(CREATOR).some((f) => f.kind === "RAPID_CYCLE")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// General behaviour
// ---------------------------------------------------------------------------

describe("general behaviour", () => {
  it("returns an empty array for an unknown actor", () => {
    const detector = new AnomalyDetector();
    expect(detector.getFlags(OTHER)).toEqual([]);
  });

  it("isolates flags between different actors", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({ maxPaymentsPerWindow: 2, now: () => now });

    const payerA = PAYER;
    const payerB = OTHER;

    detector.recordPayment(makePayment({ payer: payerA, timestamp: now }));
    detector.recordPayment(makePayment({ payer: payerA, timestamp: now }));

    expect(detector.getFlags(payerA).some((f) => f.kind === "HIGH_FREQUENCY")).toBe(true);
    expect(detector.getFlags(payerB).some((f) => f.kind === "HIGH_FREQUENCY")).toBe(false);
  });

  it("multiple flags can coexist for the same actor", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({
      maxPaymentsPerWindow: 2,
      smallPaymentThreshold: 1_000_000n,
      smallPaymentCount: 2,
      now: () => now,
    });

    for (let i = 0; i < 2; i++) {
      detector.recordPayment(makePayment({ payer: PAYER, amount: 500_000n, timestamp: now }));
    }

    const flags = detector.getFlags(PAYER);
    expect(flags.some((f) => f.kind === "HIGH_FREQUENCY")).toBe(true);
    expect(flags.some((f) => f.kind === "SMALL_PAYMENT_SMURFING")).toBe(true);
  });

  it("uses payment.timestamp when provided instead of now()", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({
      maxPaymentsPerWindow: 2,
      windowSeconds: 60,
      now: () => now,
    });

    // Record payments with a timestamp already outside the window
    const oldTs = now - 100;
    detector.recordPayment(makePayment({ payer: PAYER, amount: 1n, timestamp: oldTs }));
    detector.recordPayment(makePayment({ payer: PAYER, amount: 1n, timestamp: oldTs }));

    // Advance now so those old timestamps fall outside the 60s window
    now += 1; // cutoff = 1_000_001 - 60 = 999_941; oldTs=999_900 < cutoff → pruned

    expect(detector.getFlags(PAYER).some((f) => f.kind === "HIGH_FREQUENCY")).toBe(false);
  });

  it("each flag carries a non-empty reason string and a detectedAt timestamp", () => {
    let now = 1_000_000;
    const detector = new AnomalyDetector({ maxPaymentsPerWindow: 1, now: () => now });

    detector.recordPayment(makePayment({ payer: PAYER, timestamp: now }));

    const flags = detector.getFlags(PAYER);
    expect(flags.length).toBeGreaterThan(0);

    for (const flag of flags) {
      expect(typeof flag.reason).toBe("string");
      expect(flag.reason.length).toBeGreaterThan(0);
      expect(flag.detectedAt).toBe(now);
    }
  });
});
