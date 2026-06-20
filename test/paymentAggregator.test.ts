import { describe, expect, it } from "vitest";
import type { Invoice, Payment } from "../src/types.js";
import { PaymentAggregator } from "../src/paymentAggregator.js";
import type { PaymentSnapshot, PaymentSummary } from "../src/paymentAggregator.js";

function createInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "invoice-1",
    creator: "creator",
    recipients: [
      { address: "recipient-a", amount: 50n },
      { address: "recipient-b", amount: 50n },
    ],
    token: "token",
    deadline: 1_700_000_000,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

function createPayment(overrides: Partial<Payment & { ledger: number }> = {}): Payment & { ledger: number } {
  return {
    payer: "payer-a",
    amount: 10n,
    ledger: 1,
    ...overrides,
  };
}

describe("PaymentAggregator", () => {
  it("resolves out-of-order payments by ledger order", () => {
    const aggregator = new PaymentAggregator(createInvoice());

    aggregator.applyPayment(createPayment({ payer: "payer-b", amount: 20n, ledger: 5 }));
    aggregator.applyPayment(createPayment({ payer: "payer-a", amount: 15n, ledger: 3 }));
    aggregator.applyPayment(createPayment({ payer: "payer-c", amount: 5n, ledger: 4 }));

    const snapshot = aggregator.snapshot();

    expect(snapshot.payments.map((payment) => payment.ledger)).toEqual([3, 4, 5]);
    expect(aggregator.lastLedger).toBe(5);
    expect(aggregator.paymentCount).toBe(3);
    expect(aggregator.totalFunded).toBe(40n);
    expect(aggregator.percentFunded).toBe(40);
  });

  it("ignores duplicate payments with the same payer and ledger", () => {
    const aggregator = new PaymentAggregator(createInvoice());
    const firstPayment = createPayment({ payer: "payer-a", amount: 10n, ledger: 1 });

    aggregator.applyPayment(firstPayment);
    aggregator.applyPayment({ ...firstPayment, amount: 99n });

    expect(aggregator.paymentCount).toBe(1);
    expect(aggregator.totalFunded).toBe(10n);
    expect(aggregator.payerBreakdown.get("payer-a")).toBe(10n);
  });

  it("round-trips snapshots through JSON serialization and restore", () => {
    const aggregator = new PaymentAggregator(createInvoice());
    aggregator.applyPayment(createPayment({ payer: "payer-a", amount: 10n, ledger: 1 }));
    aggregator.applyPayment(createPayment({ payer: "payer-b", amount: 20n, ledger: 2 }));

    const snapshot: PaymentSnapshot = JSON.parse(JSON.stringify(aggregator.snapshot()));
    const restored = new PaymentAggregator(createInvoice());

    restored.restore(snapshot);

    expect(restored.totalFunded).toBe(aggregator.totalFunded);
    expect(restored.percentFunded).toBe(aggregator.percentFunded);
    expect(restored.paymentCount).toBe(aggregator.paymentCount);
    expect(restored.lastLedger).toBe(aggregator.lastLedger);
    expect(Array.from(restored.payerBreakdown.entries())).toEqual(
      Array.from(aggregator.payerBreakdown.entries())
    );
    expect(restored.snapshot().payments.map((payment) => payment.ledger)).toEqual([1, 2]);
  });

  it("notifies subscribers on every applyPayment call and supports unsubscribe", () => {
    const aggregator = new PaymentAggregator(createInvoice());
    const summaries: PaymentSummary[] = [];
    const unsubscribe = aggregator.subscribe((summary) => summaries.push(summary));

    aggregator.applyPayment(createPayment({ payer: "payer-a", amount: 10n, ledger: 1 }));
    aggregator.applyPayment(createPayment({ payer: "payer-a", amount: 20n, ledger: 2 }));

    expect(summaries).toHaveLength(2);
    expect(summaries[0].totalFunded).toBe(10n);
    expect(summaries[1].totalFunded).toBe(30n);

    unsubscribe();

    aggregator.applyPayment(createPayment({ payer: "payer-a", amount: 30n, ledger: 3 }));

    expect(summaries).toHaveLength(2);
  });

  it("returns top payers sorted by amount and then address", () => {
    const aggregator = new PaymentAggregator(createInvoice());

    aggregator.applyPayment(createPayment({ payer: "payer-b", amount: 30n, ledger: 1 }));
    aggregator.applyPayment(createPayment({ payer: "payer-a", amount: 30n, ledger: 2 }));
    aggregator.applyPayment(createPayment({ payer: "payer-c", amount: 10n, ledger: 3 }));

    expect(aggregator.getTopPayers(3).map((payer) => payer.address)).toEqual([
      "payer-a",
      "payer-b",
      "payer-c",
    ]);
    expect(aggregator.getTopPayers(2).map((payer) => payer.address)).toEqual([
      "payer-a",
      "payer-b",
    ]);
  });

  it("caps percent funded at 100", () => {
    const aggregator = new PaymentAggregator(createInvoice({ funded: 0n }));

    aggregator.applyPayment(createPayment({ payer: "payer-a", amount: 200n, ledger: 1 }));

    expect(aggregator.totalFunded).toBe(200n);
    expect(aggregator.percentFunded).toBe(100);
  });
});
