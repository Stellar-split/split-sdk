import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type { Invoice } from "./types.js";
import { RefundGraceError } from "./errors.js";

/** Release state of a single tranche. */
export type TrancheStatus = "released" | "available" | "future";

/**
 * Configuration for a single payment tranche.
 *
 * StellarSplit supports two tranche models, and both are handled by
 * {@link getTrancheProgress}:
 *
 * - **Creator-staged**: the creator manually releases each tranche. Such a
 *   tranche has no `releaseAt` and is considered `available` until the creator
 *   marks it `released`.
 * - **Time-based**: each tranche unlocks at a fixed `releaseAt` timestamp. It is
 *   `future` until the current ledger time reaches `releaseAt`, then
 *   `available`, and finally `released` once released on-chain.
 */
export interface TrancheConfig {
  /** Share of the invoice this tranche unlocks, in basis points (1 bps = 0.01%). */
  basisPoints: number;
  /** Unix timestamp (seconds) at which the tranche unlocks. Omitted for creator-staged tranches. */
  releaseAt?: number;
  /** True once the tranche has been released on-chain. */
  released?: boolean;
}

/** Invoice extended with an optional tranche schedule. */
export interface TranchedInvoice extends Invoice {
  /** Ordered list of tranches. Index 0 is the first tranche. */
  tranches?: TrancheConfig[];
}

/** Release progress for a single tranche. */
export interface TrancheProgress {
  /** Zero-based index of the tranche in the schedule. */
  tranche: number;
  /** Share of the invoice this tranche unlocks, in basis points. */
  basisPoints: number;
  /** Unix timestamp (seconds) at which the tranche unlocks, or null for creator-staged tranches. */
  releaseAt: number | null;
  /** Current release state of the tranche. */
  status: TrancheStatus;
}

/** Aggregated release progress across all of an invoice's tranches. */
export interface TrancheProgressReport {
  /** Per-tranche progress, in schedule order. */
  tranches: TrancheProgress[];
  /** Total basis points released across all `released` tranches. */
  releasedBps: number;
}

/** Options controlling how the current time is determined. */
export interface TrancheProgressOptions {
  /**
   * When provided alongside `server`, availability is evaluated against the
   * latest on-chain ledger close time instead of the local system clock.
   */
  useOnChainTime?: boolean;
  /** Soroban RPC server used to read the latest ledger time. */
  server?: SorobanRpc.Server;
  /** Explicit Unix timestamp (seconds) to evaluate against. Overrides all other sources. */
  now?: number;
}

/**
 * Compute the release progress across all of an invoice's tranches.
 *
 * Returns one entry per tranche describing whether it has been released, is
 * available to release now, or is still future-dated, plus the total basis
 * points already released. Works with both creator-staged and time-based
 * tranche configurations.
 *
 * @param invoice - The invoice (optionally carrying a `tranches` schedule).
 * @param options - Optional time source for the availability check.
 * @returns The per-tranche progress and the total released basis points.
 */
export async function getTrancheProgress(
  invoice: Invoice,
  options: TrancheProgressOptions = {},
): Promise<TrancheProgressReport> {
  const tranches = (invoice as TranchedInvoice).tranches ?? [];

  const now =
    options.now ??
    (options.useOnChainTime && options.server
      ? await getLedgerTime(options.server)
      : Math.floor(Date.now() / 1000));

  const progress: TrancheProgress[] = tranches.map((tranche, index) => ({
    tranche: index,
    basisPoints: tranche.basisPoints,
    releaseAt: tranche.releaseAt ?? null,
    status: classifyTranche(tranche, now),
  }));

  const releasedBps = progress.reduce(
    (total, t) => (t.status === "released" ? total + t.basisPoints : total),
    0,
  );

  return { tranches: progress, releasedBps };
}

/**
 * Classify a single tranche's release state.
 *
 * - An explicitly `released` tranche is always `released`.
 * - A time-based tranche (has `releaseAt`) is `available` once the current time
 *   reaches `releaseAt`, otherwise `future`.
 * - A creator-staged tranche (no `releaseAt`) is `available` until released.
 */
function classifyTranche(tranche: TrancheConfig, now: number): TrancheStatus {
  if (tranche.released) return "released";
  if (tranche.releaseAt !== undefined) {
    return now >= tranche.releaseAt ? "available" : "future";
  }
  return "available";
}

/** Read the latest ledger close time (Unix seconds) from a Soroban RPC server. */
async function getLedgerTime(server: SorobanRpc.Server): Promise<number> {
  const ledger = await server.getLatestLedger();
  const raw = ledger as { closedAt?: string };
  if (!raw.closedAt) {
    throw new RefundGraceError("RPC getLatestLedger did not return closedAt; cannot determine ledger time");
  }
  return Math.floor(new Date(raw.closedAt).getTime() / 1000);
}