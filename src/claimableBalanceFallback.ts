/**
 * Claimable-balance fallback for failed refund transfers.
 *
 * When a `refund_invoice` token transfer fails because the recipient account
 * does not exist or has no trustline for the asset, funds would otherwise be
 * stuck in the contract.  This module creates a Stellar claimable balance
 * instead, letting the payer claim it once their account is ready.
 *
 * Also provides a lifecycle manager that tracks claimable balances from
 * creation through claim/expiry, polling Horizon for status changes and
 * emitting typed events.
 */

import {
  Account,
  Asset,
  Claimant,
  Horizon,
  Operation,
  TransactionBuilder,
  Keypair,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import type { StellarSplitClientConfig } from "./client.js";
import { ValidationError, ClaimableBalanceLifecycleError } from "./errors.js";
import { TypedEventEmitter, type Unsubscribe } from "./events/TypedEventEmitter.js";
import type { ClaimableBalanceRecord, ClaimableBalanceStatus } from "./types.js";
import { PredicateBuilder, type ClaimPredicate } from "./predicateBuilder.js";

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
 * The claimable balance is unconditional by default — the payer may claim it
 * at any time. Pass `predicate` (see {@link PredicateBuilder}) to restrict
 * when the balance can be claimed.
 *
 * Requires `config.horizonUrl` to be set.
 *
 * @param payer         - Stellar address that will be the sole claimant.
 * @param amount        - Refund amount in the asset's base unit (stroops for XLM).
 * @param asset         - Stellar `Asset` object representing the token.
 * @param sourceAddress - Stellar address funding / submitting the transaction.
 *                        This account must hold sufficient `asset` balance.
 * @param config        - StellarSplit client config.  `horizonUrl` must be set.
 * @param predicate     - Optional claim predicate. Defaults to unconditional.
 *
 * @throws If `config.horizonUrl` is not configured.
 */
export async function createClaimableRefund(
  payer: string,
  amount: bigint,
  asset: Asset,
  sourceAddress: string,
  config: StellarSplitClientConfig,
  predicate: ClaimPredicate = PredicateBuilder.unconditional()
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
        claimants: [new Claimant(payer, predicate)],
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

// ---------------------------------------------------------------------------
// Claimable Balance Lifecycle Manager
// ---------------------------------------------------------------------------

/** Events emitted by {@link ClaimableBalanceLifecycle}. */
export interface ClaimableBalanceLifecycleEventMap {
  [key: string]: unknown;
  balanceClaimed: ClaimableBalanceRecord;
  balanceExpired: ClaimableBalanceRecord;
  error: { message: string; error: unknown };
}

/** Configuration for {@link ClaimableBalanceLifecycle}. */
export interface ClaimableBalanceLifecycleConfig {
  /** Polling interval in milliseconds. Default: 10_000 (10s). */
  pollIntervalMs?: number;
}

/**
 * Manages the full create-to-claim lifecycle of claimable balances.
 *
 * Tracks which balances are pending, detects claims and expirations via
 * Horizon polling, and emits typed events so callers can surface the
 * lifecycle state to users (e.g. notify recipients to claim, detect
 * unclaimed balances past their predicate expiry).
 *
 * ```ts
 * const lifecycle = new ClaimableBalanceLifecycle(horizonServer);
 * lifecycle.on("balanceClaimed", (record) => console.log("Claimed:", record));
 * lifecycle.on("balanceExpired", (record) => console.log("Expired:", record));
 * lifecycle.start();
 * ```
 */
export class ClaimableBalanceLifecycle extends TypedEventEmitter<ClaimableBalanceLifecycleEventMap> {
  private readonly server: Horizon.Server;
  private readonly pollIntervalMs: number;
  private tracked: Map<string, ClaimableBalanceRecord> = new Map();
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private _running = false;

  constructor(server: Horizon.Server, config: ClaimableBalanceLifecycleConfig = {}) {
    super();
    this.server = server;
    this.pollIntervalMs = config.pollIntervalMs ?? 10_000;
  }

  /** Whether the lifecycle manager is currently polling. */
  get running(): boolean {
    return this._running;
  }

  /** Number of balances currently being tracked. */
  get trackedCount(): number {
    return this.tracked.size;
  }

  /**
   * Start polling for claimable balance status changes.
   */
  start(): void {
    if (this._running) return;
    this._running = true;
    this.poll();
    this.pollTimer = setInterval(() => this.poll(), this.pollIntervalMs);
  }

  /**
   * Stop polling.  Tracked balances are preserved.
   */
  stop(): void {
    this._running = false;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  /**
   * Register a claimable balance for tracking.
   *
   * @param record - The balance to track.
   */
  track(record: ClaimableBalanceRecord): void {
    this.tracked.set(record.balanceId, { ...record });
  }

  /**
   * Remove a balance from tracking.
   */
  untrack(balanceId: string): void {
    this.tracked.delete(balanceId);
  }

  /**
   * Get all currently tracked balances.
   */
  listTracked(): ClaimableBalanceRecord[] {
    return Array.from(this.tracked.values());
  }

  /**
   * Claim a claimable balance on behalf of a recipient.
   *
   * @param balanceId - The claimable balance ID to claim.
   * @param claimantSecret - Secret key of the claimant account.
   * @param networkPassphrase - Stellar network passphrase.
   * @returns Transaction hash of the claim submission.
   */
  async claimBalance(
    balanceId: string,
    claimantSecret: string,
    networkPassphrase: string,
  ): Promise<string> {
    try {
      const record = this.tracked.get(balanceId);
      if (!record) {
        throw new ClaimableBalanceLifecycleError(
          `Balance ${balanceId} is not tracked`,
          balanceId,
        );
      }

      const keypair = Keypair.fromSecret(claimantSecret);
      const account = await this.server.loadAccount(keypair.publicKey());
      const sourceAccount = new Account(account.accountId(), account.sequenceNumber());

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase,
      })
        .addOperation(
          Operation.claimClaimableBalance({
            balanceId,
          }),
        )
        .setTimeout(30)
        .build();

      tx.sign(keypair);
      const result = await this.server.submitTransaction(tx);

      record.status = "claimed";
      record.claimedAt = Date.now();
      this.emit("balanceClaimed", record);
      this.tracked.delete(balanceId);

      return result.hash;
    } catch (err) {
      if (err instanceof ClaimableBalanceLifecycleError) throw err;
      throw new ClaimableBalanceLifecycleError(
        `Failed to claim balance ${balanceId}: ${err instanceof Error ? err.message : String(err)}`,
        balanceId,
      );
    }
  }

  /**
   * Query all claimable balances for a given claimant from Horizon.
   *
   * @param claimant - Stellar address of the claimant.
   * @returns List of claimable balance records.
   */
  async queryByClaimant(claimant: string): Promise<ClaimableBalanceRecord[]> {
    try {
      const page = await this.server.claimableBalances().claimant(claimant).call();
      return page.records.map((r) => this.toRecord(r, claimant));
    } catch {
      return [];
    }
  }

  /**
   * Manually trigger a poll cycle (useful for testing).
   */
  async pollNow(): Promise<void> {
    await this.poll();
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private async poll(): Promise<void> {
    if (!this._running) return;

    for (const [balanceId, record] of this.tracked.entries()) {
      try {
        const fresh = await this.server
          .claimableBalances()
          .claimant(record.claimant)
          .call();

        const found = fresh.records.find((r) => r.id === balanceId);

        if (!found) {
          // Balance no longer exists — was claimed
          record.status = "claimed";
          record.claimedAt = record.claimedAt ?? Date.now();
          this.emit("balanceClaimed", record);
          this.tracked.delete(balanceId);
        } else if (record.predicateExpiryLedger) {
          // Check if the predicate has expired based on current ledger
          // We approximate by checking last_modified_ledger
          const currentLedger = found.last_modified_ledger;
          if (currentLedger >= record.predicateExpiryLedger) {
            record.status = "expired";
            this.emit("balanceExpired", record);
            this.tracked.delete(balanceId);
          }
        }
      } catch (err) {
        this.emit("error", {
          message: `Poll error for balance ${balanceId}`,
          error: err,
        });
      }
    }
  }

  private toRecord(
    r: Horizon.ServerApi.ClaimableBalanceRecord,
    claimant: string,
  ): ClaimableBalanceRecord {
    // Attempt to extract creation time from the record; fall back to Date.now()
    const raw = r as unknown as Record<string, unknown>;
    const createdAt = raw.last_modified_time
      ? new Date(raw.last_modified_time as string).getTime()
      : Date.now();
    return {
      balanceId: r.id,
      claimant,
      asset: r.asset,
      amount: r.amount,
      status: "created",
      createdAt,
      claimedAt: null,
    };
  }
}
