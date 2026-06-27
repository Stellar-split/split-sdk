import { createHash } from "crypto";
import type { Invoice, Payment } from "./types.js";

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
  /** Convert receipt to a JSON-serializable object (with bigints represented as strings). */
  toJSON(): PaymentReceiptJSON;
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
 * @returns Promise resolving to the PaymentReceipt.
 */
export async function generatePaymentReceipt(
  source: InvoiceFetcher | Invoice,
  invoiceIdOrPayer: string,
  payerAddress?: string
): Promise<PaymentReceipt> {
  if ("getInvoice" in source && typeof source.getInvoice === "function") {
    if (!payerAddress) {
      throw new Error("payerAddress is required when generating receipt from a client");
    }
    const invoice = await source.getInvoice(invoiceIdOrPayer);
    return compilePaymentReceipt(invoice, payerAddress);
  }

  return compilePaymentReceipt(source as Invoice, invoiceIdOrPayer);
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
}): PaymentReceipt {
  return {
    invoiceId: data.invoiceId,
    payer: data.payer,
    totalPaid: data.totalPaid,
    payments: data.payments,
    proofHash: data.proofHash,
    generatedAt: data.generatedAt,
    ledgerTimestamp: data.ledgerTimestamp,
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
      };
    },
  };
}
