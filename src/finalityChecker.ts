/**
 * FinalityChecker — Verifies transaction finality on Stellar testnet/mainnet.
 *
 * Polls the Soroban RPC for transaction status and ledger progression,
 * then assembles a finalized PaymentReceipt with Horizon-derived effect data.
 */

import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { generatePaymentReceipt, type PaymentReceipt } from "./receipt.js";
import type { InvoiceFetcher } from "./receipt.js";

/** Convert a Horizon balance string ("1.0000000") to stroops (bigint). */
function xlmStringToStroops(xlm: string): bigint {
  const [whole = "0", frac = ""] = xlm.split(".");
  return BigInt(whole) * 10_000_000n + BigInt(frac.padEnd(7, "0").slice(0, 7));
}

/** Options for FinalityChecker.check(). */
export interface FinalityCheckOptions {
  /** Minimum number of ledger confirmations after the tx ledger. */
  minConfirmations: number;
  /** Invoice ID (must be provided — no XDR parsing required). */
  invoiceId: string;
  /** Payer Stellar address. */
  payer: string;
  /** Polling interval in ms (default: 1000). */
  pollIntervalMs?: number;
}

/**
 * FinalityChecker waits for a submitted transaction to reach a target
 * confirmation depth (ledger count past the tx ledger) and then returns
 * a PaymentReceipt with `status: "finalized"` and an `effectSummary`
 * mapping recipient addresses to credited stroop amounts.
 */
export class FinalityChecker {
  private readonly rpcServer: SorobanRpc.Server;
  private readonly horizonUrl: string | undefined;

  /**
   * @param rpcUrl     - Soroban RPC endpoint URL.
   * @param horizonUrl - Optional Horizon REST API URL for fetching effects.
   */
  constructor(rpcUrl: string, horizonUrl?: string) {
    this.rpcServer = new SorobanRpc.Server(rpcUrl, {
      allowHttp: rpcUrl.startsWith("http://"),
    });
    this.horizonUrl = horizonUrl;
  }

  /**
   * Static convenience wrapper.
   *
   * @param invoiceFetcher - Any object with `getInvoice(id)` (e.g. StellarSplitClient).
   * @param rpcUrl         - Soroban RPC endpoint URL.
   * @param txHash         - Transaction hash to wait for.
   * @param options        - Finality check configuration.
   * @param horizonUrl     - Optional Horizon REST API URL.
   */
  static async check(
    invoiceFetcher: InvoiceFetcher,
    rpcUrl: string,
    txHash: string,
    options: FinalityCheckOptions,
    horizonUrl?: string,
  ): Promise<PaymentReceipt> {
    const checker = new FinalityChecker(rpcUrl, horizonUrl);
    return checker.check(invoiceFetcher, txHash, options);
  }

  /**
   * Wait for transaction finality, then build and return a finalized receipt.
   *
   * Steps:
   * 1. Poll `getTransaction` until status is SUCCESS (or throw on FAILED).
   * 2. Poll `getLatestLedger` until the ledger sequence has advanced by
   *    at least `minConfirmations` past the transaction's ledger.
   * 3. Generate a base receipt via `generatePaymentReceipt`.
   * 4. Fetch Horizon `/transactions/{hash}/effects` to populate `effectSummary`.
   * 5. Fall back to invoice-split-ratio based calculation if Horizon is unavailable.
   * 6. Return the receipt with `status: "finalized"`.
   */
  async check(
    invoiceFetcher: InvoiceFetcher,
    txHash: string,
    options: FinalityCheckOptions,
  ): Promise<PaymentReceipt> {
    const pollInterval = options.pollIntervalMs ?? 1000;

    // ---- Step 1: Wait for transaction success ----
    let txResponse = await this.rpcServer.getTransaction(txHash);
    while (txResponse.status !== "SUCCESS") {
      if (txResponse.status === "FAILED") {
        throw new Error(`Transaction ${txHash} failed on-chain`);
      }
      await this._sleep(pollInterval);
      txResponse = await this.rpcServer.getTransaction(txHash);
    }

    const txLedger = txResponse.ledger;

    // ---- Step 2: Wait for confirmation depth ----
    const targetLedger = txLedger + options.minConfirmations;
    let latestLedger = await this.rpcServer.getLatestLedger();
    while (latestLedger.sequence < targetLedger) {
      await this._sleep(pollInterval);
      latestLedger = await this.rpcServer.getLatestLedger();
    }

    // ---- Step 3: Generate base receipt ----
    const receipt = await generatePaymentReceipt(
      invoiceFetcher,
      options.invoiceId,
      options.payer,
    );

    // ---- Step 4: Fetch Horizon effects for effectSummary ----
    const effectSummary: Record<string, bigint> = {};
    if (this.horizonUrl) {
      try {
        const url = `${this.horizonUrl}/transactions/${txHash}/effects`;
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          const records = data._embedded?.records || [];
          for (const rec of records) {
            if (rec.type === "account_credited") {
              const account: string = rec.account;
              const amountStroops = xlmStringToStroops(rec.amount);
              effectSummary[account] = (effectSummary[account] || 0n) + amountStroops;
            }
          }
        }
      } catch (err) {
        console.warn("[FinalityChecker] Failed to fetch Horizon effects:", err);
      }
    }

    // ---- Step 5: Fallback — compute expected deltas from invoice split ----
    if (Object.keys(effectSummary).length === 0) {
      try {
        const invoice = await invoiceFetcher.getInvoice(options.invoiceId);
        const payerPayments = (invoice.payments || []).filter(
          (p) => p.payer === options.payer,
        );
        if (payerPayments.length > 0) {
          const lastPayment = payerPayments[payerPayments.length - 1];
          const paymentAmount = lastPayment ? BigInt(lastPayment.amount) : 0n;
          const totalRecipientAmount = invoice.recipients.reduce(
            (sum, r) => sum + BigInt(r.amount),
            0n,
          );
          if (totalRecipientAmount > 0n) {
            for (const recipient of invoice.recipients) {
              const share =
                (paymentAmount * BigInt(recipient.amount)) / totalRecipientAmount;
              effectSummary[recipient.address] = share;
            }
          }
        }
      } catch (err) {
        console.warn("[FinalityChecker] Failed to compute fallback effectSummary:", err);
      }
    }

    // ---- Step 6: Stamp finalized status ----
    const finalized: PaymentReceipt = {
      ...receipt,
      status: "finalized",
      effectSummary,
      toJSON: receipt.toJSON.bind(receipt),
    };
    // Rebind toJSON so it picks up the new fields
    finalized.toJSON = function () {
      const json = receipt.toJSON.call(this);
      json.status = "finalized";
      json.effectSummary = Object.fromEntries(
        Object.entries(effectSummary).map(([k, v]) => [k, v.toString()]),
      );
      return json;
    };

    return finalized;
  }

  /** Internal sleep helper. */
  private _sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
