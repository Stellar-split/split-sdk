import type { Invoice, BatchPayment } from "./types.js";

export interface BatchInvoiceValidation {
  invoiceId: string;
  valid: boolean;
  errors: string[];
  token: string;
  remainingAmount: bigint;
  status: string;
}

export interface BatchVerificationResult {
  valid: boolean;
  invoices: BatchInvoiceValidation[];
  commonToken: string | null;
  errors: string[];
}

/**
 * Verify that all invoices in a batch share the same token and are in a
 * payable state, before submitting the on-chain transaction.
 *
 * @param invoices - The invoices to verify (must already be resolved).
 * @param payments - The proposed batch payments (invoiceId + amount pairs).
 */
export function verifyBatchPayments(
  invoices: Invoice[],
  payments: BatchPayment[]
): BatchVerificationResult {
  const errors: string[] = [];
  const invoiceValidations: BatchInvoiceValidation[] = [];

  if (invoices.length === 0) {
    return { valid: false, invoices: [], commonToken: null, errors: ["No invoices provided"] };
  }

  const invoiceMap = new Map(invoices.map((inv) => [inv.id, inv]));
  const tokens = new Set<string>();

  for (const payment of payments) {
    const invoice = invoiceMap.get(payment.invoiceId);
    if (!invoice) {
      invoiceValidations.push({
        invoiceId: payment.invoiceId,
        valid: false,
        errors: ["Invoice not found"],
        token: "",
        remainingAmount: 0n,
        status: "unknown",
      });
      errors.push(`Invoice ${payment.invoiceId}: not found`);
      continue;
    }

    tokens.add(invoice.token);
    const invoiceErrors: string[] = [];

    if (invoice.status !== "Pending") {
      invoiceErrors.push(`Invoice status is "${invoice.status}", expected "Pending"`);
    }

    const totalOwed = invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);
    const remaining = totalOwed - invoice.funded;
    if (payment.amount <= 0n) {
      invoiceErrors.push("Payment amount must be positive");
    }
    if (payment.amount > remaining) {
      invoiceErrors.push(
        `Payment amount ${payment.amount} exceeds remaining ${remaining}`
      );
    }

    invoiceValidations.push({
      invoiceId: payment.invoiceId,
      valid: invoiceErrors.length === 0,
      errors: invoiceErrors,
      token: invoice.token,
      remainingAmount: remaining,
      status: invoice.status,
    });

    if (invoiceErrors.length > 0) {
      errors.push(`Invoice ${payment.invoiceId}: ${invoiceErrors.join("; ")}`);
    }
  }

  const commonToken = tokens.size === 1 ? [...tokens][0]! : null;
  if (tokens.size > 1) {
    errors.push(`Invoices use different tokens: ${[...tokens].join(", ")}`);
  }

  const allValid = errors.length === 0;

  return { valid: allValid, invoices: invoiceValidations, commonToken, errors };
}

/**
 * Result returned by the client's verifyBatchPay method.
 */
export interface VerifyBatchPayResult {
  valid: boolean;
  invoices: BatchInvoiceValidation[];
  commonToken: string | null;
  errors: string[];
}
