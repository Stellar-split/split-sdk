import {
  StellarSplitError,
  InvoiceNotFoundError,
  InvoiceNotPendingError,
  DeadlinePassedError,
  PaymentExceedsRemainingError,
  InvoiceFrozenError,
  CoCreatorApprovalNotRequiredError,
} from "./errors.js";

type ErrorConstructor = new (...args: never[]) => StellarSplitError;

interface SuggestionEntry {
  type: ErrorConstructor;
  suggestion: string;
}

const GENERIC_FALLBACK =
  "An unexpected error occurred. Please check your network connection and try again, or contact support if the issue persists.";

const SUGGESTION_TABLE: SuggestionEntry[] = [
  {
    type: InvoiceNotFoundError,
    suggestion:
      "The requested invoice does not exist on-chain. Verify the invoice ID and ensure it was created on the correct network.",
  },
  {
    type: InvoiceNotPendingError,
    suggestion:
      "This operation requires the invoice to be in Pending status. Check the invoice status before retrying.",
  },
  {
    type: DeadlinePassedError,
    suggestion:
      "The invoice deadline has passed. Create a new invoice with a future deadline if you still need to collect payment.",
  },
  {
    type: PaymentExceedsRemainingError,
    suggestion:
      "The payment amount exceeds the remaining unfunded balance. Reduce the payment amount to at most the remaining balance.",
  },
  {
    type: InvoiceFrozenError,
    suggestion:
      "The invoice is currently frozen due to an active dispute or lock. Wait for the dispute to resolve before retrying.",
  },
  {
    type: CoCreatorApprovalNotRequiredError,
    suggestion:
      "This invoice was not created with co-creator approval enabled. No co-creator sign-off step is needed.",
  },
];

// Additional raw-message pattern suggestions for contract-level errors surfaced
// through parseSorobanError as generic StellarSplitErrors.
const RAW_PATTERN_TABLE: Array<{ pattern: RegExp; suggestion: string }> = [
  {
    pattern: /unauthorized|not.*authorized|permission.*denied/i,
    suggestion:
      "You are not authorized to perform this action. Ensure you are signing with the correct account.",
  },
  {
    pattern: /insufficient.*fee|fee.*too.*low/i,
    suggestion:
      "The transaction fee is too low. Increase the base fee and resubmit.",
  },
  {
    pattern: /trustline.*missing|no.*trustline/i,
    suggestion:
      "The payer account does not have a trustline for the required token. Establish a trustline before paying.",
  },
  {
    pattern: /account.*not.*found|no.*account/i,
    suggestion:
      "The account does not exist on the Stellar network. Fund the account with a minimum XLM balance first.",
  },
];

/**
 * Returns a human-readable remediation suggestion for a known SDK error.
 *
 * Matches first against typed error subclasses, then against raw message
 * patterns, and falls back to a generic suggestion for unknown errors.
 *
 * @param error - Any Error instance, ideally a StellarSplitError subclass.
 * @returns A suggestion string suitable for display in UI or logs.
 */
export function getSuggestion(error: Error): string {
  for (const entry of SUGGESTION_TABLE) {
    if (error instanceof entry.type) {
      return entry.suggestion;
    }
  }

  if (error instanceof StellarSplitError) {
    for (const { pattern, suggestion } of RAW_PATTERN_TABLE) {
      if (pattern.test(error.raw ?? "") || pattern.test(error.message)) {
        return suggestion;
      }
    }
  }

  return GENERIC_FALLBACK;
}
