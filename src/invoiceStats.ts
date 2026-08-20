import type { Invoice, InvoiceStats } from "./types.js";

/** Minimal client interface needed to fetch an invoice for stats. */
interface InvoiceStatsClient {
  getInvoice(id: string): Promise<Invoice>;
}

const SECONDS_PER_DAY = 86_400;

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

/** Number of milliseconds in one second. */
const MS_PER_SECOND = 1_000;
/** Threshold distinguishing millisecond timestamps from second timestamps. */
const MS_EPOCH_THRESHOLD = 1e12;

/**
 * Normalize a `createdAt` value to milliseconds since the Unix epoch.
 *
 * The SDK accepts unix timestamps in either seconds or milliseconds; the
 * unit is auto-detected by magnitude (values greater than ~1e12 are
 * milliseconds, everything else seconds).
 *
 * @param createdAt - Unix timestamp in seconds or milliseconds.
 * @returns The same instant expressed in milliseconds.
 */
function createdAtToMs(createdAt: number): number {
  return createdAt > MS_EPOCH_THRESHOLD ? createdAt : createdAt * MS_PER_SECOND;
}

/**
 * Compute how long an invoice has existed, broken into days, hours, and
 * minutes, measured from `invoice.createdAt` to now (`Date.now()`).
 *
 * `createdAt` may be a unix timestamp in either seconds or milliseconds —
 * the unit is auto-detected by magnitude.
 *
 * @param invoice - The invoice to measure.
 * @returns An object with the elapsed `days`, `hours`, and `minutes`.
 */
export function getInvoiceAge(invoice: Invoice): {
  days: number;
  hours: number;
  minutes: number;
} {
  const nowMs = Date.now();
  const createdAtMs = createdAtToMs(invoice.createdAt);
  const elapsedMs = Math.max(0, nowMs - createdAtMs);

  const minutes = Math.floor(elapsedMs / (MS_PER_SECOND * 60));
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);

  return { days, hours: hours % 24, minutes: minutes % 60 };
}

/**
 * Compute how much USDC an invoice has received per day since it was created.
 *
 * Funding velocity is `invoice.funded` (in the token's smallest unit)
 * divided by the age of the invoice in days. To avoid a divide-by-zero,
 * invoices created within the same second as `Date.now()` return `0`.
 *
 * @param invoice - The invoice to measure.
 * @returns USDC (as a float) received per day since creation.
 */
export function getFundingVelocity(invoice: Invoice): number {
  const nowMs = Date.now();
  const createdAtMs = createdAtToMs(invoice.createdAt);

  if (nowMs - createdAtMs <= MS_PER_SECOND) {
    return 0;
  }

  const ageDays = (nowMs - createdAtMs) / (MS_PER_SECOND * SECONDS_PER_DAY);
  return Number(invoice.funded) / ageDays;
}
