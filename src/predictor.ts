import type { Payment } from "./types.js";

export interface CompletionPrediction {
  estimatedDate: number | null;
  confidence: number;
  remainingAmount: bigint;
}

export function computePrediction(
  payments: Payment[],
  total: bigint,
  funded: bigint,
  nowSeconds?: number
): CompletionPrediction {
  const remaining = total > funded ? total - funded : 0n;

  if (remaining === 0n) {
    return { estimatedDate: null, confidence: 1, remainingAmount: 0n };
  }

  if (payments.length < 2) {
    return { estimatedDate: null, confidence: 0, remainingAmount: remaining };
  }

  const totalPaid = payments.reduce((sum, p) => sum + p.amount, 0n);
  const avgAmount = totalPaid / BigInt(payments.length);

  if (avgAmount === 0n) {
    return { estimatedDate: null, confidence: 0, remainingAmount: remaining };
  }

  // Compute average interval from timestamps when available
  const timestamped = payments
    .map((p) => p.timestamp)
    .filter((t): t is number => typeof t === "number");

  let avgIntervalSecs = 86_400; // default: 1 day per payment
  if (timestamped.length >= 2) {
    const sorted = [...timestamped].sort((a, b) => a - b);
    let totalInterval = 0;
    for (let i = 1; i < sorted.length; i++) {
      totalInterval += sorted[i]! - sorted[i - 1]!;
    }
    avgIntervalSecs = totalInterval / (sorted.length - 1);
  }

  const paymentsNeeded =
    Number(remaining / avgAmount) + (remaining % avgAmount > 0n ? 1 : 0);

  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const estimatedDate = now + Math.round(paymentsNeeded * avgIntervalSecs);

  // Confidence scales with number of data points (caps at 1.0 with 10+ payments)
  const confidence = Math.min(payments.length / 10, 1);

  return { estimatedDate, confidence, remainingAmount: remaining };
}
