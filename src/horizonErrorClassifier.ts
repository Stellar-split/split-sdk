/**
 * Horizon Error Classifier — maps Stellar transaction/operation result codes to
 * a structured error taxonomy with retry advice, severity, and descriptions.
 *
 * Integrates with RetryEngine and FallbackChain to drive automated retry and
 * failover decisions based on the actual on-chain error rather than opaque
 * string matching.
 */

import { HorizonErrorClassification } from "./errors.js";

// ---------------------------------------------------------------------------
// Type definitions local to this module
// ---------------------------------------------------------------------------

/** Severity levels for classified errors. */
export type ErrorSeverity = "low" | "medium" | "high" | "critical" | "unknown";

/**
 * Result codes can be either a single string (one code) or an array of
 * strings (hierarchical result codes, e.g. ["tx_failed", "op_no_trust"]).
 */
export type RawResultCodes =
  | { transactionResult: string; operationsResults?: string[] }
  | string
  | string[];

// ---------------------------------------------------------------------------
// Known tx_* result code taxonomy
// ---------------------------------------------------------------------------

interface TxCodeEntry {
  isRetryable: boolean;
  severity: ErrorSeverity;
  description: string;
  suggestedAction: string;
}

const TX_CODE_MAP: Record<string, TxCodeEntry> = {
  tx_success: {
    isRetryable: false,
    severity: "low",
    description: "Transaction was applied successfully.",
    suggestedAction: "No action needed.",
  },
  tx_failed: {
    isRetryable: false,
    severity: "high",
    description: "One of the operations in the transaction failed.",
    suggestedAction: "Check the individual operation result codes for details.",
  },
  tx_too_early: {
    isRetryable: true,
    severity: "medium",
    description:
      "The transaction's time bounds have not yet been reached. The minimum time condition is in the future.",
    suggestedAction: "Wait until the time bounds window opens and resubmit.",
  },
  tx_too_late: {
    isRetryable: false,
    severity: "high",
    description:
      "The transaction's time bounds have passed. The maximum time condition is in the past.",
    suggestedAction: "Create a new transaction with updated time bounds.",
  },
  tx_missing_operation: {
    isRetryable: false,
    severity: "high",
    description: "The transaction envelope contains zero operations.",
    suggestedAction: "Add at least one operation to the transaction.",
  },
  tx_bad_seq: {
    isRetryable: true,
    severity: "medium",
    description:
      "The transaction's sequence number is incorrect. The account's current sequence number does not match.",
    suggestedAction:
      "Fetch the latest account sequence number and rebuild the transaction.",
  },
  tx_bad_auth: {
    isRetryable: false,
    severity: "high",
    description:
      "The transaction has insufficient or incorrect signatures to meet the account's thresholds.",
    suggestedAction:
      "Ensure all required signers have signed with the correct weights.",
  },
  tx_insufficient_balance: {
    isRetryable: false,
    severity: "high",
    description:
      "The source account does not have enough lumens to cover the transaction fee and minimum balance.",
    suggestedAction: "Fund the source account with additional lumens.",
  },
  tx_no_source_account: {
    isRetryable: false,
    severity: "high",
    description:
      "The transaction's source account does not exist on the ledger.",
    suggestedAction:
      "Create the source account first (it must be funded above the minimum reserve).",
  },
  tx_insufficient_fee: {
    isRetryable: true,
    severity: "medium",
    description:
      "The transaction fee is too low for the current network conditions.",
    suggestedAction:
      "Increase the base fee and resubmit (consider surge pricing).",
  },
  tx_bad_auth_extra: {
    isRetryable: false,
    severity: "medium",
    description:
      "The transaction includes an unused signature (extra signer not needed).",
    suggestedAction:
      "Remove the unused signature(s) and resubmit.",
  },
  tx_internal_error: {
    isRetryable: true,
    severity: "critical",
    description:
      "The transaction failed due to an internal network error.",
    suggestedAction:
      "Retry the transaction; if the issue persists, switch to a different Horizon endpoint.",
  },
  tx_not_supported: {
    isRetryable: false,
    severity: "critical",
    description:
      "The transaction type or operation is not supported by this network.",
    suggestedAction:
      "Verify the network configuration and ensure the operation is supported.",
  },
  tx_bad_min_time: {
    isRetryable: false,
    severity: "high",
    description:
      "The transaction's minimum time bound is not valid.",
    suggestedAction:
      "Ensure the minTime value is a valid UNIX timestamp and not in an invalid range.",
  },
  tx_bad_max_time: {
    isRetryable: false,
    severity: "high",
    description:
      "The transaction's maximum time bound is not valid.",
    suggestedAction:
      "Ensure the maxTime value is a valid UNIX timestamp ahead of the minTime.",
  },
  tx_soroban_invalid: {
    isRetryable: false,
    severity: "high",
    description:
      "The Soroban transaction is invalid (e.g. bad footprint, invalid resource config).",
    suggestedAction:
      "Review the Soroban transaction parameters and simulation output.",
  },
};

// ---------------------------------------------------------------------------
// Known op_* result code taxonomy
// ---------------------------------------------------------------------------

const OP_CODE_MAP: Record<string, TxCodeEntry> = {
  op_inner: {
    isRetryable: false,
    severity: "medium",
    description:
      "The inner object of the operation result is missing or invalid.",
    suggestedAction: "Review the operation details for missing fields.",
  },
  op_bad_auth: {
    isRetryable: false,
    severity: "high",
    description:
      "The operation requires additional signatures (e.g. source account not the same as the operation source).",
    suggestedAction:
      "Ensure the operation source account has signed the transaction.",
  },
  op_no_source_account: {
    isRetryable: false,
    severity: "high",
    description: "The operation's source account does not exist.",
    suggestedAction: "Create and fund the source account first.",
  },
  op_not_supported: {
    isRetryable: false,
    severity: "critical",
    description: "The operation is not supported on this network.",
    suggestedAction:
      "Check the network passphrase and ensure the operation type is valid.",
  },
  op_too_many_subentries: {
    isRetryable: true,
    severity: "high",
    description:
      "The operation would cause the account to exceed the maximum number of subentries.",
    suggestedAction:
      "Remove unused trustlines, offers, or data entries from the account, then retry.",
  },
  op_exceeded_work_limit: {
    isRetryable: true,
    severity: "medium",
    description:
      "The Soroban operation exceeded its compute (CPU instruction) budget.",
    suggestedAction:
      "Increase the instruction budget in the Soroban transaction data or optimise the contract call.",
  },
  op_underfunded: {
    isRetryable: false,
    severity: "high",
    description:
      "The account does not have sufficient funds to complete the operation (e.g. payment exceeds available balance).",
    suggestedAction: "Fund the source account with additional tokens or lumens.",
  },
  op_no_trust: {
    isRetryable: false,
    severity: "high",
    description:
      "The destination account does not have a trustline for the asset being sent.",
    suggestedAction:
      "The recipient must establish a trustline for the asset before receiving it.",
  },
  op_not_authorized: {
    isRetryable: false,
    severity: "high",
    description:
      "The trustline for the asset has not been authorised by the asset issuer (applicable to AUTH_REQUIRED assets).",
    suggestedAction:
      "Contact the asset issuer to authorize the trustline.",
  },
  op_line_full: {
    isRetryable: false,
    severity: "high",
    description:
      "The receiving account's trustline has reached its limit for the asset.",
    suggestedAction:
      "Increase the trustline limit or reduce the payment amount.",
  },
  op_no_issuer: {
    isRetryable: false,
    severity: "critical",
    description: "The asset issuer account does not exist on the ledger.",
    suggestedAction:
      "Verify the asset code and issuer address are correct.",
  },
  op_too_few_offers: {
    isRetryable: false,
    severity: "medium",
    description:
      "There are not enough offers on the order book to complete the path payment at the requested rate.",
    suggestedAction:
      "Try a smaller amount, relax the destination-amount constraints, or use a different path.",
  },
  op_cross_self: {
    isRetryable: true,
    severity: "medium",
    description:
      "The path payment would cross its own offers, creating a loop.",
    suggestedAction:
      "Adjust the payment path or amount to avoid crossing own offers.",
  },
  op_sell_no_trust: {
    isRetryable: false,
    severity: "high",
    description:
      "The selling account does not have a trustline for the asset being sold.",
    suggestedAction:
      "Establish a trustline for the asset you are attempting to sell.",
  },
  op_buy_no_trust: {
    isRetryable: false,
    severity: "high",
    description:
      "The buying account does not have a trustline for the asset being purchased.",
    suggestedAction:
      "Establish a trustline for the asset you are attempting to buy.",
  },
  op_sell_no_issuer: {
    isRetryable: false,
    severity: "critical",
    description: "The selling asset's issuer does not exist.",
    suggestedAction: "Verify the selling asset code and issuer.",
  },
  op_buy_no_issuer: {
    isRetryable: false,
    severity: "critical",
    description: "The buying asset's issuer does not exist.",
    suggestedAction: "Verify the buying asset code and issuer.",
  },
  op_sell_underfunded: {
    isRetryable: false,
    severity: "high",
    description:
      "The account does not have enough of the selling asset to complete the path payment.",
    suggestedAction: "Fund the account with more of the selling asset.",
  },
  op_buy_underfunded: {
    isRetryable: false,
    severity: "high",
    description:
      "The account does not have enough lumens to cover the reserve for the buying asset trustline.",
    suggestedAction: "Fund the account with additional lumens.",
  },
  op_sell_line_full: {
    isRetryable: false,
    severity: "high",
    description:
      "The receiving account's trustline for the selling asset has reached its limit.",
    suggestedAction:
      "Increase the trustline limit on the receiving account.",
  },
  op_buy_line_full: {
    isRetryable: false,
    severity: "high",
    description:
      "The receiving account's trustline for the buying asset has reached its limit.",
    suggestedAction:
      "Increase the trustline limit on the receiving account.",
  },
  op_low_reserve: {
    isRetryable: false,
    severity: "high",
    description:
      "The source account does not have enough lumens to meet the minimum reserve after the operation.",
    suggestedAction:
      "Fund the source account with additional lumens to cover the reserve increase.",
  },
  op_too_many_sponsoring: {
    isRetryable: false,
    severity: "high",
    description:
      "The account would exceed the maximum number of sponsored reserve entries.",
    suggestedAction:
      "Remove some existing sponsored entries or adjust the operation.",
  },
  op_sponsorship_not_found: {
    isRetryable: false,
    severity: "medium",
    description:
      "The sponsorship relationship referenced in the operation does not exist.",
    suggestedAction:
      "Verify the sponsorship ID and account making the call.",
  },
  op_sell_no_dst: {
    isRetryable: false,
    severity: "high",
    description: "The destination account for the sell does not exist.",
    suggestedAction: "Verify the destination account address.",
  },
  op_buy_no_dst: {
    isRetryable: false,
    severity: "high",
    description: "The destination account for the buy does not exist.",
    suggestedAction: "Verify the destination account address.",
  },
  op_malformed: {
    isRetryable: false,
    severity: "high",
    description:
      "The operation input is malformed in some way (bad asset code, invalid amount, etc.).",
    suggestedAction:
      "Check all operation parameters for correctness (asset codes, amounts, addresses).",
  },
  op_sell_malformed: {
    isRetryable: false,
    severity: "high",
    description:
      "The path-payment sell operation is malformed.",
    suggestedAction:
      "Check the sell asset, amount, and destination parameters.",
  },
  op_buy_malformed: {
    isRetryable: false,
    severity: "high",
    description:
      "The path-payment buy operation is malformed.",
    suggestedAction:
      "Check the buy asset, amount, and destination parameters.",
  },
  op_offer_malformed: {
    isRetryable: false,
    severity: "high",
    description:
      "The manage-sell/buy-offer operation is malformed.",
    suggestedAction:
      "Check the offer parameters (price, amount, assets) for correctness.",
  },
  op_soroban_resource_limit_exceeded: {
    isRetryable: true,
    severity: "medium",
    description:
      "The Soroban operation exceeded its resource limits (ledger entry reads, writes, etc.).",
    suggestedAction:
      "Increase the resource limits in the Soroban transaction or optimise the contract call.",
  },
  // Additional Soroban-related codes (from HostError / xdr.ScError)
  op_soroban_storage_full: {
    isRetryable: true,
    severity: "high",
    description:
      "The Soroban host ran out of temporary storage during execution.",
    suggestedAction:
      "Retry the transaction; if it persists, reduce the storage footprint or wait for ledger compaction.",
  },
};

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Classify a set of Horizon transaction/operation result codes into a
 * structured error taxonomy.
 *
 * Accepts the raw {@link HorizonApi.TransactionFailedResultCodes} object
 * returned by `server.submitTransaction()`, as well as plain strings or arrays
 * of strings for convenience.
 *
 * @param resultCodes - One or more result codes from a Horizon response.
 * @returns A {@link HorizonErrorClassification} with retry advice, severity,
 *          human-readable description, and suggested action.
 */
export function classifyHorizonError(
  resultCodes: RawResultCodes
): HorizonErrorClassification {
  // Extract the transaction-level code
  let txCode: string | undefined;
  let opCodes: string[] = [];

  if (typeof resultCodes === "string") {
    txCode = resultCodes;
  } else if (Array.isArray(resultCodes)) {
    // First element is tx-level, rest are op-level
    if (resultCodes.length > 0) {
      txCode = resultCodes[0];
      opCodes = resultCodes.slice(1);
    }
  } else if (typeof resultCodes === "object" && resultCodes !== null) {
    txCode = (resultCodes as Record<string, unknown>).transactionResult as string | undefined;
    const opsResults = (resultCodes as Record<string, unknown>).operationsResults;
    if (Array.isArray(opsResults)) {
      opCodes = opsResults.filter((r): r is string => typeof r === "string");
    }
  }

  // Classify the transaction code
  const txEntry = txCode ? TX_CODE_MAP[txCode] : undefined;

  // If we have operation results, classify each and pick the most severe
  let opEntry: TxCodeEntry | undefined;
  let matchedOpCode: string | undefined;

  if (opCodes.length > 0) {
    for (const opCode of opCodes) {
      const entry = OP_CODE_MAP[opCode];
      if (entry) {
        if (!opEntry || severityRank(entry.severity) > severityRank(opEntry.severity)) {
          opEntry = entry;
          matchedOpCode = opCode;
        }
      }
    }
  }

  // Prefer the most informative classification
  const primaryEntry: TxCodeEntry | undefined = opEntry ?? txEntry;

  if (!primaryEntry) {
    return {
      code: txCode ?? "unknown",
      isRetryable: false,
      severity: "unknown",
      description: `Unrecognised result code: ${txCode ?? "none"}.${opCodes.length > 0 ? ` Operation codes: ${opCodes.join(", ")}` : ""}`,
      suggestedAction:
        "Review the raw result codes and consult the Stellar documentation.",
      operationCode: matchedOpCode,
    };
  }

  return {
    code: txCode ?? "unknown",
    isRetryable: primaryEntry.isRetryable,
    severity: primaryEntry.severity,
    description: primaryEntry.description,
    suggestedAction: primaryEntry.suggestedAction,
    operationCode: matchedOpCode ?? opCodes[0],
  };
}

/**
 * Convenience helper: returns `true` when the classification indicates the
 * error is safe to retry.
 */
export function isHorizonErrorRetryable(
  resultCodes: RawResultCodes
): boolean {
  return classifyHorizonError(resultCodes).isRetryable;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const SEVERITY_RANK: Record<ErrorSeverity, number> = {
  low: 10,
  medium: 20,
  high: 30,
  critical: 40,
  unknown: 0,
};

function severityRank(severity: ErrorSeverity): number {
  return SEVERITY_RANK[severity] ?? 0;
}

// Re-export the TxCodeEntry type for internal use by other modules
export type { TxCodeEntry };
