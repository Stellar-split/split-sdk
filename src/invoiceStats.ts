import type { Invoice, InvoiceStats } from "./types.js";

/** Minimal client interface needed to fetch an invoice for stats. */
interface InvoiceStatsClient {
  getInvoice(id: string): Promise<Invoice>;
}

const SECONDS_PER_DAY = 86_400;

/**
 * Median of a list of stroop amounts, computed with a sort (no dependencies).
 *
 * Returns 0 for an empty list. For an even-length list the two middle values
 * are averaged with integer (truncating) division, matching how `avgPayment`
 * handles the fractional stroop.
 *
 * @param amounts - Unsorted payment amounts in stroops.
 * @returns The median amount in stroops.
 */
function medianOf(amounts: bigint[]): bigint {
  if (amounts.length === 0) return 0n;

  const sorted = [...amounts].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = sorted.length >> 1;

  return sorted.length % 2 === 1
    ? sorted[mid]
    : (sorted[mid - 1] + sorted[mid]) / 2n;
}

/**
 * Compute rich analytics for an invoice purely from its payment history.
 *
 * This performs no RPC calls of its own — it derives everything from the
 * already-loaded `invoice.payments`, `invoice.funded`, and `invoice.recipients`.
 *
 * @param invoice - The invoice to analyse.
 * @returns Aggregated {@link InvoiceStats}.
 */
export function computeInvoiceStats(invoice: Invoice): InvoiceStats {
  const payments = invoice.payments ?? [];

  const totalPayers = new Set(payments.map((p) => p.payer)).size;

  const totalFunded = payments.reduce((sum, p) => sum + p.amount, 0n);
  const avgPayment =
    payments.length === 0 ? 0n : totalFunded / BigInt(payments.length);

  const medianAmount = medianOf(payments.map((p) => p.amount));

  const timestamps = payments
    .map((p) => p.timestamp)
    .filter((t): t is number => typeof t === "number")
    .sort((a, b) => a - b);

  const firstTs = timestamps[0];
  const lastTs = timestamps[timestamps.length - 1];

  let fundingVelocity = 0;
  if (firstTs !== undefined && lastTs !== undefined && lastTs > firstTs) {
    const days = (lastTs - firstTs) / SECONDS_PER_DAY;
    fundingVelocity = Number(totalFunded) / days;
  }

  const totalOwed = invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);
  const completed =
    invoice.status === "Released" ||
    (totalOwed > 0n && invoice.funded >= totalOwed);

  const timeToCompletion =
    completed && firstTs !== undefined && lastTs !== undefined
      ? lastTs - firstTs
      : null;

  let completionBps = 0;
  if (totalOwed > 0n) {
    const bps = (invoice.funded * 10_000n) / totalOwed;
    completionBps = Number(bps > 10_000n ? 10_000n : bps);
  }

  return {
    totalPayers,
    avgPayment,
    medianAmount,
    fundingVelocity,
    timeToCompletion,
    completionBps,
  };
}

/**
 * Fetch an invoice and return its analytics object.
 *
 * Makes a single `getInvoice` call; all metrics are then computed locally with
 * no further RPC round trips.
 *
 * @param invoiceId - The invoice ID to analyse.
 * @param client    - A client that can fetch invoices.
 * @returns Aggregated {@link InvoiceStats}.
 */
export async function getInvoiceStats(
  invoiceId: string,
  client: InvoiceStatsClient
): Promise<InvoiceStats> {
  const invoice = await client.getInvoice(invoiceId);
  return computeInvoiceStats(invoice);
}
