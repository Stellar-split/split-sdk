/**
 * AccountMergeDetector — Monitors Stellar account merges and automatically reroutes invoice recipients
 * when their accounts are merged into another account.
 *
 * Integrates with HorizonStreamManager to watch for ACCOUNT_MERGE operations.
 */

import { EventEmitter } from "events";
import type { StellarSplitClient } from "../client.js";

export interface AccountMergeEvent {
  /** The account that was merged (source) */
  sourceAccount: string;
  /** The destination account that received the merge */
  destinationAccount: string;
  /** The ledger sequence where the merge occurred */
  ledgerSequence: number;
  /** Timestamp of the merge operation */
  timestamp: Date;
}

export class InvalidDestinationError extends Error {
  constructor(
    public readonly address: string,
    public readonly reason: string,
  ) {
    super(`Invalid destination account ${address}: ${reason}`);
    this.name = "InvalidDestinationError";
  }
}

export class AccountMergeDetector extends EventEmitter {
  private watchedAccounts = new Set<string>();
  private mergeCache = new Map<string, string>(); // source -> destination mapping
  private streamActive = false;
  private checkInterval: NodeJS.Timeout | null = null;

  constructor(
    private client: StellarSplitClient,
    private horizonUrl: string,
  ) {
    super();
  }

  /**
   * Start monitoring for account merge operations.
   */
  start(): void {
    if (this.streamActive) return;
    this.streamActive = true;
    
    // Poll for merge operations every 10 seconds
    this.checkInterval = setInterval(() => {
      this.checkForMerges().catch((err) => {
        console.error("Error checking for account merges:", err);
      });
    }, 10000);
  }

  /**
   * Stop monitoring for account merge operations.
   */
  stop(): void {
    if (this.checkInterval) {
      clearInterval(this.checkInterval);
      this.checkInterval = null;
    }
    this.streamActive = false;
  }

  /**
   * Add an account to the watch list.
   */
  watchAccount(accountId: string): void {
    this.watchedAccounts.add(accountId);
  }

  /**
   * Remove an account from the watch list.
   */
  unwatchAccount(accountId: string): void {
    this.watchedAccounts.delete(accountId);
  }

  /**
   * Check if an account has been merged and resolve the final destination.
   * Supports recursive merge chains up to depth 5.
   */
  async resolveMergeDestination(
    accountId: string,
    depth = 0,
  ): Promise<string> {
    if (depth > 5) {
      throw new Error(`Merge chain too deep for account ${accountId}`);
    }

    const cached = this.mergeCache.get(accountId);
    if (cached) {
      // Recursively resolve in case the destination was also merged
      return this.resolveMergeDestination(cached, depth + 1);
    }

    return accountId; // Not merged
  }

  /**
   * Check for merge operations on watched accounts.
   */
  private async checkForMerges(): Promise<void> {
    for (const accountId of this.watchedAccounts) {
      try {
        const response = await fetch(
          `${this.horizonUrl}/accounts/${accountId}/operations?order=desc&limit=10`,
        );
        
        if (!response.ok) {
          if (response.status === 404) {
            // Account not found - might be merged
            await this.detectMergeFromHistory(accountId);
          }
          continue;
        }

        const data = await response.json();
        const operations = data._embedded?.records || [];

        for (const op of operations) {
          if (op.type === "account_merge" && op.account === accountId) {
            const destination = op.into;
            await this.handleMergeDetected(accountId, destination, op);
            break;
          }
        }
      } catch (err) {
        console.error(`Error checking account ${accountId}:`, err);
      }
    }
  }

  /**
   * Attempt to detect merge from transaction history when account is not found.
   */
  private async detectMergeFromHistory(accountId: string): Promise<void> {
    try {
      const response = await fetch(
        `${this.horizonUrl}/operations?limit=200&order=desc`,
      );
      
      if (!response.ok) return;

      const data = await response.json();
      const operations = data._embedded?.records || [];

      for (const op of operations) {
        if (op.type === "account_merge" && op.account === accountId) {
          const destination = op.into;
          await this.handleMergeDetected(accountId, destination, op);
          break;
        }
      }
    } catch (err) {
      console.error(`Error detecting merge history for ${accountId}:`, err);
    }
  }

  /**
   * Handle a detected account merge operation.
   */
  private async handleMergeDetected(
    sourceAccount: string,
    destinationAccount: string,
    operation: any,
  ): Promise<void> {
    // Check if we've already processed this merge
    if (this.mergeCache.has(sourceAccount)) {
      return;
    }

    this.mergeCache.set(sourceAccount, destinationAccount);

    const event: AccountMergeEvent = {
      sourceAccount,
      destinationAccount,
      ledgerSequence: operation.source_account_sequence || 0,
      timestamp: new Date(operation.created_at || Date.now()),
    };

    this.emit("recipient:mergeDetected", event);

    // Notify the client to reroute recipients
    try {
      // The client will handle rerouting via rerouteRecipient method
      this.emit("recipient:reroute", {
        oldAddress: sourceAccount,
        newAddress: destinationAccount,
      });
    } catch (err) {
      console.error("Error notifying merge detection:", err);
    }
  }

  /**
   * Validate that a destination account is suitable for rerouting.
   */
  async validateDestination(
    destinationAccount: string,
    requiredAsset?: { code: string; issuer: string },
  ): Promise<void> {
    try {
      const response = await fetch(
        `${this.horizonUrl}/accounts/${destinationAccount}`,
      );

      if (!response.ok) {
        throw new InvalidDestinationError(
          destinationAccount,
          "Account does not exist on-chain",
        );
      }

      const accountData = await response.json();

      // Check if the destination has also been merged
      const mergedDestination = this.mergeCache.get(destinationAccount);
      if (mergedDestination) {
        throw new InvalidDestinationError(
          destinationAccount,
          "Destination account has itself been merged",
        );
      }

      // Check for required trustlines if asset is specified
      if (requiredAsset) {
        const balances = accountData.balances || [];
        const hasTrustline = balances.some(
          (balance: any) =>
            balance.asset_code === requiredAsset.code &&
            balance.asset_issuer === requiredAsset.issuer,
        );

        if (!hasTrustline) {
          throw new InvalidDestinationError(
            destinationAccount,
            `Missing required trustline for ${requiredAsset.code}:${requiredAsset.issuer}`,
          );
        }
      }
    } catch (err) {
      if (err instanceof InvalidDestinationError) {
        throw err;
      }
      throw new InvalidDestinationError(
        destinationAccount,
        `Validation failed: ${err}`,
      );
    }
  }
}
