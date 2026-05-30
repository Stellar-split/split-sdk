import type { Invoice } from "./types.js";
import { isExpired } from "./utils.js";

export interface PaymentValidation {
  valid: boolean;
  errors: string[];
}

export function computePaymentValidation(
  invoice: Invoice,
  amount: bigint,
  balance: bigint | null
): PaymentValidation {
  const errors: string[] = [];

  if (balance === null) {
    errors.push("Unable to determine payer USDC balance");
  } else if (balance < amount) {
    errors.push("Insufficient USDC balance");
  }

  if (invoice.status !== "Pending") {
    errors.push("Invoice is not pending");
  }

  const totalDue = invoice.recipients.reduce((sum, recipient) => sum + recipient.amount, 0n);
  if (invoice.funded + amount > totalDue) {
    errors.push("Payment amount exceeds invoice remaining balance");
  }

  if (isExpired(invoice.deadline)) {
    errors.push("Invoice deadline has passed");
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}
