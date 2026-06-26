import { describe, it, expect } from "vitest";
import { computePaymentForecast } from "../src/forecast.js";
import type { Invoice, Payment } from "../src/types.js";

function makePayment(
  payer: string,
  amount: bigint,
  timestamp: number
): Payment {
  return { payer, amount, timestamp };
}

function makeInvoice(
  id: string,
  creator: string,
  total: bigint,
  funded: bigint,
  payments: Payment[],
  status: string = "Pending"
): Invoice {
  return {
    id,
    creator,
    recipients: [{ address: "GPAYEE", amount: total }],
    token: "USDC",
    deadline: 1_800_000_000,
    funded,
    status: status as "Pending" | "Released" | "Refunded" | "Cancelled",
    payments,
  };
}

describe("computePaymentForecast", () => {
  it("returns currentPrediction with no historical data", () => {
    const invoice = makeInvoice("inv-1", "GCREATOR", 1000n, 500n, [
      makePayment("GPAYER", 500n, 1_800_100_000),
    ]);

    const forecast = computePaymentForecast(invoice, []);
    expect(forecast.currentPrediction).toBeDefined();
    expect(forecast.historicalPrediction).toBeNull();
    expect(forecast.historicalSampleSize).toBe(0);
  });

  it("returns historicalPrediction when enough similar invoices exist", () => {
    const invoice = makeInvoice("inv-new", "GCREATOR", 1000n, 0n, []);

    const historical = [
      makeInvoice("h1", "GCREATOR", 1100n, 1000n, [
        makePayment("GPAYER", 500n, 1_800_100_000),
        makePayment("GPAYER", 500n, 1_800_200_000),
      ], "Released"),
      makeInvoice("h2", "GCREATOR", 900n, 900n, [
        makePayment("GPAYER", 300n, 1_800_300_000),
        makePayment("GPAYER", 600n, 1_800_400_000),
      ], "Released"),
      makeInvoice("h3", "GCREATOR", 1050n, 1050n, [
        makePayment("GPAYER", 1000n, 1_800_100_000),
        makePayment("GPAYER", 50n, 1_800_500_000),
      ], "Released"),
    ];

    const forecast = computePaymentForecast(invoice, historical);
    expect(forecast.historicalPrediction).not.toBeNull();
    expect(forecast.historicalSampleSize).toBe(3);
  });

  it("filters by same creator", () => {
    const invoice = makeInvoice("inv-new", "GCREATOR", 1000n, 0n, []);

    const historical = [
      makeInvoice("h1", "OTHER", 1100n, 1000n, [
        makePayment("GPAYER", 500n, 1_800_100_000),
        makePayment("GPAYER", 500n, 1_800_200_000),
      ], "Released"),
    ];

    const forecast = computePaymentForecast(invoice, historical);
    expect(forecast.historicalSampleSize).toBe(0);
    expect(forecast.historicalPrediction).toBeNull();
  });

  it("filters invoices outside amount tolerance", () => {
    const invoice = makeInvoice("inv-new", "GCREATOR", 1000n, 0n, []);

    const historical = [
      makeInvoice("h1", "GCREATOR", 100_000n, 100_000n, [
        makePayment("GPAYER", 50_000n, 1_800_100_000),
        makePayment("GPAYER", 50_000n, 1_800_200_000),
      ], "Released"),
    ];

    const forecast = computePaymentForecast(invoice, historical, {
      amountRangeTolerance: 0.1,
    });
    expect(forecast.historicalSampleSize).toBe(0);
    expect(forecast.historicalPrediction).toBeNull();
  });

  it("produces blended estimate when both predictions exist", () => {
    const invoice = makeInvoice("inv-new", "GCREATOR", 1000n, 200n, [
      makePayment("GPAYER", 200n, 1_800_100_000),
    ]);

    const similarCompleted = Array.from({ length: 5 }, (_, i) =>
      makeInvoice(`h${i}`, "GCREATOR", 1000n, 1000n, [
        makePayment("GPAYER", 500n, 1_800_100_000 + i * 100_000),
        makePayment("GPAYER", 500n, 1_800_200_000 + i * 100_000),
      ], "Released")
    );

    const forecast = computePaymentForecast(invoice, similarCompleted);
    expect(forecast.blendedEstimate).not.toBeNull();
    expect(forecast.blendedConfidence).toBeGreaterThan(0);
  });

  it("returns blendedConfidence of 0 when only current prediction with low confidence", () => {
    const invoice = makeInvoice("inv-new", "GCREATOR", 1000n, 0n, []);

    const forecast = computePaymentForecast(invoice, []);
    expect(forecast.currentPrediction.confidence).toBe(0);
    expect(forecast.blendedEstimate).toBeNull();
  });
});
