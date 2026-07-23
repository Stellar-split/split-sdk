import type { StellarSplitClient } from "./client.js";

/** Trend classification for invoice payment velocity. */
export type PaymentTrend = "accelerating" | "steady" | "stalling";

/** Details for a single invoice's payment velocity. */
export interface InvoiceVelocity {
  invoiceId: string;
  paymentsPerDay: number;
  trend: PaymentTrend;
}

/** Report on payment velocity across all invoices for an address. */
export interface VelocityReport {
  address: string;
  invoices: InvoiceVelocity[];
}

/**
 * Analyze payment velocity for all invoices created by an address.
 *
 * Fetches all invoices for the given creator address and computes:
 * - Payment rate (payments per day)
 * - Trend classification based on first-half vs second-half payment rates
 *
 * @param address - Stellar address of the invoice creator
 * @param client  - StellarSplitClient instance
 * @returns Report containing velocity metrics for each invoice
 */
export async function trackVelocity(
  address: string,
  client: StellarSplitClient
): Promise<VelocityReport> {
  const invoices: InvoiceVelocity[] = [];
  let cursor: string | null = null;

  // Fetch all invoices created by this address
  while (true) {
    const result = await client.getInvoicesByCreator(address, {
      cursor: cursor ?? undefined,
      limit: 50,
    });

    for (const invoiceId of result.items) {
      const invoice = await client.getInvoice(invoiceId);

      if (invoice.payments.length === 0) {
        invoices.push({
          invoiceId,
          paymentsPerDay: 0,
          trend: "steady",
        });
        continue;
      }

      const paymentsPerDay = calculatePaymentsPerDay(invoice.payments);
      const trend = classifyTrend(invoice.payments);

      invoices.push({
        invoiceId,
        paymentsPerDay,
        trend,
      });
    }

    if (!result.nextCursor) break;
    cursor = result.nextCursor;
  }

  return { address, invoices };
}

/**
 * Calculate the average payment rate (payments per day) from payment timestamps.
 */
function calculatePaymentsPerDay(payments: Array<{ timestamp?: number }>): number {
  const withTimestamps = payments.filter((p) => p.timestamp !== undefined);

  if (withTimestamps.length < 2) {
    return 0;
  }

  const timestamps = withTimestamps.map((p) => p.timestamp!).sort((a, b) => a - b);
  const first = timestamps[0]!;
  const last = timestamps[timestamps.length - 1]!;

  const daysElapsed = (last - first) / (24 * 3600);
  if (daysElapsed === 0) return 0;

  return withTimestamps.length / daysElapsed;
}

/**
 * Classify payment trend by comparing first-half vs second-half payment rates.
 */
function classifyTrend(payments: Array<{ timestamp?: number }>): PaymentTrend {
  const withTimestamps = payments.filter((p) => p.timestamp !== undefined);

  if (withTimestamps.length < 2) {
    return "steady";
  }

  const timestamps = withTimestamps.map((p) => p.timestamp!).sort((a, b) => a - b);
  const midpoint = Math.floor(timestamps.length / 2);

  const firstHalf = timestamps.slice(0, midpoint);
  const secondHalf = timestamps.slice(midpoint);

  if (firstHalf.length === 0 || secondHalf.length === 0) {
    return "steady";
  }

  const firstHalfRate = calculateRate(firstHalf);
  const secondHalfRate = calculateRate(secondHalf);

  // If rates differ by less than 20%, consider it steady
  const threshold = 0.2;
  const rateDifference = Math.abs(secondHalfRate - firstHalfRate) / Math.max(firstHalfRate, 1);

  if (rateDifference < threshold) {
    return "steady";
  }

  return secondHalfRate > firstHalfRate ? "accelerating" : "stalling";
}

/**
 * Calculate payment rate (payments per day) for a subset of timestamps.
 */
function calculateRate(timestamps: number[]): number {
  if (timestamps.length < 2) return 0;

  const first = timestamps[0]!;
  const last = timestamps[timestamps.length - 1]!;

  const daysElapsed = (last - first) / (24 * 3600);
  if (daysElapsed === 0) return 0;

  return timestamps.length / daysElapsed;
}
