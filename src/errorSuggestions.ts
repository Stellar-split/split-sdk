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

// Machine-readable error-code suggestions, keyed by SdkErrorCode. Consulted
// when getSuggestion is called with a code string or an SdkError instance,
// ahead of the Error-subclass and raw-pattern tables. Lookup normalizes the
// key with toUpperCase so a caller passing "account_not_found" resolves the
// same entry as "ACCOUNT_NOT_FOUND".
//
// Exhaustive by construction: every SdkErrorCode (issue #1067) must have a
// suggestion here, so new codes cannot be added without remediation guidance.
const CODE_SUGGESTION_TABLE: Record<SdkErrorCode, string> = {
  // Invoice / resource lifecycle
  [SdkErrorCode.INVOICE_NOT_FOUND]:
    "The requested invoice does not exist on-chain. Verify the invoice ID and ensure it was created on the correct network.",
  [SdkErrorCode.INVOICE_NOT_PENDING]:
    "This operation requires the invoice to be in Pending status. Check the invoice status before retrying.",
  [SdkErrorCode.DEADLINE_EXPIRED]:
    "The invoice deadline has passed. Create a new invoice with a future deadline if you still need to collect payment.",
  [SdkErrorCode.INVOICE_FROZEN]:
    "The invoice is currently frozen due to an active dispute or lock. Wait for the dispute to resolve before retrying.",
  // Accounts & funds
  [SdkErrorCode.ACCOUNT_NOT_FOUND]:
    "The account does not exist on the Stellar network. Fund the account with a minimum XLM balance before retrying.",
  [SdkErrorCode.INSUFFICIENT_FUNDS]:
    "The account balance is too low to cover this operation. Top up the account and retry.",
  // Input validation
  [SdkErrorCode.INVALID_INPUT]:
    "One or more inputs failed validation. Review the operation parameters against the documented input rules and retry with corrected values.",
  [SdkErrorCode.INVALID_ADDRESS]:
    "One or more Stellar addresses are malformed. Each account address must be a 56-character base32 string starting with 'G' (or 'M' for muxed addresses) with a valid CRC16 checksum.",
  [SdkErrorCode.INVALID_CONTRACT_ADDRESS]:
    "The contract address is not a valid Soroban C-address. It must be 56 base32 characters starting with 'C' with a valid CRC16 checksum. Use validateContractAddress() to check it, or StrKey.encodeContract() to generate one.",
  [SdkErrorCode.INVALID_INVOICE_ID]:
    "The invoice ID is malformed. Provide a valid invoice identifier (a non-empty string or the expected numeric/hex format for this network).",
  [SdkErrorCode.INVALID_DEADLINE]:
    "The invoice deadline is invalid. Provide a future Unix timestamp (in seconds) that is later than the current ledger time.",
  [SdkErrorCode.INVALID_STATUS]:
    "The invoice status value is not recognized. Use one of the documented status values (Pending, Funded, Released, Refunded, Disputed, Frozen).",
  [SdkErrorCode.INVALID_AMOUNT]:
    "The payment amount is malformed or out of range. Provide a positive integer amount in stroops (or a correctly formatted decimal string).",
  [SdkErrorCode.INVALID_RECIPIENT]:
    "One or more recipient addresses are invalid. Check that each recipient is a valid Stellar public key.",
  [SdkErrorCode.INVALID_CONFIG]:
    "The SDK configuration is invalid. Run the configuration validator and fix the reported fields before retrying.",
  [SdkErrorCode.MISSING_REQUIRED_FIELD]:
    "A required field is missing from the request. Populate every required field documented for this operation and retry.",
  [SdkErrorCode.VALUE_OUT_OF_RANGE]:
    "A provided value is outside its permitted range. Check the documented minimum and maximum bounds and retry with a valid value.",
  // Network / transport
  [SdkErrorCode.NETWORK_ERROR]:
    "A network-level failure occurred. Check your connectivity and retry; if it persists, try a fallback RPC or Horizon endpoint.",
  [SdkErrorCode.NETWORK_TIMEOUT]:
    "The network request timed out. Check your connection and retry; the transaction may still settle.",
  [SdkErrorCode.RPC_FAILED]:
    "The RPC node rejected or failed to process the request. Retry, or switch to a fallback RPC endpoint if the node appears unhealthy.",
  [SdkErrorCode.HORIZON_ERROR]:
    "Horizon returned an error response. Inspect the error payload, fix the request if it is malformed, and retry otherwise.",
  [SdkErrorCode.SERVICE_UNAVAILABLE]:
    "The network endpoint is temporarily unavailable. Wait briefly and retry, or switch to a fallback endpoint.",
  [SdkErrorCode.RATE_LIMITED]:
    "Requests are being rate limited. Back off and retry after a short delay.",
  [SdkErrorCode.CONNECTION_REFUSED]:
    "The connection to the endpoint was refused. Verify the endpoint URL and that the service is running, then retry.",
  [SdkErrorCode.DNS_RESOLUTION_FAILED]:
    "The endpoint hostname could not be resolved. Check the URL and your DNS/network configuration, then retry.",
  [SdkErrorCode.TLS_ERROR]:
    "A TLS/SSL error occurred while contacting the endpoint. Verify the endpoint certificate and your trust store, then retry.",
  // Transaction lifecycle
  [SdkErrorCode.TRANSACTION_FAILED]:
    "The transaction failed on-chain. Inspect the transaction result and diagnostic events, fix the underlying cause, then build and submit a new transaction.",
  [SdkErrorCode.TRANSACTION_EXPIRED]:
    "The transaction expired before being included in a ledger. Rebuild it with fresh time bounds and a current sequence number, then resubmit.",
  [SdkErrorCode.SEQUENCE_MISMATCH]:
    "The transaction's sequence number is stale. Fetch the account's current sequence number, rebuild the transaction, and resubmit.",
  [SdkErrorCode.INSUFFICIENT_FEE]:
    "The transaction fee is too low. Increase the base fee (and resource fee, for Soroban) and rebuild the transaction.",
  [SdkErrorCode.SUBMISSION_FAILED]:
    "Submitting the transaction failed. Verify network connectivity and the transaction payload, then retry submission; check status before assuming failure.",
  [SdkErrorCode.CONFIRMATION_TIMEOUT]:
    "The transaction was not confirmed in time. Poll the transaction status by hash before resubmitting to avoid double submission.",
  [SdkErrorCode.VERIFICATION_FAILED]:
    "Pre-submit verification rejected the transaction. Review the failed checks (signatures, fee, sequence, time bounds) and rebuild the transaction before submitting.",
  [SdkErrorCode.MISSING_SIGNATURE]:
    "The transaction is missing a required signature. Collect all required signatures (per the account thresholds) before submitting.",
  [SdkErrorCode.INVALID_SIGNATURE]:
    "A signature on the transaction failed verification. Re-sign with the correct key over the exact transaction hash and rebuild the signature envelope.",
  [SdkErrorCode.TRANSACTION_NOT_FOUND]:
    "The transaction could not be found by hash. Confirm the hash and network, and allow time for propagation before retrying.",
  [SdkErrorCode.DUPLICATE_TRANSACTION]:
    "An identical transaction was already submitted. Check the status of the existing transaction before resubmitting to avoid duplicates.",
  [SdkErrorCode.TRANSACTION_MALFORMED]:
    "The transaction envelope is malformed. Rebuild the transaction with the SDK builders and validate it before submitting.",
  // Soroban contract execution
  [SdkErrorCode.CONTRACT_NOT_FOUND]:
    "The contract does not exist on this network. Verify the contract address and network passphrase; deploy the contract if it is missing.",
  [SdkErrorCode.CONTRACT_REJECTED]:
    "The contract rejected the transaction. Review the operation parameters and the invoice state before retrying.",
  [SdkErrorCode.SIMULATION_FAILED]:
    "Contract simulation failed. Inspect the simulation error and diagnostic events, correct the invocation, and resimulate before submitting.",
  [SdkErrorCode.OUT_OF_RESOURCE]:
    "The invocation exceeded the Soroban resource budget. Reduce the work done by the invocation or increase the resource fee and limits, then resimulate.",
  [SdkErrorCode.CONTRACT_PANIC]:
    "The contract panicked during execution. Inspect the diagnostic events for the panic message, correct the invocation, and resimulate.",
  [SdkErrorCode.CONTRACT_INVOCATION_FAILED]:
    "The contract invocation failed. Review the operation parameters and invoice state, then resimulate before resubmitting.",
  // Authorization
  [SdkErrorCode.UNAUTHORIZED]:
    "You are not authorized to perform this action. Ensure you are signing with the correct account and hold the required role.",
  [SdkErrorCode.WALLET_NOT_CONNECTED]:
    "No wallet is connected. Connect and unlock your wallet before retrying the operation.",
  [SdkErrorCode.AUTHENTICATION_FAILED]:
    "Wallet or signer authentication failed. Re-authenticate with your wallet or signer and retry.",
  [SdkErrorCode.FORBIDDEN]:
    "The action is forbidden for the current account. Verify the account holds the required role or permission and retry.",
  [SdkErrorCode.SESSION_EXPIRED]:
    "The authentication session has expired. Re-authenticate and retry the operation.",
  // Operational / state
  [SdkErrorCode.STATE_CONFLICT]:
    "The operation conflicted with a newer on-chain state. Re-fetch the latest state, merge or reapply your changes, and retry.",
  [SdkErrorCode.CIRCUIT_OPEN]:
    "The circuit breaker is open because recent calls are failing. Wait for the cooldown window to close before retrying.",
  [SdkErrorCode.OPERATION_ABORTED]:
    "The operation was aborted before completion. Verify no partial state was committed, then retry if appropriate.",
  [SdkErrorCode.BATCH_TOO_LARGE]:
    "The batch exceeds the maximum permitted size. Split the batch into smaller chunks and process them sequentially.",
  [SdkErrorCode.INTERNAL_ERROR]:
    "An unexpected internal SDK error occurred. Retry once; if the failure persists, report it with the error context attached.",
  [SdkErrorCode.NOT_IMPLEMENTED]:
    "This feature is not implemented in the current SDK version. Check the documentation for supported alternatives or upgrade the SDK.",
  [SdkErrorCode.UNSUPPORTED_NETWORK]:
    "The configured network is not supported. Use one of the supported network passphrases (e.g. testnet, mainnet) and retry.",
  [SdkErrorCode.CONFIGURATION_ERROR]:
    "The SDK is misconfigured. Review the configuration and correct the reported fields before retrying.",
};

function suggestionForCode(code: string): string {
  const normalized = code.toUpperCase() as SdkErrorCode;
  return Object.prototype.hasOwnProperty.call(CODE_SUGGESTION_TABLE, normalized)
    ? CODE_SUGGESTION_TABLE[normalized]
    : GENERIC_FALLBACK;
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
