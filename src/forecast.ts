import type { Invoice, Payment } from "./types.js";
import { computePrediction } from "./predictor.js";
import type { CompletionPrediction } from "./predictor.js";

export interface HistoricalInvoiceSample {
  invoiceId: string;
  total: bigint;
  funded: bigint;
  payments: Payment[];
  creator: string;
  status: string;
}

export interface ForecastConfig {
  /** Amount range tolerance (percentage) for considering similar invoices. Default: 0.5 */
  amountRangeTolerance?: number;
  /** Minimum number of historical samples needed for a historical forecast. Default: 3 */
  minHistoricalSamples?: number;
}

export interface PaymentForecast {
  currentPrediction: CompletionPrediction;
  historicalPrediction: CompletionPrediction | null;
  historicalSampleSize: number;
  blendedEstimate: number | null;
  blendedConfidence: number;
}

function amountDifference(a: bigint, b: bigint): number {
  const max = a > b ? a : b;
  if (max === 0n) return 0;
  const diff = a > b ? a - b : b - a;
  return Number((diff * 100n) / max) / 100;
}

function isSimilarAmount(
  invoiceTotal: bigint,
  historicalTotal: bigint,
  tolerance: number
): boolean {
  return amountDifference(invoiceTotal, historicalTotal) <= tolerance;
}

export function computePaymentForecast(
  invoice: Invoice,
  historicalInvoices: Invoice[],
  config?: ForecastConfig
): PaymentForecast {
  const tolerance = config?.amountRangeTolerance ?? 0.5;
  const minSamples = config?.minHistoricalSamples ?? 3;

  const currentPrediction = computePrediction(
    invoice.payments,
    invoice.recipients.reduce((sum, r) => sum + r.amount, 0n),
    invoice.funded
  );

  const sameCreator = historicalInvoices.filter(
    (h) => h.creator === invoice.creator && h.id !== invoice.id
  );

  const similarAmount = sameCreator.filter((h) => {
    const hTotal = h.recipients.reduce((sum, r) => sum + r.amount, 0n);
    const invTotal = invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);
    return isSimilarAmount(invTotal, hTotal, tolerance);
  });

  const historicalSamples: HistoricalInvoiceSample[] = similarAmount
    .filter((h) => h.status === "Released" && h.payments.length >= 2)
    .map((h) => ({
      invoiceId: h.id,
      total: h.recipients.reduce((sum, r) => sum + r.amount, 0n),
      funded: h.funded,
      payments: h.payments,
      creator: h.creator,
      status: h.status,
    }));

  let historicalPrediction: CompletionPrediction | null = null;

  if (historicalSamples.length >= minSamples) {
    const allPayments = historicalSamples.flatMap((s) => s.payments);
    const maxTotal = historicalSamples.reduce(
      (max, s) => (s.total > max ? s.total : max),
      0n
    );
    const totalFunded = historicalSamples.reduce(
      (sum, s) => sum + s.funded,
      0n
    );

    historicalPrediction = computePrediction(
      allPayments,
      maxTotal,
      totalFunded
    );
  }

  let blendedEstimate: number | null = null;
  let blendedConfidence = currentPrediction.confidence;

  if (currentPrediction.estimatedDate !== null) {
    blendedEstimate = currentPrediction.estimatedDate;
    blendedConfidence = currentPrediction.confidence;
  }

  if (
    historicalPrediction?.estimatedDate !== null &&
    historicalPrediction !== null
  ) {
    const histConfidence = Math.min(historicalSamples.length / 20, 1);
    const totalConf = currentPrediction.confidence + histConfidence;

    if (totalConf > 0) {
      const currentWeight = currentPrediction.confidence / totalConf;
      const histWeight = histConfidence / totalConf;

      blendedEstimate = Math.round(
        (currentPrediction.estimatedDate ?? historicalPrediction.estimatedDate!) *
          currentWeight +
          historicalPrediction.estimatedDate! * histWeight
      );
      blendedConfidence = Math.min(currentPrediction.confidence + histConfidence, 1);
    }
  }

  return {
    currentPrediction,
    historicalPrediction,
    historicalSampleSize: historicalSamples.length,
    blendedEstimate,
    blendedConfidence,
  };
}
