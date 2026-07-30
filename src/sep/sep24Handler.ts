/**
 * SEP-24 interactive transfer handler for StellarSplit.
 *
 * Manages the full interactive deposit and withdrawal lifecycle:
 * initiation, IFRAME URL generation, status polling, and completion
 * detection. Integrates with SEP-10 JWT authentication via
 * {@link resolveToken} and emits status changes via a typed event
 * emitter.
 *
 * @see https://github.com/stellar/stellar-protocol/blob/master/ecosystem/sep-0024.md
 */

import { StellarTomlResolver } from "@stellar/stellar-sdk";
import { TypedEventEmitter } from "../events/TypedEventEmitter.js";
import type {
  Sep24TransactionRecord,
  Sep24Status,
  Sep24StatusChangedEvent,
} from "../types.js";

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

/** Events emitted by {@link Sep24Handler}. */
export interface Sep24HandlerEventMap {
  sep24StatusChanged: Sep24StatusChangedEvent;
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Parameters for initiating a SEP-24 interactive transfer. */
export interface Sep24InitParams {
  /** Anchor service base URL (from stellar.toml TRANSFER_SERVER). */
  anchorUrl: string;
  /** SEP-10 JWT token for authentication. */
  jwt: string;
  /** Type of transfer. */
  kind: "deposit" | "withdrawal";
  /** Asset code (e.g., "USDC"). */
  assetCode: string;
  /** Asset issuer's Stellar address. */
  assetIssuer: string;
  /** Amount requested in stroops. */
  amount: bigint;
  /** Stellar account receiving the deposit or sending the withdrawal. */
  account: string;
  /** Optional callback URL for anchor to POST status updates. */
  callbackUrl?: string;
  /** Optional KYC fields to pre-fill. */
  kycFields?: Record<string, string>;
  /** Polling interval in milliseconds (default: 3000). */
  pollIntervalMs?: number;
}

/** Success response from a SEP-24 initiation request. */
interface Sep24InitResponse {
  id: string;
  url: string;
  interactive_url?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Manages a single SEP-24 interactive transfer lifecycle.
 *
 * Call {@link init} to start the transfer, then monitor the
 * `sep24StatusChanged` event or call {@link getTransaction} to
 * retrieve the current state.
 *
 * @example
 * ```typescript
 * const handler = new Sep24Handler();
 * handler.on("sep24StatusChanged", (event) => {
 *   if (event.transaction.status === "completed") {
 *     console.log("Transfer complete!");
 *   }
 * });
 *
 * const txn = await handler.init({
 *   anchorUrl: "https://anchor.example.com",
 *   jwt: sep10Token,
 *   kind: "deposit",
 *   assetCode: "USDC",
 *   assetIssuer: "G...ISSUER",
 *   amount: 100_0000000n,
 *   account: "G...USER",
 * });
 * ```
 */
export class Sep24Handler extends TypedEventEmitter<Sep24HandlerEventMap> {
  private transaction: Sep24TransactionRecord | null = null;
  private polling = false;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private jwt = "";

  /**
   * Initiate a SEP-24 interactive deposit or withdrawal.
   *
   * Fetches the anchor's interactive URL, stores the transaction record,
   * and begins polling for status updates.
   *
   * @param params - Transfer initiation parameters.
   * @returns The initialized transaction record.
   */
  async init(params: Sep24InitParams): Promise<Sep24TransactionRecord> {
    const pollIntervalMs = params.pollIntervalMs ?? 3000;
    this.jwt = params.jwt;

    const endpoint =
      params.kind === "deposit"
        ? "/transactions/deposit/interactive"
        : "/transactions/withdraw/interactive";

    const url = `${params.anchorUrl.replace(/\/$/, "")}${endpoint}`;

    const body = new URLSearchParams({
      asset_code: params.assetCode,
      asset_issuer: params.assetIssuer,
      account: params.account,
      amount: params.amount.toString(),
    });

    if (params.callbackUrl) {
      body.append("callback_url", params.callbackUrl);
    }

    if (params.kycFields) {
      for (const [key, value] of Object.entries(params.kycFields)) {
        body.append(key, value);
      }
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        Authorization: `Bearer ${params.jwt}`,
      },
      body: body.toString(),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => "Unknown error");
      throw new Error(
        `SEP-24 initiation failed (${response.status}): ${errorText}`,
      );
    }

    const data = (await response.json()) as Sep24InitResponse;

    const now = Math.floor(Date.now() / 1000);
    const record: Sep24TransactionRecord = {
      id: data.id,
      kind: params.kind,
      status: "incomplete",
      amount: params.amount,
      assetCode: params.assetCode,
      assetIssuer: params.assetIssuer,
      interactiveUrl: data.url ?? data.interactive_url ?? null,
      stellarTxId: null,
      startedAt: now,
      updatedAt: now,
      anchorUrl: params.anchorUrl,
      kycUrl: null,
      errorMessage: null,
    };

    this.transaction = record;
    this.startPolling(pollIntervalMs);

    return record;
  }

  /**
   * Get the current transaction record, or null if not yet initialized.
   */
  getTransaction(): Sep24TransactionRecord | null {
    return this.transaction;
  }

  /**
   * Stop polling and clean up resources.
   */
  destroy(): void {
    this.stopPolling();
    this.removeAllListeners();
    this.transaction = null;
  }

  // -----------------------------------------------------------------------
  // Internal polling
  // -----------------------------------------------------------------------

  private startPolling(intervalMs: number): void {
    if (this.polling) return;
    this.polling = true;

    this.pollTimer = setInterval(() => {
      void this.pollStatus();
    }, intervalMs);
  }

  private stopPolling(): void {
    this.polling = false;
    if (this.pollTimer !== null) {
      clearInterval(this.pollTimer);
      this.pollTimer = null;
    }
  }

  private async pollStatus(): Promise<void> {
    if (!this.transaction) return;

    const { anchorUrl, id } = this.transaction;
    const url = `${anchorUrl.replace(/\/$/, "")}/transaction?id=${encodeURIComponent(id)}`;

    try {
      const response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${this.jwt}`,
        },
      });

      if (!response.ok) return;

      const data = (await response.json()) as {
        transaction: {
          id: string;
          status: string;
          stellar_transaction_id?: string;
          completed_at?: string;
          message?: string;
        };
      };

      const txData = data.transaction;
      if (!txData) return;

      const newStatus = normalizeStatus(txData.status);
      const previousStatus = this.transaction.status;

      if (newStatus !== previousStatus) {
        this.transaction = {
          ...this.transaction,
          status: newStatus,
          stellarTxId: txData.stellar_transaction_id ?? this.transaction.stellarTxId,
          updatedAt: Math.floor(Date.now() / 1000),
          errorMessage: newStatus === "error" ? (txData.message ?? null) : this.transaction.errorMessage,
        };

        this.emit("sep24StatusChanged", {
          transaction: this.transaction,
          previousStatus,
        });

        // Stop polling on terminal states
        if (isTerminalStatus(newStatus)) {
          this.stopPolling();
        }
      }
    } catch {
      // Swallow polling errors — will retry on next interval
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: Resolve anchor info from stellar.toml
// ---------------------------------------------------------------------------

/**
 * Fetches the transfer server URL from an anchor's stellar.toml.
 *
 * @param homeDomain - The anchor's home domain (e.g. "anchorusd.com").
 * @returns The TRANSFER_SERVER URL, or null if not found.
 */
export async function resolveAnchorTransferServer(
  homeDomain: string,
): Promise<string | null> {
  try {
    const toml = await StellarTomlResolver.resolve(homeDomain);
    return (toml.TRANSFER_SERVER as string) ?? null;
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Map raw anchor status strings to canonical {@link Sep24Status}. */
function normalizeStatus(raw: string): Sep24Status {
  const status = raw.toLowerCase().trim();
  const valid: Sep24Status[] = [
    "incomplete",
    "pending_user_transfer_start",
    "pending_anchor",
    "pending_stellar",
    "pending_external",
    "completed",
    "error",
    "refunded",
  ];
  if ((valid as string[]).includes(status)) {
    return status as Sep24Status;
  }
  return "incomplete";
}

/** Statuses that indicate the transfer is final. */
function isTerminalStatus(status: Sep24Status): boolean {
  return status === "completed" || status === "error" || status === "refunded";
}
