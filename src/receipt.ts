import { createHash } from "crypto";
import type { Horizon } from "@stellar/stellar-sdk";
import type { AccountEffectSummary, Invoice, Payment } from "./types.js";
import { PayerAddressRequiredError } from "./errors.js";
import { aggregateEffects } from "./effectAggregator.js";

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
  /** Net per-account asset balance changes for the underlying transaction, when requested via `ReceiptConfig.includeEffects`. */
  effectSummary?: AccountEffectSummary[];
  /** Convert receipt to a JSON-serializable object (with bigints represented as strings). */
  toJSON(): PaymentReceiptJSON;
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
  effectSummary?: AccountEffectSummary[];
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
 * @returns A structured payment receipt with SHA-256 proof hash.
 */
export function compilePaymentReceipt(
  invoice: Invoice,
  payerAddress: string
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

  return _buildReceiptObject({
    invoiceId: invoice.id,
    payer: payerAddress,
    totalPaid,
    payments: payerPayments,
    proofHash,
    generatedAt,
    ledgerTimestamp,
  });
}

/**
 * Generate a payment receipt for an invoice and payer address.
 * Works for both completed and in-progress invoices.
 *
 * @param source - Either a client with `getInvoice` or an `Invoice` object.
 * @param invoiceIdOrPayer - The invoice ID (if passing a client) or payer address (if passing an Invoice).
 * @param payerAddress - The payer address (if passing a client).
 * @param config - Optional enrichment config; set `includeEffects` (with `server`/`txHash`) to attach an effect summary.
 * @returns Promise resolving to the PaymentReceipt.
 */
export async function generatePaymentReceipt(
  source: InvoiceFetcher | Invoice,
  invoiceIdOrPayer: string,
  payerAddress?: string,
  config?: ReceiptConfig
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

  if (config?.includeEffects && config.server && config.txHash) {
    receipt.effectSummary = await aggregateEffects(config.server, config.txHash);
  }

  return receipt;
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
    effectSummary: data.effectSummary,
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
  effectSummary?: AccountEffectSummary[];
}): PaymentReceipt {
  return {
    invoiceId: data.invoiceId,
    payer: data.payer,
    totalPaid: data.totalPaid,
    payments: data.payments,
    proofHash: data.proofHash,
    generatedAt: data.generatedAt,
    ledgerTimestamp: data.ledgerTimestamp,
    effectSummary: data.effectSummary,
    toJSON(): PaymentReceiptJSON {
      return {
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
        effectSummary: this.effectSummary,
      };
    },
  };
}