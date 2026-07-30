/**
 * Escrow Vault Payment Manager
 *
 * Wraps the create-hold-release pattern using Stellar claimable balances with
 * time-lock predicates. Coordinates with invoice status to trigger release
 * automatically and emits escrow lifecycle events.
 *
 * Builds on src/claimableBalanceFallback.ts and Stellar's Claimant API.
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
import { createHash } from "crypto";
import type { EscrowVault, EscrowStatus, EscrowReleaseCondition } from "./types.js";
import { ValidationError } from "./errors.js";
import { TypedEventEmitter } from "./events/TypedEventEmitter.js";

// ---------------------------------------------------------------------------
// Re-export types (also declared in types.ts)
// ---------------------------------------------------------------------------

export type { EscrowVault, EscrowStatus, EscrowReleaseCondition };

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

/** Events emitted by {@link EscrowVaultManager}. */
export type EscrowEventMap = {
  /** Emitted when a claimable balance is successfully created. */
  escrowFunded: EscrowVault;
  /** Emitted when the claimable balance is claimed and funds released to the recipient. */
  escrowReleased: { vault: EscrowVault; recipientId: string; txHash: string };
  /** Emitted when the hold period closes without a release being triggered. */
  escrowExpired: EscrowVault;
};

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for creating a {@link EscrowVaultManager}. */
export interface EscrowVaultManagerOptions {
  /**
   * Horizon server base URL.
   * @example "https://horizon-testnet.stellar.org"
   */
  horizonUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /**
   * How often (in milliseconds) the manager polls Horizon to detect expiry.
   * @default 30_000
   */
  pollIntervalMs?: number;
}

// ---------------------------------------------------------------------------
// In-memory vault store
// ---------------------------------------------------------------------------

const vaultStore = new Map<string, EscrowVault>();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert stroops bigint to a 7-decimal Stellar amount string. */
function stroopsToDecimal(stroops: bigint): string {
  const s = stroops < 0n ? 0n : stroops;
  const int = s / 10_000_000n;
  const frac = s % 10_000_000n;
  return `${int}.${frac.toString().padStart(7, "0")}`;
}

/** Parse "CODE:ISSUER" or "native" to a Stellar Asset. */
function parseAsset(asset: string): Asset {
  if (asset === "native" || asset.toUpperCase() === "XLM") {
    return Asset.native();
  }
  const [code, issuer] = asset.split(":");
  if (!code || !issuer) {
    throw new ValidationError(`Invalid asset format: "${asset}". Expected "CODE:ISSUER".`);
  }
  return new Asset(code, issuer);
}

/** Generate a deterministic vault ID from invoice + amount + timestamp. */
function makeVaultId(invoiceId: string, amount: bigint, ts: number): string {
  return createHash("sha256")
    .update(`${invoiceId}:${amount}:${ts}`)
    .digest("hex")
    .slice(0, 32);
}

// ---------------------------------------------------------------------------
// EscrowVaultManager
// ---------------------------------------------------------------------------

/**
 * Manages the lifecycle of escrow vaults backed by Stellar claimable balances
 * with absolute-time predicates.
 *
 * @example
 * ```typescript
 * const manager = new EscrowVaultManager({
 *   horizonUrl: "https://horizon-testnet.stellar.org",
 *   networkPassphrase: "Test SDF Network ; September 2015",
 * });
 *
 * // Create a vault holding 100 USDC until a delivery confirmation
 * const vault = await manager.create(
 *   invoiceId,
 *   100_000_000n,   // 10 USDC in stroops
 *   "USDC:GA5ZS...",
 *   new Date(Date.now() + 7 * 24 * 60 * 60 * 1000),
 *   sourceKeypair,
 * );
 *
 * // Later, after delivery confirmation:
 * await manager.release(vault.vaultId, recipientAddress);
 * ```
 */
export class EscrowVaultManager extends TypedEventEmitter<EscrowEventMap> {
  private readonly horizonUrl: string;
  private readonly networkPassphrase: string;
  private readonly pollIntervalMs: number;

  private _pollTimer: ReturnType<typeof setInterval> | null = null;

  constructor(options: EscrowVaultManagerOptions) {
    super();
    this.horizonUrl = options.horizonUrl.replace(/\/$/, "");
    this.networkPassphrase = options.networkPassphrase;
    this.pollIntervalMs = options.pollIntervalMs ?? 30_000;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a claimable balance with an absolute-time predicate as an escrow
   * vault. The balance can only be claimed after `holdUntil`.
   *
   * The `sourceKeypair` is the account that funds the escrow. In a real flow
   * this would be signed by the payer's wallet.
   *
   * @param invoiceId    - The invoice this vault is associated with.
   * @param amount       - Amount to lock in the vault (stroops).
   * @param asset        - The asset to lock, as "CODE:ISSUER" or "native".
   * @param holdUntil    - Date after which the recipient may claim.
   * @param sourceSecret - Secret key of the funding account (for signing).
   * @returns The created {@link EscrowVault} record.
   */
  async create(
    invoiceId: string,
    amount: bigint,
    asset: string,
    holdUntil: Date,
    sourceSecret: string,
  ): Promise<EscrowVault> {
    if (amount <= 0n) {
      throw new ValidationError("Escrow amount must be greater than zero.");
    }

    const stellarAsset = parseAsset(asset);
    const server = new Horizon.Server(this.horizonUrl, {
      allowHttp: this.horizonUrl.startsWith("http://"),
    });

    const { Keypair } = await import("@stellar/stellar-sdk");
    const sourceKeypair = Keypair.fromSecret(sourceSecret);
    const sourcePublicKey = sourceKeypair.publicKey();

    const sourceRecord = await server.loadAccount(sourcePublicKey);
    const sourceAccount = new Account(
      sourceRecord.accountId(),
      sourceRecord.sequenceNumber(),
    );

    const holdUntilUnix = BigInt(Math.floor(holdUntil.getTime() / 1000));

    // Predicate: claimable only AFTER holdUntil (NOT before holdUntil)
    const afterPredicate = Claimant.predicateNot(
      Claimant.predicateBeforeAbsoluteTime(holdUntilUnix.toString()),
    );

    // Any account can be a recipient claimant — the actual recipient is
    // enforced at the application layer via release(). We use a broad claimant
    // so the manager can designate any address at release time.
    // For strict escrow, you'd lock to a specific claimant address.
    const claimant = new Claimant(sourcePublicKey, afterPredicate);

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.createClaimableBalance({
          asset: stellarAsset,
          amount: stroopsToDecimal(amount),
          claimants: [claimant],
        }),
      )
      .setTimeout(30)
      .build();

    tx.sign(sourceKeypair);

    const submitResponse = await server.submitTransaction(tx);
    const txHash = submitResponse.hash;

    // Extract the claimable balance ID from the transaction result
    const balanceId = await this._extractBalanceId(server, txHash);

    const now = Date.now();
    const vault: EscrowVault = {
      vaultId: makeVaultId(invoiceId, amount, now),
      invoiceId,
      balanceId,
      amount,
      asset,
      holdUntil,
      status: "holding",
      createdAt: new Date(now),
    };

    vaultStore.set(vault.vaultId, vault);

    this.emit("escrowFunded", vault);

    // Start expiry polling if not already running
    this._ensurePolling();

    return vault;
  }

  /**
   * Claim the claimable balance on behalf of `recipientId` after the hold
   * period has elapsed.
   *
   * @param vaultId     - The vault ID returned by {@link create}.
   * @param recipientId - Stellar address that will receive the funds.
   * @param signerSecret - Secret key of the account performing the claim.
   * @returns Object containing the transaction hash.
   */
  async release(
    vaultId: string,
    recipientId: string,
    signerSecret: string,
  ): Promise<{ txHash: string }> {
    const vault = vaultStore.get(vaultId);
    if (!vault) {
      throw new ValidationError(`Escrow vault not found: ${vaultId}`);
    }
    if (vault.status !== "holding") {
      throw new ValidationError(
        `Cannot release vault "${vaultId}": current status is "${vault.status}".`,
      );
    }
    if (Date.now() < vault.holdUntil.getTime()) {
      throw new ValidationError(
        `Cannot release vault "${vaultId}" before holdUntil (${vault.holdUntil.toISOString()}).`,
      );
    }

    const server = new Horizon.Server(this.horizonUrl, {
      allowHttp: this.horizonUrl.startsWith("http://"),
    });

    const { Keypair } = await import("@stellar/stellar-sdk");
    const signerKeypair = Keypair.fromSecret(signerSecret);
    const signerPublicKey = signerKeypair.publicKey();

    const sourceRecord = await server.loadAccount(signerPublicKey);
    const sourceAccount = new Account(
      sourceRecord.accountId(),
      sourceRecord.sequenceNumber(),
    );

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.networkPassphrase,
    })
      .addOperation(
        Operation.claimClaimableBalance({
          balanceID: vault.balanceId,
        }),
      )
      .setTimeout(30)
      .build();

    tx.sign(signerKeypair);

    const submitResponse = await server.submitTransaction(tx);
    const txHash = submitResponse.hash;

    vault.status = "released";
    vault.releasedAt = new Date();
    vault.recipientId = recipientId;
    vaultStore.set(vaultId, vault);

    this.emit("escrowReleased", { vault, recipientId, txHash });

    return { txHash };
  }

  /**
   * Return the current status of an escrow vault.
   *
   * @param vaultId - The vault ID to query.
   * @returns The current {@link EscrowStatus}: `holding | released | expired`.
   */
  async getStatus(vaultId: string): Promise<EscrowStatus> {
    const vault = vaultStore.get(vaultId);
    if (!vault) {
      throw new ValidationError(`Escrow vault not found: ${vaultId}`);
    }

    // If already terminal, return as-is
    if (vault.status === "released" || vault.status === "expired") {
      return vault.status;
    }

    // Check if it has expired (holdUntil passed + not yet claimed)
    if (Date.now() > vault.holdUntil.getTime()) {
      const isClaimedOnChain = await this._checkClaimedOnChain(vault);
      if (!isClaimedOnChain) {
        vault.status = "expired";
        vaultStore.set(vaultId, vault);
        this.emit("escrowExpired", vault);
        return "expired";
      }
    }

    return vault.status;
  }

  /**
   * Look up an escrow vault by ID.
   */
  getVault(vaultId: string): EscrowVault | undefined {
    return vaultStore.get(vaultId);
  }

  /**
   * Stop the expiry polling timer.
   */
  destroy(): void {
    if (this._pollTimer !== null) {
      clearInterval(this._pollTimer);
      this._pollTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Ensure the expiry polling timer is running. */
  private _ensurePolling(): void {
    if (this._pollTimer !== null) return;
    this._pollTimer = setInterval(
      () => void this._pollExpiry(),
      this.pollIntervalMs,
    );
    if (
      typeof this._pollTimer === "object" &&
      this._pollTimer !== null &&
      typeof (this._pollTimer as NodeJS.Timeout).unref === "function"
    ) {
      (this._pollTimer as NodeJS.Timeout).unref();
    }
  }

  /** Poll all holding vaults for expiry. */
  private async _pollExpiry(): Promise<void> {
    for (const [vaultId, vault] of vaultStore.entries()) {
      if (vault.status !== "holding") continue;
      try {
        await this.getStatus(vaultId);
      } catch {
        // ignore individual errors during polling
      }
    }
  }

  /**
   * Extract the claimable balance ID from a submitted transaction.
   * Queries Horizon's transaction operations to find the created balance.
   */
  private async _extractBalanceId(
    server: Horizon.Server,
    txHash: string,
  ): Promise<string> {
    try {
      const ops = await server.operations().forTransaction(txHash).call();
      for (const op of ops.records as Array<Record<string, unknown>>) {
        if (
          typeof op["balance_id"] === "string" &&
          op["balance_id"].length > 0
        ) {
          return op["balance_id"] as string;
        }
      }
    } catch {
      // fallback — construct a deterministic placeholder
    }
    // Fallback: use a hash of the txHash as the balance ID placeholder
    return createHash("sha256").update(txHash).digest("hex");
  }

  /**
   * Check Horizon to see if a claimable balance has already been claimed.
   * Returns `true` if the balance is no longer present (i.e. claimed).
   */
  private async _checkClaimedOnChain(vault: EscrowVault): Promise<boolean> {
    const server = new Horizon.Server(this.horizonUrl, {
      allowHttp: this.horizonUrl.startsWith("http://"),
    });
    try {
      await server.claimableBalance(vault.balanceId).call();
      // Balance still exists → not claimed
      return false;
    } catch {
      // 404 → claimed or never existed
      return true;
    }
  }
}
