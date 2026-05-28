import type { Invoice, Payment } from "./types.js";

/**
 * Get an optimistically updated invoice reflecting a pending payment.
 *
 * Returns a new invoice object with the payment applied immediately,
 * without waiting for on-chain confirmation. Does not mutate the input.
 *
 * @param invoice - The current invoice state
 * @param payment - The pending payment to apply
 * @returns A new invoice with the payment applied
 */
export function getOptimisticInvoice(invoice: Invoice, payment: Payment): Invoice {
  const newFunded = invoice.funded + payment.amount;
  const newPayments = [...invoice.payments, payment];
  const newStatus =
    newFunded >= invoice.recipients.reduce((sum, r) => sum + r.amount, 0n)
      ? "Released"
      : invoice.status;

  return {
    ...invoice,
    funded: newFunded,
    payments: newPayments,
    status: newStatus,
  };
}
