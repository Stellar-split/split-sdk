import {
  StellarSplitError,
  InvoiceNotFoundError,
  InvoiceNotPendingError,
  DeadlinePassedError,
  PaymentExceedsRemainingError,
  InvoiceFrozenError,
  CoCreatorApprovalNotRequiredError,
  SdkError,
  SdkErrorCode,
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

// === Machine-readable error-code suggestions

// Keyed by SdkErrorCode. Consulted when getSuggestion is called with a code
// string or an SdkError instance, ahead of the Error-subclass and raw-pattern
// tables. Lookup normalizes the key with toUpperCase so a caller passing
// "account_not_found" resolves the same entry as "ACCOUNT_NOT_FOUND".
const CODE_SUGGESTION_TABLE: Record<SdkErrorCode, string> = {
  [SdkErrorCode.INVOICE_NOT_FOUND]:
    "The requested invoice does not exist on-chain. Verify the invoice ID and ensure it was created on the correct network.",
  [SdkErrorCode.ACCOUNT_NOT_FOUND]:
    "The account does not exist on the Stellar network. Fund the account with a minimum XLM balance before retrying.",
  [SdkErrorCode.INSUFFICIENT_FUNDS]:
    "The account balance is too low to cover this operation. Top up the account and retry.",
  [SdkErrorCode.DEADLINE_EXPIRED]:
    "The invoice deadline has passed. Create a new invoice with a future deadline if you still need to collect payment.",
  [SdkErrorCode.INVALID_RECIPIENT]:
    "One or more recipient addresses are invalid. Check that each recipient is a valid Stellar public key.",
  [SdkErrorCode.CONTRACT_REJECTED]:
    "The contract rejected the transaction. Review the operation parameters and the invoice state before retrying.",
  [SdkErrorCode.NETWORK_TIMEOUT]:
    "The network request timed out. Check your connection and retry; the transaction may still settle.",
  [SdkErrorCode.RATE_LIMITED]:
    "Requests are being rate limited. Back off and retry after a short delay.",
};

function suggestionForCode(code: string): string {
  return CODE_SUGGESTION_TABLE[code.toUpperCase() as SdkErrorCode] ?? GENERIC_FALLBACK;
}

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
 * Accepts either a machine-readable code (an {@link SdkErrorCode} or any
 * string, matched case-insensitively) or an Error instance. Codes and
 * {@link SdkError} instances are resolved against the code table; other errors
 * match first against typed subclasses, then against raw message patterns,
 * and fall back to a generic suggestion.
 *
 * @param error - An SdkErrorCode, a code string, or any Error instance.
 * @returns A suggestion string suitable for display in UI or logs.
 */
export function getSuggestion(error: Error | SdkErrorCode | string): string {
  if (typeof error === "string") {
    return suggestionForCode(error);
  }

  if (error instanceof SdkError) {
    return suggestionForCode(error.code);
  }

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
