/**
 * Invoice payment SLA tracker.
 *
 * Computes compliance metrics across invoice history for reporting purposes.
 * Uses payment timestamps to determine time-to-first-payment and
 * time-to-full-funding per invoice.
 */

import type { Invoice } from "./types.js";

export interface SlaReport {
  withinSla: number;
  breached: number;
  avgTimeToFund: number;
}

function getTotalOwed(invoice: Invoice): bigint {
  return invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);
}

function getCreationTimestamp(invoice: Invoice): number | undefined {
  if (invoice.payments.length === 0) return undefined;
  const firstPayment = invoice.payments
    .filter((p) => p.timestamp !== undefined)
    .sort((a, b) => a.timestamp! - b.timestamp!);
  return firstPayment.length > 0 ? firstPayment[0]!.timestamp : undefined;
}

function getTimeToFullFunding(invoice: Invoice): number | undefined {
  const totalOwed = getTotalOwed(invoice);
  const paymentsWithTimestamps = invoice.payments
    .filter((p) => p.timestamp !== undefined)
    .sort((a, b) => a.timestamp! - b.timestamp!);

  if (paymentsWithTimestamps.length === 0) return undefined;

  const firstTimestamp = paymentsWithTimestamps[0]!.timestamp!;
  let cumulative = 0n;

  for (const payment of paymentsWithTimestamps) {
    cumulative += payment.amount;
    if (cumulative >= totalOwed) {
      return (payment.timestamp! - firstTimestamp) * 1000;
    }
  }

  const lastPayment = paymentsWithTimestamps[paymentsWithTimestamps.length - 1]!;
  return (lastPayment.timestamp! - firstTimestamp) * 1000;
}

export function computeSlaReport(invoices: Invoice[], slaMs: number): SlaReport {
  if (invoices.length === 0) {
    return { withinSla: 0, breached: 0, avgTimeToFund: 0 };
  }

  let withinSla = 0;
  let breached = 0;
  const fundingTimes: number[] = [];

  for (const invoice of invoices) {
    if (invoice.payments.length === 0) {
      breached++;
      continue;
    }

    const timeToFund = getTimeToFullFunding(invoice);
    if (timeToFund === undefined) {
      breached++;
      continue;
    }

    fundingTimes.push(timeToFund);

    if (timeToFund <= slaMs) {
      withinSla++;
    } else {
      breached++;
    }
  }

  const avgTimeToFund =
    fundingTimes.length > 0
      ? fundingTimes.reduce((sum, t) => sum + t, 0) / fundingTimes.length
      : 0;

  return { withinSla, breached, avgTimeToFund };
}
