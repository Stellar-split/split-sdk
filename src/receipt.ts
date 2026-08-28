import { createHash } from "crypto";
import { Horizon } from "@stellar/stellar-sdk";
import type { DecodedTransactionResult, Invoice, Payment } from "./types.js";
import type { PaymentReceipt as ChainPaymentReceipt } from "./types/receipts.js";
import { PayerAddressRequiredError } from "./errors.js";
import { decodeTransactionResult } from "./txResultDecoder.js";

/** A verified payment receipt compiled from on-chain invoice data. */
export interface PaymentReceipt {
  /** Invoice ID paid. */
  invoiceId: string;
  /** Payer's Stellar address. */
  payer: string;
  /** Total amount paid by this payer in stroops. */
  totalPaid: bigint;
  /** List of payments made by this payer. */
  payments: Payment[];
  /** SHA-256 proof hash of invoiceId + payer + totalPaid + ledgerTimestamp. */
  proofHash: string;
  /** Unix timestamp (milliseconds) when this receipt was generated. */
  generatedAt: number;
  /** Ledger timestamp or sequence used in the proof hash calculation. */
  ledgerTimestamp: number;
  /** Decoded submission result, when a `resultXdr` was supplied during receipt generation. */
  decodedResult?: DecodedTransactionResult;
  /** Convert receipt to a JSON-serializable object (with bigints represented as strings). */
  toJSON(): PaymentReceiptJSON;
  /** Payment status (optional). */
  status?: "pending" | "finalized";
  /** Per-account balance deltas aggregated from transaction effects (optional). */
  effectSummary?: Array<{ accountId: string; assetDeltas: Array<{ asset: string; delta: bigint }> }>;
}

/** Options controlling optional receipt enrichment. */
export interface ReceiptConfig {
  /** When true (and `server`/`txHash` are supplied), attach an effect summary to the receipt. */
  includeEffects?: boolean;
  /** Horizon server used to fetch effects when `includeEffects` is set. */
  server?: Horizon.Server;
  /** Hash of the transaction to aggregate effects for. */
  txHash?: string;
}

/** JSON-serializable representation of a PaymentReceipt. */
export interface PaymentReceiptJSON {
  invoiceId: string;
  payer: string;
  totalPaid: string;
  payments: Array<{
    payer: string;
    amount: string;
    ledger?: number;
    timestamp?: number;
    donateOnFailure?: boolean;
  }>;
  proofHash: string;
  generatedAt: number;
  ledgerTimestamp: number;
  decodedResult?: DecodedTransactionResult;
}

/** Interface for any client capable of fetching an invoice by ID. */
export interface InvoiceFetcher {
  getInvoice(invoiceId: string): Promise<Invoice>;
}

/**
 * Compile a payment receipt synchronously from a known Invoice object.
 * Works for both completed and in-progress invoices.
 *
 * @param invoice - The on-chain invoice object.
 * @param payerAddress - The Stellar address of the payer.
 * @param resultXdr - Optional base64-encoded `TransactionResult` XDR from the
 *                    payment submission; when provided, it is decoded and
 *                    attached as `decodedResult`.
 * @returns A structured payment receipt with SHA-256 proof hash.
 */
export function compilePaymentReceipt(
  invoice: Invoice,
  payerAddress: string,
  resultXdr?: string
): PaymentReceipt {
  const payerPayments = (invoice.payments || []).filter(
    (p) => p.payer === payerAddress
  );

  let totalPaid = 0n;
  for (const p of payerPayments) {
    totalPaid += BigInt(p.amount);
  }

  // Determine ledgerTimestamp: latest payment timestamp or ledger, fallback to invoice metadata
  let ledgerTimestamp = 0;
  if (payerPayments.length > 0) {
    for (const p of payerPayments) {
      const ts = p.timestamp ?? p.ledger ?? 0;
      if (ts > ledgerTimestamp) {
        ledgerTimestamp = ts;
      }
    }
  } else {
    ledgerTimestamp = invoice.lastModifiedLedger ?? invoice.deadline ?? 0;
  }

  const payload = `${invoice.id}${payerAddress}${totalPaid.toString()}${ledgerTimestamp}`;
  const proofHash = createHash("sha256").update(payload).digest("hex");
  const generatedAt = Date.now();

  let decodedResult: DecodedTransactionResult | undefined;
  if (resultXdr) {
    try {
      decodedResult = decodeTransactionResult(resultXdr);
    } catch {
      // Best-effort: an unparseable resultXdr should not fail receipt generation.
    }
  }

  return _buildReceiptObject({
    invoiceId: invoice.id,
    payer: payerAddress,
    totalPaid,
    payments: payerPayments,
    proofHash,
    generatedAt,
    ledgerTimestamp,
    decodedResult,
  });
}

/**
 * Generate a payment receipt for an invoice and payer address.
 * Works for both completed and in-progress invoices.
 *
 * @param source - Either a client with `getInvoice` or an `Invoice` object.
 * @param invoiceIdOrPayer - The invoice ID (if passing a client) or payer address (if passing an Invoice).
 * @param payerAddress - The payer address (if passing a client).
 * @param resultXdr - Optional base64-encoded `TransactionResult` XDR from the
 *                    payment submission; when provided, it is decoded and
 *                    attached as `decodedResult`.
 * @returns Promise resolving to the PaymentReceipt.
 */
export async function generatePaymentReceipt(
  source: InvoiceFetcher | Invoice,
  invoiceIdOrPayer: string,
  payerAddress?: string,
  options?: ReceiptConfig,
): Promise<PaymentReceipt> {
  let receipt: PaymentReceipt;
  if ("getInvoice" in source && typeof source.getInvoice === "function") {
    if (!payerAddress) {
      throw new PayerAddressRequiredError();
    }
    const invoice = await source.getInvoice(invoiceIdOrPayer);
    receipt = compilePaymentReceipt(invoice, payerAddress);
  } else {
    receipt = compilePaymentReceipt(source as Invoice, invoiceIdOrPayer);
  }

  if (options?.includeEffects && options.server && options.txHash) {
    const effectSummary = await _fetchEffectSummary(options.server as Horizon.Server, options.txHash);
    (receipt as Record<string, unknown>).effectSummary = effectSummary;
  }

  return receipt;
}

async function _fetchEffectSummary(
  server: Horizon.Server,
  txHash: string,
): Promise<Array<{ accountId: string; assetDeltas: Array<{ asset: string; delta: bigint }> }>> {
  const page = await (server as unknown as { effects(): { forTransaction(h: string): { call(): Promise<{ records: unknown[] }> } } })
    .effects()
    .forTransaction(txHash)
    .call();

  const byAccount = new Map<string, Map<string, bigint>>();

  for (const effect of page.records as Array<{
    type: string;
    account: string;
    asset_type: string;
    asset_code?: string;
    asset_issuer?: string;
    amount: string;
  }>) {
    if (effect.type !== "account_debited" && effect.type !== "account_credited") continue;

    const assetKey =
      effect.asset_type === "native"
        ? "native"
        : `${effect.asset_code}:${effect.asset_issuer}`;

    const amountStroops = BigInt(Math.round(parseFloat(effect.amount) * 10_000_000));
    const delta = effect.type === "account_debited" ? -amountStroops : amountStroops;

    if (!byAccount.has(effect.account)) {
      byAccount.set(effect.account, new Map());
    }
    const assetMap = byAccount.get(effect.account)!;
    assetMap.set(assetKey, (assetMap.get(assetKey) ?? 0n) + delta);
  }

  return Array.from(byAccount.entries()).map(([accountId, assetMap]) => ({
    accountId,
    assetDeltas: Array.from(assetMap.entries()).map(([asset, delta]) => ({ asset, delta })),
  }));
}

/**
 * Serialize a PaymentReceipt into a JSON string.
 *
 * @param receipt - The payment receipt to serialize.
 * @param space - Optional indentation spaces (default 2).
 * @returns JSON string representation.
 */
export function serializePaymentReceipt(receipt: PaymentReceipt, space = 2): string {
  const jsonObj = typeof receipt.toJSON === "function" ? receipt.toJSON() : receipt;
  return JSON.stringify(jsonObj, null, space);
}

/**
 * Deserialize a JSON string back into a PaymentReceipt object.
 *
 * @param json - The JSON string representation.
 * @returns Reconstructed PaymentReceipt object.
 */
export function deserializePaymentReceipt(json: string): PaymentReceipt {
  const data = JSON.parse(json) as PaymentReceiptJSON;
  const payments: Payment[] = (data.payments || []).map((p) => ({
    ...p,
    amount: BigInt(p.amount),
  }));
  const totalPaid = BigInt(data.totalPaid);

  return _buildReceiptObject({
    invoiceId: data.invoiceId,
    payer: data.payer,
    totalPaid,
    payments,
    proofHash: data.proofHash,
    generatedAt: data.generatedAt,
    ledgerTimestamp: data.ledgerTimestamp,
    decodedResult: data.decodedResult,
  });
}

/** Run a finality check for a submitted payment transaction and attach it to the receipt. */
export async function finalizePaymentReceipt(
  receipt: PaymentReceipt,
  txHash: string,
  checker: FinalityChecker,
): Promise<PaymentReceipt> {
  const finality = await checker.check(txHash);
  return _buildReceiptObject({
    invoiceId: receipt.invoiceId,
    payer: receipt.payer,
    totalPaid: receipt.totalPaid,
    payments: receipt.payments,
    proofHash: receipt.proofHash,
    generatedAt: receipt.generatedAt,
    ledgerTimestamp: receipt.ledgerTimestamp,
    finality,
  });
}

function _buildReceiptObject(data: {
  invoiceId: string;
  payer: string;
  totalPaid: bigint;
  payments: Payment[];
  proofHash: string;
  generatedAt: number;
  ledgerTimestamp: number;
  decodedResult?: DecodedTransactionResult;
}): PaymentReceipt {
  return {
    invoiceId: data.invoiceId,
    payer: data.payer,
    totalPaid: data.totalPaid,
    payments: data.payments,
    proofHash: data.proofHash,
    generatedAt: data.generatedAt,
    ledgerTimestamp: data.ledgerTimestamp,
    decodedResult: data.decodedResult,
    toJSON(): PaymentReceiptJSON {
      const json: PaymentReceiptJSON = {
        invoiceId: this.invoiceId,
        payer: this.payer,
        totalPaid: this.totalPaid.toString(),
        payments: this.payments.map((p) => ({
          ...p,
          amount: p.amount.toString(),
        })),
        proofHash: this.proofHash,
        generatedAt: this.generatedAt,
        ledgerTimestamp: this.ledgerTimestamp,
        decodedResult: this.decodedResult,
      };
      if (this.status) {
        json.status = this.status;
      }
      if (this.effectSummary) {
        json.effectSummary = Object.fromEntries(
          Object.entries(this.effectSummary).map(([k, v]) => [k, v.toString()])
        );
      }
      return json;
    },
  };
}

// ---------------------------------------------------------------------------
// Local receipt registry — module-level singleton, hash-based lookup.
// Uses the chain PaymentReceipt type from src/types/receipts.ts which carries
// a txHash field.  The compiled-summary PaymentReceipt defined above does not
// participate in this registry.
// ---------------------------------------------------------------------------

const _receiptRegistry = new Map<string, ChainPaymentReceipt>();

/**
 * Store a receipt in the module-level registry, keyed by its `txHash`.
 * Calling this again with the same `txHash` will overwrite the previous entry.
 *
 * @param receipt - The chain payment receipt to store.
 */
export function registerReceipt(receipt: ChainPaymentReceipt): void {
  _receiptRegistry.set(receipt.txHash, receipt);
}

/**
 * Retrieve a previously registered receipt by transaction hash.
 *
 * @param txHash - The transaction hash to look up.
 * @returns The stored receipt, or `null` if none exists for that hash.
 */
export function getReceiptByTxHash(txHash: string): ChainPaymentReceipt | null {
  return _receiptRegistry.get(txHash) ?? null;
}

/**
 * Return all registered receipts sorted by `timestamp` ascending.
 *
 * @returns A new array of receipts in chronological order.
 */
export function getAllReceipts(): ChainPaymentReceipt[] {
  return Array.from(_receiptRegistry.values()).sort(
    (a, b) => a.timestamp - b.timestamp,
  );
}

/**
 * Remove all entries from the registry.
 * Intended for test teardown — use with care in production code.
 */
export function clearReceipts(): void {
  _receiptRegistry.clear();
}
