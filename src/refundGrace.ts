import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type { Invoice } from "./types.js";
import { RefundGraceError } from "./errors.js";

export interface RefundStatus {
  canRefund: boolean;
  refundAvailableAt: number;
  gracePeriodSecs: number;
}

export interface CanRefundOptions {
  gracePeriodSecs?: number;
  useOnChainTime?: boolean;
  server?: SorobanRpc.Server;
  /**
   * Unix timestamp (seconds) the grace period countdown started from.
   *
   * When omitted, the countdown is measured from `invoice.deadline`. A partial
   * refund resets this to the time it was applied (see {@link applyPartialRefund}),
   * so subsequent full-refund eligibility is evaluated from that reset point
   * rather than the original deadline.
   */
  graceStartedAt?: number;
}

/** Result of applying a partial refund: a fresh {@link RefundStatus} plus the reset grace anchor. */
export interface PartialRefundResult extends RefundStatus {
  /** Unix timestamp (seconds) the grace period countdown was reset to. */
  graceStartedAt: number;
}

// === Time source ===

/** Resolve "now" in seconds, using ledger time when requested and a server is available. */
async function resolveNow(options: CanRefundOptions): Promise<number> {
  return options.useOnChainTime && options.server
    ? getLedgerTime(options.server)
    : Math.floor(Date.now() / 1000);
}

/** The point the grace countdown runs from: an explicit reset anchor, else the invoice deadline. */
function graceAnchor(invoice: Invoice, options: CanRefundOptions): number {
  return options.graceStartedAt ?? invoice.deadline;
}

// === Refund eligibility ===

export async function canRefund(
  invoice: Invoice,
  options: CanRefundOptions = {},
): Promise<RefundStatus> {
  const gracePeriodSecs = options.gracePeriodSecs ?? 0;
  const refundAvailableAt = graceAnchor(invoice, options) + gracePeriodSecs;

  if (invoice.status !== "Pending") {
    return { canRefund: false, refundAvailableAt, gracePeriodSecs };
  }

  const now = await resolveNow(options);

  return { canRefund: now >= refundAvailableAt, refundAvailableAt, gracePeriodSecs };
}

/**
 * Apply a partial refund: reset the grace period countdown to the current
 * timestamp and re-evaluate full-refund eligibility from that reset point.
 *
 * The grace period *duration* (`gracePeriodSecs`) is unchanged; only the
 * instant it is measured from moves forward to now. Callers should persist the
 * returned `graceStartedAt` and pass it back via {@link CanRefundOptions} on
 * later {@link canRefund} calls.
 */
export async function applyPartialRefund(
  invoice: Invoice,
  options: CanRefundOptions = {},
): Promise<PartialRefundResult> {
  const gracePeriodSecs = options.gracePeriodSecs ?? 0;
  const graceStartedAt = await resolveNow(options);
  const status = await canRefund(invoice, { ...options, graceStartedAt });

  return { ...status, gracePeriodSecs, graceStartedAt };
}

async function getLedgerTime(server: SorobanRpc.Server): Promise<number> {
  const ledger = await server.getLatestLedger();
  const raw = ledger as { closedAt?: string };
  if (!raw.closedAt) {
    throw new RefundGraceError("RPC getLatestLedger did not return closedAt; cannot determine ledger time");
  }
  return Math.floor(new Date(raw.closedAt).getTime() / 1000);
}
