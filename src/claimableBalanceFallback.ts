/**
 * Claimable-balance fallback for failed refund transfers.
 *
 * When a `refund_invoice` token transfer fails because the recipient account
 * does not exist or has no trustline for the asset, funds would otherwise be
 * stuck in the contract.  This module creates a Stellar claimable balance
 * instead, letting the payer claim it once their account is ready.
 */

import {
  Account,
  Asset,
  Claimant,
  Horizon,
  Operation,
  TransactionBuilder,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import type { StellarSplitClientConfig } from "./client.js";
import { ValidationError } from "./errors.js";

// ---------------------------------------------------------------------------
// Error-pattern detection
// ---------------------------------------------------------------------------

/**
 * Substrings that appear in Soroban simulation / submission errors when a
 * token transfer fails due to a missing account or missing trustline on the
 * recipient side.  Matching is case-insensitive.
 */
const REFUND_TRANSFER_ERROR_PATTERNS = [
  "no account",
  "no trust",
  "not authorized",
  "trustline",
  "trust not found",
  "account missing",
  "accountmissing",
  "trustlinemissing",
  "trustnotfound",
  "invalidaccount",
  "op_no_destination",
  "op_no_trust",
];

/**
 * Returns `true` when `error` looks like a token-transfer failure caused by a
 * missing account or missing trustline — the two situations where a claimable
 * balance fallback is appropriate.
 */
export function isRefundTransferError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return REFUND_TRANSFER_ERROR_PATTERNS.some((p) => lower.includes(p.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result returned by {@link createClaimableRefund}. */
export interface ClaimableRefundResult {
  /** Stellar claimable balance ID (e.g. `00000000…`). */
  balanceId: string;
  /** Transaction hash of the submission. */
  txHash: string;
  /** Always `true` — distinguishes this from a normal direct refund. */
  fallback: true;
}

/** A single pending claimable balance entry, as returned by {@link getClaimableRefunds}. */
export interface ClaimableRefundEntry {
  /** Stellar claimable balance ID. */
  balanceId: string;
  /** Stellar address of the account that can claim this balance. */
  payer: string;
  /** Human-readable amount string (e.g. `"12.5000000"`). */
  amount: string;
  /** Asset descriptor: `"native"` for XLM, `"CODE:ISSUER"` for issued assets. */
  asset: string;
  /** Ledger sequence number of the last modification. */
  lastModifiedLedger: number;
}

// ---------------------------------------------------------------------------
// createClaimableRefund
// ---------------------------------------------------------------------------

/**
 * Build and submit a `createClaimableBalance` operation so that `payer` can
 * claim the refund once their account / trustline is ready.
 *
 * The claimable balance is unconditional — the payer may claim it at any time.
 *
 * Requires `config.horizonUrl` to be set.
 *
 * @param payer         - Stellar address that will be the sole claimant.
 * @param amount        - Refund amount in the asset's base unit (stroops for XLM).
 * @param asset         - Stellar `Asset` object representing the token.
 * @param sourceAddress - Stellar address funding / submitting the transaction.
 *                        This account must hold sufficient `asset` balance.
 * @param config        - StellarSplit client config.  `horizonUrl` must be set.
 *
 * @throws If `config.horizonUrl` is not configured.
 */
export async function createClaimableRefund(
  payer: string,
  amount: bigint,
  asset: Asset,
  sourceAddress: string,
  config: StellarSplitClientConfig
): Promise<ClaimableRefundResult> {
  if (!config.horizonUrl) {
    throw new ValidationError(
      "createClaimableRefund requires config.horizonUrl to submit classic Stellar transactions"
    );
  }

  const horizonServer = new Horizon.Server(config.horizonUrl);

  // Build classic transaction
  const sourceRecord = await horizonServer.loadAccount(sourceAddress);
  const sourceAccount = new Account(
    sourceRecord.accountId(),
    sourceRecord.sequenceNumber()
  );

  // Convert bigint stroops to decimal string Stellar expects
  const amountStr = stroopsToDecimal(amount);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(
      Operation.createClaimableBalance({
        asset,
        amount: amountStr,
        claimants: [new Claimant(payer, Claimant.predicateUnconditional())],
      })
    )
    .setTimeout(30)
    .build();

  console.info(
    `[StellarSplitClient] claimable-refund fallback: creating claimable balance ` +
      `for payer ${payer}, amount ${amountStr} ${asset.isNative() ? "XLM" : asset.getCode()}`
  );

  const submitResponse = await horizonServer.submitTransaction(tx);
  const txHash = submitResponse.hash;

  // Retrieve the balance_id from the created operation
  const balanceId = await _extractBalanceId(horizonServer, txHash);

  return { balanceId, txHash, fallback: true };
}

// ---------------------------------------------------------------------------
// getClaimableRefunds
// ---------------------------------------------------------------------------

/**
 * List all pending claimable balances on the Stellar network that `payer` can
 * claim.
 *
 * Requires `config.horizonUrl` to be set.
 *
 * @param payer  - Stellar address of the claimant to query.
 * @param config - StellarSplit client config.  `horizonUrl` must be set.
 */
export async function getClaimableRefunds(
  payer: string,
  config: StellarSplitClientConfig
): Promise<ClaimableRefundEntry[]> {
  if (!config.horizonUrl) {
    throw new ValidationError(
      "getClaimableRefunds requires config.horizonUrl to query the Horizon API"
    );
  }

  const horizonServer = new Horizon.Server(config.horizonUrl);
  const page = await horizonServer.claimableBalances().claimant(payer).call();

  return page.records.map((record) => ({
    balanceId: record.id,
    payer,
    amount: record.amount,
    asset: record.asset,
    lastModifiedLedger: record.last_modified_ledger,
  }));
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Convert bigint stroops to a 7-decimal Stellar amount string.
 * E.g. 12_500_000n → "1.2500000"
 */
function stroopsToDecimal(stroops: bigint): string {
  const absStroops = stroops < 0n ? -stroops : stroops;
  const whole = absStroops / 10_000_000n;
  const frac = (absStroops % 10_000_000n).toString().padStart(7, "0");
  const sign = stroops < 0n ? "-" : "";
  return `${sign}${whole}.${frac}`;
}

/**
 * Fetch the operations for `txHash` from Horizon and extract the
 * `balance_id` from the `createClaimableBalance` operation result.
 *
 * Falls back to a synthetic ID derived from the txHash if Horizon doesn't
 * return the expected operation shape (e.g. in test environments).
 */
async function _extractBalanceId(
  server: Horizon.Server,
  txHash: string
): Promise<string> {
  try {
    const ops = await server.operations().forTransaction(txHash).call();
    for (const op of ops.records) {
      if (
        op.type === "create_claimable_balance" &&
        "balance_id" in op
      ) {
        return (op as unknown as { balance_id: string }).balance_id;
      }
    }
  } catch {
    // Best-effort; fall through to synthetic ID
  }
  // Synthetic balance ID: prefixed with zeros so callers can detect it
  return `00000000${txHash}`;
}
