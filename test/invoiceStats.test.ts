import { describe, it, expect } from "vitest";
import { computeInvoiceStats } from "../src/invoiceStats.js";
import type { Invoice, Payment } from "../src/types.js";

// === Fixtures ===

function payment(amount: bigint, payer = "GPAYER"): Payment {
  return { payer, amount };
}

function invoiceWith(payments: Payment[]): Invoice {
  return {
    id: "1",
    creator: "GCREATOR",
    recipients: [{ address: "GRECIPIENT", amount: 1_000n }],
    token: "GTOKEN",
    deadline: 0,
    funded: payments.reduce((sum, p) => sum + p.amount, 0n),
    status: "Pending",
    payments,
  };
}

// === medianAmount ===

describe("computeInvoiceStats — medianAmount", () => {
  it("returns 0 for an empty invoice set", () => {
    expect(computeInvoiceStats(invoiceWith([])).medianAmount).toBe(0n);
  });

  it("returns the single value for a one-payment set", () => {
    expect(computeInvoiceStats(invoiceWith([payment(500n)])).medianAmount).toBe(
      500n,
    );
  });

  it("returns the middle value for an odd-length set", () => {
    const stats = computeInvoiceStats(
      invoiceWith([payment(300n), payment(100n), payment(200n)]),
    );
    expect(stats.medianAmount).toBe(200n);
  });

  it("averages the two middle values for an even-length set", () => {
    const stats = computeInvoiceStats(
      invoiceWith([payment(10n), payment(20n), payment(30n), payment(40n)]),
    );
    // middle two are 20 and 30 -> (20 + 30) / 2 = 25
    expect(stats.medianAmount).toBe(25n);
  });

  it("truncates the fractional stroop when the two middle values sum to an odd number", () => {
    const stats = computeInvoiceStats(
      invoiceWith([payment(1n), payment(2n), payment(4n), payment(4n)]),
    );
    // middle two are 2 and 4 -> 6 / 2 = 3
    expect(stats.medianAmount).toBe(3n);

    const odd = computeInvoiceStats(
      invoiceWith([payment(1n), payment(2n), payment(3n), payment(4n)]),
    );
    // middle two are 2 and 3 -> 5n / 2n = 2n
    expect(odd.medianAmount).toBe(2n);
  });

  it("is robust to a single large outlier where the mean is not", () => {
    const stats = computeInvoiceStats(
      invoiceWith([
        payment(100n),
        payment(100n),
        payment(100n),
        payment(1_000_000n),
      ]),
    );
    expect(stats.medianAmount).toBe(100n);
    expect(stats.avgPayment).toBe(250_075n);
  });

  it("does not depend on payment insertion order", () => {
    const ascending = computeInvoiceStats(
      invoiceWith([payment(1n), payment(5n), payment(9n)]),
    ).medianAmount;
    const descending = computeInvoiceStats(
      invoiceWith([payment(9n), payment(5n), payment(1n)]),
    ).medianAmount;
    expect(ascending).toBe(5n);
    expect(descending).toBe(5n);
  });
});
