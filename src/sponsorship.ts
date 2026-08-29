/**
 * Sponsored-reserve transaction builder for StellarSplit onboarding.
 *
 * New Stellar accounts need a minimum XLM reserve for each ledger entry
 * (trustlines, data entries, etc.).  This module lets a pre-funded sponsor
 * account cover those reserves via the Stellar protocol's
 * beginSponsoringFutureReserves / endSponsoringFutureReserves operation pair,
 * so a brand-new payer can fund an invoice without first acquiring XLM.
 */

import {
  Account,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  Horizon,
  xdr,
} from "@stellar/stellar-sdk";
import type { Transaction } from "@stellar/stellar-sdk";
import type { StellarSplitClientConfig } from "./client.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** One base reserve in stroops (0.5 XLM). */
const BASE_RESERVE_STROOPS = 5_000_000n;

/**
 * Minimum XLM balance a sponsor must retain after funding sponsored entries.
 * Stellar requires every account to maintain 2 × base reserve = 1 XLM.
 */
const SPONSOR_MIN_BALANCE_STROOPS = 10_000_000n;

// ---------------------------------------------------------------------------
// Error types
// ---------------------------------------------------------------------------

import { StellarSplitError } from "./errors.js";

/** Thrown when `config.sponsorAccount` is absent. */
export class MissingSponsorAccountError extends StellarSplitError {
  constructor() {
    super(
      "config.sponsorAccount is required for sponsored onboarding — " +
        "set it in StellarSplitClientConfig before calling buildSponsoredOnboarding."
    );
    this.name = "MissingSponsorAccountError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the sponsor's on-chain XLM balance is too low. */
export class InsufficientReserveError extends StellarSplitError {
  readonly availableStroops: bigint;
  readonly requiredStroops: bigint;

  constructor(available: bigint, required: bigint) {
    super(
      `Sponsor has insufficient XLM reserve: ` +
        `${available} stroops available, ${required} stroops required ` +
        `(${required - available} stroops short).`
    );
    this.name = "InsufficientReserveError";
    this.availableStroops = available;
    this.requiredStroops = required;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

import { checkSponsorReserve as _checkSponsorReserve } from "./preflightChecker.js";
import type { SponsorshipConfig, SponsorReserveCheckResult } from "./types.js";

// ---------------------------------------------------------------------------
// SponsorshipUsed event
// ---------------------------------------------------------------------------

/**
 * Event payload emitted after a sponsored transaction is successfully submitted.
 *
 * The `feeSource` field identifies the **sponsor** account that covered the
 * transaction fee — not the submitter of the envelope.
 */
export interface SponsorshipUsedEvent {
  /** Stellar address of the account that sponsored the reserves/fees. */
  feeSource: string;
  /** Stellar address of the newly-onboarded account whose reserves were sponsored. */
  newAccount: string;
  /** Transaction hash returned by the RPC node after submission. */
  txHash: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Convert a Horizon balance string ("1.0000000") to stroops (bigint).
 * Horizon always formats XLM with exactly 7 decimal places.
 */
function xlmStringToStroops(xlm: string): bigint {
  const [whole = "0", frac = ""] = xlm.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0").slice(0, 7));
}

// ---------------------------------------------------------------------------
// buildSponsoredOnboarding
// ---------------------------------------------------------------------------

/**
 * Build an unsigned sponsored-reserve onboarding transaction.
 *
 * The transaction has the following operation ordering:
 *   1. `beginSponsoringFutureReserves` (source: sponsor)
 *   2. Caller-provided `ops` (e.g. createAccount, changeTrust)
 *   3. `endSponsoringFutureReserves` (source: newAccount)
 *
 * Both `sponsor` and `newAccount` must sign the returned transaction before
 * it can be submitted (the new account's signature is required for the
 * `endSponsoringFutureReserves` operation).
 *
 * **Reserve validation** — when `config.horizonUrl` is set, the function
 * fetches the sponsor's live XLM balance via Horizon and verifies that the
 * sponsor can cover: their own minimum account balance (1 XLM) plus one base
 * reserve (0.5 XLM) per wrapped operation.  Pass `config.horizonUrl` to
 * enable this check; omit it to skip (useful in unit tests / offline signing).
 *
 * @param sponsor    - Stellar address of the sponsoring account.
 * @param newAccount - Stellar address of the account being onboarded.
 * @param ops        - Inner operations to wrap between the sponsoring ops.
 * @param config     - StellarSplit client config.  `config.sponsorAccount`
 *                     must be set, or a {@link MissingSponsorAccountError} is
 *                     thrown.
 *
 * @throws {MissingSponsorAccountError}  If `config.sponsorAccount` is not set.
 * @throws {InsufficientReserveError}    If the sponsor's XLM balance is too low
 *                                       (only when `config.horizonUrl` is set).
 */
export async function buildSponsoredOnboarding(
  sponsor: string,
  newAccount: string,
  ops: xdr.Operation[],
  config: StellarSplitClientConfig
): Promise<Transaction> {
  // Guard: sponsorship must be explicitly configured.
  if (!config.sponsorAccount) {
    throw new MissingSponsorAccountError();
  }

  // Balance check: fetch sponsor's live XLM balance from Horizon.
  if (config.horizonUrl) {
    const horizonServer = new Horizon.Server(config.horizonUrl);
    const sponsorRecord = await horizonServer.loadAccount(sponsor);

    const nativeLine = sponsorRecord.balances.find(
      (b) => b.asset_type === "native"
    );
    const balanceStroops = nativeLine
      ? xlmStringToStroops(nativeLine.balance)
      : 0n;

    // Sponsor must retain their own minimum (2 × base reserve = 1 XLM) and
    // hold one additional base reserve (0.5 XLM) for every sponsored entry.
    const requiredStroops =
      SPONSOR_MIN_BALANCE_STROOPS + BASE_RESERVE_STROOPS * BigInt(ops.length);

    if (balanceStroops < requiredStroops) {
      throw new InsufficientReserveError(balanceStroops, requiredStroops);
    }
  }

  // Use sequence "0" — the transaction is unsigned and the caller is
  // responsible for fetching the real sequence before signing.
  const sourceAccount = new Account(sponsor, "0");

  const builder = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  });

  // Op 1: begin sponsoring (source = sponsor)
  builder.addOperation(
    Operation.beginSponsoringFutureReserves({
      sponsoredId: newAccount,
      source: sponsor,
    })
  );

  // Ops 2…N: caller-provided inner operations
  for (const op of ops) {
    builder.addOperation(op);
  }

  // Op N+1: end sponsoring (source = newAccount, who must co-sign)
  builder.addOperation(
    Operation.endSponsoringFutureReserves({
      source: newAccount,
    })
  );

  builder.setTimeout(30);
  return builder.build();
}

// ---------------------------------------------------------------------------
// checkSponsorshipReserve — convenience wrapper for the preflight checker
// ---------------------------------------------------------------------------

/**
 * Convenience wrapper around {@link preflightChecker.checkSponsorReserve}
 * that accepts a {@link SponsorshipConfig} object.
 *
 * This is exported as `checkSponsorshipReserve` from the public API.
 */
export async function checkSponsorshipReserve(
  config: SponsorshipConfig,
  horizonUrl: string,
  options?: { throwOnInsufficient?: boolean },
): Promise<SponsorReserveCheckResult> {
  return _checkSponsorReserve(
    config.sponsorAddress,
    config.entryCount,
    config.horizonUrl ?? horizonUrl,
    options?.throwOnInsufficient ?? true,
  );
}

// ---------------------------------------------------------------------------
// submitSponsoredTransaction
// ---------------------------------------------------------------------------

/**
 * Submit a signed sponsored-reserve transaction to the Soroban RPC node and
 * emit a {@link SponsorshipUsedEvent}.
 *
 * **Fee attribution fix**: `feeSource` in the emitted event is set to the
 * `sponsor` address — the account that funded the reserves — NOT the address
 * that called this function.  The sponsor is always the source account of the
 * transaction envelope (set by {@link buildSponsoredOnboarding}), so it is
 * read directly from `tx.source` without any additional Horizon calls.
 *
 * @param tx         - Fully-signed sponsored transaction (built by
 *                     {@link buildSponsoredOnboarding}).
 * @param newAccount - Stellar address of the newly-onboarded account.
 * @param rpcUrl     - Soroban RPC endpoint to submit to.
 * @param onEvent    - Optional callback invoked with the {@link SponsorshipUsedEvent}
 *                     after successful submission.
 * @returns The emitted {@link SponsorshipUsedEvent} (including the `txHash`).
 */
export async function submitSponsoredTransaction(
  tx: Transaction,
  newAccount: string,
  rpcUrl: string,
  onEvent?: (event: SponsorshipUsedEvent) => void,
): Promise<SponsorshipUsedEvent> {
  const { rpc } = await import("@stellar/stellar-sdk");

  const server = new rpc.Server(rpcUrl);
  const result = await server.sendTransaction(tx);

  // tx.source is the sponsor — set by buildSponsoredOnboarding as the
  // TransactionBuilder source account.  This is the correct feeSource for
  // sponsored-reserve transactions.
  const event: SponsorshipUsedEvent = {
    feeSource: tx.source,   // ← sponsor, not the submitter's address
    newAccount,
    txHash: result.hash,
  };

  onEvent?.(event);
  return event;
}
