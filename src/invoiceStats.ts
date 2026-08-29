import type { Invoice, InvoiceStats } from "./types.js";

/** Minimal client interface needed to fetch an invoice for stats. */
interface InvoiceStatsClient {
  getInvoice(id: string): Promise<Invoice>;
}

const SECONDS_PER_DAY = 86_400;

const MS_PER_SECOND = 1_000;
const MS_PER_MINUTE = 60 * MS_PER_SECOND;
const MS_PER_HOUR = 60 * MS_PER_MINUTE;
const MS_PER_DAY = 24 * MS_PER_HOUR;

/**
 * Any epoch value above this magnitude is already expressed in milliseconds.
 *
 * `1e12` ms is 2001-09-09, while `1e12` seconds is the year 33658 — so the
 * threshold unambiguously separates second- and millisecond-based timestamps
 * for every realistic invoice.
 */
const MS_DETECTION_THRESHOLD = 1e12;

/**
 * Normalise a `createdAt` value to epoch milliseconds.
 *
 * Accepts either Unix seconds or milliseconds and auto-detects the unit by
 * magnitude: values greater than 1e12 are treated as milliseconds, everything
 * else is treated as seconds.
 *
 * Non-positive values are rejected rather than interpreted: `0` is the default
 * a Soroban `u64` decoder (or a partially populated payload) produces for an
 * unset field, and treating it as epoch 1970 would report a ~20,000-day age
 * instead of "unknown".
 *
 * @param timestamp - Epoch value in seconds or milliseconds.
 * @returns Epoch milliseconds, or `null` when the input is not a finite,
 *          positive number.
 */
function toEpochMs(timestamp: number | undefined): number | null {
  if (typeof timestamp !== "number" || !Number.isFinite(timestamp)) return null;
  if (timestamp <= 0) return null;
  return timestamp > MS_DETECTION_THRESHOLD
    ? timestamp
    : timestamp * MS_PER_SECOND;
}

/**
 * Milliseconds elapsed since `invoice.createdAt`, clamped at 0.
 *
 * Returns `null` when the invoice carries no usable `createdAt` (absent, or a
 * non-positive / non-finite sentinel).
 */
function elapsedMsSinceCreation(invoice: Invoice): number | null {
  const createdMs = toEpochMs(invoice.createdAt);
  if (createdMs === null) return null;
  const elapsed = Date.now() - createdMs;
  return elapsed > 0 ? elapsed : 0;
}

/** How old an invoice is, split into whole days, hours, and minutes. */
export interface InvoiceAge {
  /** Whole days elapsed since creation. */
  days: number;
  /** Whole hours remaining after `days` (0–23). */
  hours: number;
  /** Whole minutes remaining after `days` and `hours` (0–59). */
  minutes: number;
}

/**
 * Compute how long ago an invoice was created.
 *
 * The result is a calendar-style breakdown: `hours` is the remainder after
 * whole `days`, and `minutes` is the remainder after whole `hours`. Uses
 * `Date.now()` internally and performs no network calls.
 *
 * `invoice.createdAt` may be a Unix timestamp in seconds or in milliseconds —
 * the unit is detected automatically by magnitude (`> 1e12` means ms). Invoices
 * with no usable `createdAt` (absent, `0`, or negative), or with a `createdAt`
 * in the future, report a zero age.
 *
 * @param invoice - The invoice to measure.
 * @returns The elapsed age as {@link InvoiceAge}.
 */
export function getInvoiceAge(invoice: Invoice): InvoiceAge {
  const elapsed = elapsedMsSinceCreation(invoice) ?? 0;

  return {
    days: Math.floor(elapsed / MS_PER_DAY),
    hours: Math.floor((elapsed % MS_PER_DAY) / MS_PER_HOUR),
    minutes: Math.floor((elapsed % MS_PER_HOUR) / MS_PER_MINUTE),
  };
}

/**
 * Compute how fast an invoice is being funded since it was created.
 *
 * Derived purely from `invoice.funded` and `invoice.createdAt` — no network
 * calls. `createdAt` may be in seconds or milliseconds (auto-detected by
 * magnitude, `> 1e12` means ms).
 *
 * The returned rate is in the same base units as `invoice.funded` — stroops per
 * day, **not** USDC per day. Divide by `10_000_000` before displaying a USDC
 * figure.
 *
 * Not to be confused with {@link InvoiceStats.fundingVelocity} returned by
 * {@link computeInvoiceStats}: that one is a payment-window rate (sum of
 * payment amounts over the span between the first and last payment), whereas
 * this is a lifetime average over the whole age of the invoice. The two
 * deliberately differ for the same invoice.
 *
 * Returns `0` when the invoice has no usable `createdAt` (absent, `0`, or
 * negative) or when `createdAt` falls within the same second as `Date.now()`,
 * which guards against dividing by a zero (or negative) age.
 *
 * @param invoice - The invoice to measure.
 * @returns Stroops funded per day since creation, or `0` for a zero age.
 */
export function getFundingVelocity(invoice: Invoice): number {
  const elapsed = elapsedMsSinceCreation(invoice);
  if (elapsed === null || elapsed < MS_PER_SECOND) return 0;

  return Number(invoice.funded) / (elapsed / MS_PER_DAY);
}

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
