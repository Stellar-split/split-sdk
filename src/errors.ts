/**
 * Typed error hierarchy for StellarSplit SDK.
 *
 * Maps known Soroban contract panic messages to structured subclasses
 * so callers can handle specific failure cases with instanceof checks.
 */

/** Base class for all StellarSplit SDK errors. */
export class StellarSplitError extends Error {
  /** Unique error code for programmatic handling. */
  readonly code: string;
  /** Additional context for debugging. */
  readonly context?: Record<string, unknown>;
  /** The raw error string from the Soroban RPC, if available. */
  readonly raw?: string;

  constructor(
    message: string,
    code: string = "SDK_ERROR",
    context?: Record<string, unknown>,
    raw?: string
  ) {
    super(message);
    this.name = "StellarSplitError";
    this.code = code;
    this.context = context;
    this.raw = raw;
    // Maintain proper prototype chain in transpiled environments
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the requested invoice does not exist on-chain. */
export class InvoiceNotFoundError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(`Invoice not found: ${invoiceId}`, "INVOICE_NOT_FOUND", { invoiceId }, raw);
    this.name = "InvoiceNotFoundError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when an operation requires the invoice to be Pending but it is not. */
export class InvoiceNotPendingError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(
      `Invoice is not in Pending state: ${invoiceId}`,
      "INVOICE_NOT_PENDING",
      { invoiceId },
      raw
    );
    this.name = "InvoiceNotPendingError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a transaction is attempted after the invoice deadline has passed. */
export class DeadlinePassedError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(
      `Invoice deadline has passed: ${invoiceId}`,
      "DEADLINE_PASSED",
      { invoiceId },
      raw
    );
    this.name = "DeadlinePassedError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a payment amount exceeds the remaining unfunded balance. */
export class InsufficientBalanceError extends StellarSplitError {
  readonly invoiceId: string;
  readonly amount: bigint;
  readonly remaining: bigint;

  constructor(invoiceId: string, amount: bigint = 0n, remaining: bigint = 0n, raw?: string) {
    super(
      `Insufficient balance: ${amount} exceeds remaining ${remaining} for invoice ${invoiceId}`,
      "INSUFFICIENT_BALANCE",
      { invoiceId, amount: (amount ?? 0n).toString(), remaining: (remaining ?? 0n).toString() },
      raw
    );
    this.name = "InsufficientBalanceError";
    this.invoiceId = invoiceId;
    this.amount = amount ?? 0n;
    this.remaining = remaining ?? 0n;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a payment amount exceeds the remaining unfunded balance (legacy alias). */
export class PaymentExceedsRemainingError extends InsufficientBalanceError {
  constructor(invoiceId: string, amount: bigint = 0n, remaining: bigint = 0n, raw?: string) {
    super(invoiceId, amount, remaining, raw);
    this.name = "PaymentExceedsRemainingError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when an operation is attempted on a frozen (disputed/locked) invoice. */
export class InvoiceFrozenError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(`Invoice is frozen: ${invoiceId}`, "INVOICE_FROZEN", { invoiceId }, raw);
    this.name = "InvoiceFrozenError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when an operation requires co-creator sign-off but the invoice does not require it. */
export class CoCreatorApprovalNotRequiredError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(
      `Invoice does not require co-creator sign-off: ${invoiceId}`,
      "CO_CREATOR_APPROVAL_NOT_REQUIRED",
      { invoiceId },
      raw
    );
    this.name = "CoCreatorApprovalNotRequiredError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when createInvoice is attempted without the required qualifying NFT. */
export class NftGateRequiredError extends StellarSplitError {
  readonly creatorAddress: string;
  readonly nftContractAddress: string | null;

  constructor(creatorAddress: string, nftContractAddress: string | null, raw?: string) {
    const contract = nftContractAddress ?? "unknown";
    super(
      `Creator ${creatorAddress} must hold a qualifying NFT from ${contract} to create invoices`,
      "NFT_GATE_REQUIRED",
      { creatorAddress, nftContractAddress: nftContractAddress ?? undefined },
      raw
    );
    this.name = "NftGateRequiredError";
    this.creatorAddress = creatorAddress;
    this.nftContractAddress = nftContractAddress;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the wallet is not connected or not available. */
export class WalletNotConnectedError extends StellarSplitError {
  constructor(message: string = "Wallet is not connected", raw?: string) {
    super(message, "WALLET_NOT_CONNECTED", undefined, raw);
    this.name = "WalletNotConnectedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when an RPC call fails. */
export class RpcError extends StellarSplitError {
  readonly statusCode?: number;
  readonly url?: string;

  constructor(
    message: string,
    statusCode?: number,
    url?: string,
    raw?: string
  ) {
    super(message, "RPC_ERROR", { statusCode, url }, raw);
    this.name = "RpcError";
    this.statusCode = statusCode;
    this.url = url;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a simulation or transaction fails due to contract error. */
export class ContractError extends StellarSplitError {
  readonly method?: string;
  readonly errorCode?: string;

  constructor(
    message: string,
    method?: string,
    errorCode?: string,
    raw?: string
  ) {
    super(message, "CONTRACT_ERROR", { method, errorCode }, raw);
    this.name = "ContractError";
    this.method = method;
    this.errorCode = errorCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when resolving a forward chain exceeds the maximum depth limit. */
export class ForwardChainTooDeepError extends StellarSplitError {
  readonly depth: number;
  readonly invoiceId: string;

  constructor(depth: number, invoiceId: string, raw?: string) {
    super(
      `Forward chain exceeded maximum depth of ${depth} at invoice ${invoiceId}`,
      "FORWARD_CHAIN_TOO_DEEP",
      { depth, invoiceId },
      raw
    );
    this.name = "ForwardChainTooDeepError";
    this.depth = depth;
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a prerequisite chain exceeds the maximum traversal depth. */
export class ChainTooDeepError extends StellarSplitError {
  readonly maxDepth: number;

  constructor(maxDepth: number, raw?: string) {
    super(
      `Prerequisite chain exceeded maximum depth of ${maxDepth}`,
      "CHAIN_TOO_DEEP",
      { maxDepth },
      raw
    );
    this.name = "ChainTooDeepError";
    this.maxDepth = maxDepth;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the circuit breaker is open and requests are not allowed. */
export class CircuitOpenError extends StellarSplitError {
  constructor(context?: Record<string, unknown>) {
    super("Circuit breaker is open; requests are temporarily blocked", "CIRCUIT_OPEN", context);
    this.name = "CircuitOpenError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a forward chain contains a cycle. */
export class CircularForwardChainError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(
      `Circular forward chain detected at invoice: ${invoiceId}`,
      "CIRCULAR_FORWARD_CHAIN",
      { invoiceId },
      raw
    );
    this.name = "CircularForwardChainError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a prerequisite chain contains a cycle. */
export class CircularPrerequisiteError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, raw?: string) {
    super(
      `Circular prerequisite chain detected at invoice: ${invoiceId}`,
      "CIRCULAR_PREREQUISITE",
      { invoiceId },
      raw
    );
    this.name = "CircularPrerequisiteError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when an operation is attempted without proper authorization. */
export class UnauthorizedError extends StellarSplitError {
  constructor(message: string = "Unauthorized", raw?: string) {
    super(message, "UNAUTHORIZED", undefined, raw);
    this.name = "UnauthorizedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when validation fails for input data (e.g., template deserialization). */
export class ValidationError extends StellarSplitError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "VALIDATION_ERROR", context, message);
    this.name = "ValidationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a plugin with the same name is already registered. */
export class PluginAlreadyRegisteredError extends StellarSplitError {
  readonly pluginName: string;

  constructor(pluginName: string) {
    super(`Plugin "${pluginName}" is already registered.`, "PLUGIN_ALREADY_REGISTERED", { pluginName });
    this.name = "PluginAlreadyRegisteredError";
    this.pluginName = pluginName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when batch size validation fails. */
export class InvalidBatchSizeError extends StellarSplitError {
  readonly expected: string;
  readonly actual: number;

  constructor(expected: string, actual: number) {
    super(`Invalid batch size: expected ${expected}, got ${actual}.`, "INVALID_BATCH_SIZE", { expected, actual });
    this.name = "InvalidBatchSizeError";
    this.expected = expected;
    this.actual = actual;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when an invoice is not in Released status for receipt generation. */
export class InvoiceNotReleasedError extends StellarSplitError {
  readonly invoiceId: string;
  readonly status: string;

  constructor(invoiceId: string, status: string) {
    super(`Invoice ${invoiceId} is not in Released status (current: ${status}).`, "INVOICE_NOT_RELEASED", { invoiceId, status });
    this.name = "InvoiceNotReleasedError";
    this.invoiceId = invoiceId;
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a transaction fails to submit. */
export class TransactionFailedError extends StellarSplitError {
  readonly txHash?: string;
  readonly errorResult?: string;

  constructor(message: string, txHash?: string, errorResult?: string) {
    super(message, "TRANSACTION_FAILED", { txHash, errorResult });
    this.name = "TransactionFailedError";
    this.txHash = txHash;
    this.errorResult = errorResult;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a transaction is not confirmed after submission. */
export class TransactionNotConfirmedError extends StellarSplitError {
  readonly status: string;

  constructor(status: string) {
    super(`Transaction not confirmed: ${status}`, "TRANSACTION_NOT_CONFIRMED", { status });
    this.name = "TransactionNotConfirmedError";
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when simulation of a contract call fails. */
export class SimulationFailedError extends StellarSplitError {
  readonly method?: string;
  readonly error?: string;

  constructor(message: string, method?: string, error?: string) {
    super(message, "SIMULATION_FAILED", { method, error });
    this.name = "SimulationFailedError";
    this.method = method;
    this.error = error;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when no return value is received from a contract call. */
export class NoReturnValueError extends StellarSplitError {
  readonly method: string;

  constructor(method: string) {
    super(`No return value from ${method}`, "NO_RETURN_VALUE", { method });
    this.name = "NoReturnValueError";
    this.method = method;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when an unknown network is specified. */
export class UnknownNetworkError extends StellarSplitError {
  readonly network: string;

  constructor(network: string) {
    super(`Unknown network: ${network}`, "UNKNOWN_NETWORK", { network });
    this.name = "UnknownNetworkError";
    this.network = network;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when too few signatures are provided. */
export class InsufficientSignaturesError extends StellarSplitError {
  readonly provided: number;
  readonly required: number;

  constructor(provided: number, required: number) {
    super(
      `Insufficient signatures: ${provided} provided, ${required} required`,
      "INSUFFICIENT_SIGNATURES",
      { provided, required }
    );
    this.name = "InsufficientSignaturesError";
    this.provided = provided;
    this.required = required;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the clone chain exceeds maximum depth. */
export class CloneChainTooDeepError extends StellarSplitError {
  readonly invoiceId?: string;

  constructor(invoiceId?: string) {
    const msg = invoiceId
      ? `Clone chain cycle detected at invoice ${invoiceId}`
      : "Clone chain depth exceeded";
    super(msg, "CLONE_CHAIN_TOO_DEEP", { invoiceId });
    this.name = "CloneChainTooDeepError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when no pending payout is found for a recipient. */
export class NoPendingPayoutError extends StellarSplitError {
  readonly recipient: string;
  readonly invoiceId: string;

  constructor(recipient: string, invoiceId: string) {
    super(`No pending payout for recipient ${recipient} on invoice ${invoiceId}`, "NO_PENDING_PAYOUT", {
      recipient,
      invoiceId,
    });
    this.name = "NoPendingPayoutError";
    this.recipient = recipient;
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when attestation parameters are invalid. */
export class InvalidAttestationError extends StellarSplitError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "INVALID_ATTESTATION", context);
    this.name = "InvalidAttestationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when invoice flow fetcher is not registered. */
export class InvoiceFlowFetcherNotRegisteredError extends StellarSplitError {
  constructor() {
    super("Invoice flow fetcher has not been registered.", "FLOW_FETCHER_NOT_REGISTERED");
    this.name = "InvoiceFlowFetcherNotRegisteredError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when invoice fetcher is not registered. */
export class InvoiceFetcherNotRegisteredError extends StellarSplitError {
  constructor() {
    super("Invoice fetcher has not been registered.", "INVOICE_FETCHER_NOT_REGISTERED");
    this.name = "InvoiceFetcherNotRegisteredError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when LoadBalancer endpoint is not found. */
export class UnknownEndpointError extends StellarSplitError {
  readonly url: string;

  constructor(url: string) {
    super(`Unknown endpoint: ${url}`, "UNKNOWN_ENDPOINT", { url });
    this.name = "UnknownEndpointError";
    this.url = url;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when RPC is unavailable with no cached data. */
export class RpcUnavailableError extends StellarSplitError {
  readonly key: string;

  constructor(key: string) {
    super(`RPC unavailable and no cached data for key "${key}"`, "RPC_UNAVAILABLE", { key });
    this.name = "RpcUnavailableError";
    this.key = key;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when discovery fetch fails. */
export class DiscoveryFetchError extends StellarSplitError {
  readonly status: number;
  readonly statusText: string;

  constructor(status: number, statusText: string) {
    super(`Discovery fetch failed: ${status} ${statusText}`, "DISCOVERY_FETCH_FAILED", { status, statusText });
    this.name = "DiscoveryFetchError";
    this.status = status;
    this.statusText = statusText;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when payer address is required but not provided. */
export class PayerAddressRequiredError extends StellarSplitError {
  constructor() {
    super("payerAddress is required when generating receipt from a client", "PAYER_ADDRESS_REQUIRED");
    this.name = "PayerAddressRequiredError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a signer fails to sign a transaction. */
export class SignerFailedError extends StellarSplitError {
  readonly signer: string;
  readonly reason: string;

  constructor(signer: string, reason: string) {
    super(`Signer ${signer} failed to sign: ${reason}`, "SIGNER_FAILED", { signer, reason });
    this.name = "SignerFailedError";
    this.signer = signer;
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when at least one signer is required. */
export class NoSignerProvidedError extends StellarSplitError {
  constructor() {
    super("At least one signer required", "NO_SIGNER_PROVIDED");
    this.name = "NoSignerProvidedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when connection pool is improperly configured. */
export class ConnectionPoolConfigError extends StellarSplitError {
  readonly issue: string;

  constructor(issue: string) {
    super(`ConnectionPool: ${issue}`, "CONNECTION_POOL_CONFIG_ERROR", { issue });
    this.name = "ConnectionPoolConfigError";
    this.issue = issue;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when connection pool is already disposed. */
export class ConnectionPoolDisposedError extends StellarSplitError {
  constructor() {
    super("ConnectionPool has been disposed", "CONNECTION_POOL_DISPOSED");
    this.name = "ConnectionPoolDisposedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when search operation fails. */
export class SearchFailedError extends StellarSplitError {
  readonly query: string;

  constructor(query: string) {
    super(`Search failed: ${query}`, "SEARCH_FAILED", { query });
    this.name = "SearchFailedError";
    this.query = query;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when transaction status is not successful. */
export class TransactionNotSuccessfulError extends StellarSplitError {
  readonly status: string;

  constructor(status: string) {
    super(`Transaction not successful: ${status}`, "TRANSACTION_NOT_SUCCESSFUL", { status });
    this.name = "TransactionNotSuccessfulError";
    this.status = status;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when queue has failed. */
export class QueueFailedError extends StellarSplitError {
  constructor() {
    super("Queue has failed; cannot enqueue new operations", "QUEUE_FAILED");
    this.name = "QueueFailedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when export format is unknown. */
export class UnknownExportFormatError extends StellarSplitError {
  readonly format: string;

  constructor(format: string) {
    super(`Unknown export format: ${format}`, "UNKNOWN_EXPORT_FORMAT", { format });
    this.name = "UnknownExportFormatError";
    this.format = format;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a DEX quote operation fails. */
export class DexQuoteFailedError extends StellarSplitError {
  readonly context?: Record<string, unknown>;

  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "DEX_QUOTE_FAILED", context);
    this.name = "DexQuoteFailedError";
    this.context = context;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when TTL extension operation fails. */
export class TtlExtensionFailedError extends StellarSplitError {
  constructor(message: string) {
    super(message, "TTL_EXTENSION_FAILED", undefined, message);
    this.name = "TtlExtensionFailedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when test harness is not initialized. */
export class TestHarnessNotInitializedError extends StellarSplitError {
  constructor() {
    super("Test harness not set up. Call setup() first.", "TEST_HARNESS_NOT_INITIALIZED");
    this.name = "TestHarnessNotInitializedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when an unknown test wallet address is provided. */
export class UnknownTestWalletError extends StellarSplitError {
  readonly address: string;

  constructor(address: string) {
    super(`Unknown test wallet address: ${address}`, "UNKNOWN_TEST_WALLET", { address });
    this.name = "UnknownTestWalletError";
    this.address = address;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when relationship tracker is not initialized. */
export class RelationshipTrackerNotInitializedError extends StellarSplitError {
  constructor() {
    super("Call initRelationshipTracker() before trackRelationships().", "RELATIONSHIP_TRACKER_NOT_INITIALIZED");
    this.name = "RelationshipTrackerNotInitializedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when friendbot request fails. */
export class FriendbotFailedError extends StellarSplitError {
  readonly publicKey: string;
  readonly error: string;

  constructor(publicKey: string, error: string) {
    super(`Friendbot failed for ${publicKey}: ${error}`, "FRIENDBOT_FAILED", { publicKey, error });
    this.name = "FriendbotFailedError";
    this.publicKey = publicKey;
    this.error = error;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when dispute evidence bundle is missing required fields. */
export class DisputeEvidenceError extends StellarSplitError {
  constructor(message: string) {
    super(message, "DISPUTE_EVIDENCE_ERROR", undefined, message);
    this.name = "DisputeEvidenceError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when oracle price fetch fails. */
export class OraclePriceError extends StellarSplitError {
  constructor(message: string) {
    super(message, "ORACLE_PRICE_ERROR", undefined, message);
    this.name = "OraclePriceError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when Sep41 adapter unexpected return type. */
export class Sep41AdapterError extends StellarSplitError {
  constructor(message: string) {
    super(message, "SEP41_ADAPTER_ERROR", undefined, message);
    this.name = "Sep41AdapterError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when tranche status check fails. */
export class TrancheProgressError extends StellarSplitError {
  constructor(message: string) {
    super(message, "TRANCHE_PROGRESS_ERROR", undefined, message);
    this.name = "TrancheProgressError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when refund grace period error occurs. */
export class RefundGraceError extends StellarSplitError {
  readonly invoiceId?: string;
  readonly reason: string;

  constructor(reason: string, invoiceId?: string) {
    super(`Refund grace error: ${reason}`, "REFUND_GRACE_ERROR", { invoiceId, reason });
    this.name = "RefundGraceError";
    this.invoiceId = invoiceId;
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when channel reconciliation fails. */
export class ChannelReconciliationError extends StellarSplitError {
  readonly reason: string;

  constructor(reason: string) {
    super(`Channel reconciliation failed: ${reason}`, "CHANNEL_RECONCILIATION_FAILED", { reason });
    this.name = "ChannelReconciliationError";
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Error message patterns from the Soroban contract
// ---------------------------------------------------------------------------

const ERROR_PATTERNS: Array<{
  pattern: RegExp;
  factory: (invoiceId: string, raw: string) => StellarSplitError;
}> = [
  {
    pattern: /not\.found|invoice.*does.*not.*exist|no.*invoice/i,
    factory: (id, raw) => new InvoiceNotFoundError(id, raw),
  },
  {
    pattern: /not.*pending|invalid.*status|wrong.*state/i,
    factory: (id, raw) => new InvoiceNotPendingError(id, raw),
  },
  {
    pattern: /deadline.*passed|expired|past.*deadline/i,
    factory: (id, raw) => new DeadlinePassedError(id, raw),
  },
  {
    pattern: /exceeds.*remaining|overpayment|amount.*too.*large|insufficient.*balance/i,
    factory: (id, raw) => {
      const match = raw.match(/(\d+)/);
      const amount = match ? BigInt(match[0]) : 0n;
      return new InsufficientBalanceError(id, amount, 0n, raw);
    },
  },
  {
    pattern: /frozen|disputed|locked/i,
    factory: (id, raw) => new InvoiceFrozenError(id, raw),
  },
  {
    pattern: /unauthorized|not.*authorized|admin.*only|forbidden/i,
    factory: (id, raw) => new UnauthorizedError(`Unauthorized: ${raw}`, raw),
  },
];

/**
 * Parse a raw Soroban error string and return the appropriate typed error.
 *
 * @param raw       - The raw error message from the RPC.
 * @param invoiceId - The invoice ID involved in the operation, if known.
 * @returns A typed StellarSplitError subclass, or a generic StellarSplitError.
 */
export function parseSorobanError(raw: string, invoiceId: string = ""): StellarSplitError {
  for (const { pattern, factory } of ERROR_PATTERNS) {
    if (pattern.test(raw)) {
      return factory(invoiceId, raw);
    }
  }
  return new StellarSplitError(raw, "SDK_ERROR", undefined, raw);
}

// ---------------------------------------------------------------------------
// Type guard helpers
// ---------------------------------------------------------------------------

export function isStellarSplitError(err: unknown): err is StellarSplitError {
  return err instanceof StellarSplitError;
}

export function isInvoiceNotFoundError(err: unknown): err is InvoiceNotFoundError {
  return err instanceof InvoiceNotFoundError;
}

export function isInvoiceNotPendingError(err: unknown): err is InvoiceNotPendingError {
  return err instanceof InvoiceNotPendingError;
}

export function isDeadlinePassedError(err: unknown): err is DeadlinePassedError {
  return err instanceof DeadlinePassedError;
}

export function isInsufficientBalanceError(err: unknown): err is InsufficientBalanceError {
  return err instanceof InsufficientBalanceError;
}

export function isPaymentExceedsRemainingError(err: unknown): err is PaymentExceedsRemainingError {
  return err instanceof PaymentExceedsRemainingError;
}

export function isInvoiceFrozenError(err: unknown): err is InvoiceFrozenError {
  return err instanceof InvoiceFrozenError;
}

export function isCoCreatorApprovalNotRequiredError(
  err: unknown
): err is CoCreatorApprovalNotRequiredError {
  return err instanceof CoCreatorApprovalNotRequiredError;
}

export function isValidationError(err: unknown): err is ValidationError {
  return err instanceof ValidationError;
}

export function isNftGateRequiredError(err: unknown): err is NftGateRequiredError {
  return err instanceof NftGateRequiredError;
}

export function isWalletNotConnectedError(err: unknown): err is WalletNotConnectedError {
  return err instanceof WalletNotConnectedError;
}

export function isRpcError(err: unknown): err is RpcError {
  return err instanceof RpcError;
}

export function isContractError(err: unknown): err is ContractError {
  return err instanceof ContractError;
}

export function isForwardChainTooDeepError(err: unknown): err is ForwardChainTooDeepError {
  return err instanceof ForwardChainTooDeepError;
}

export function isChainTooDeepError(err: unknown): err is ChainTooDeepError {
  return err instanceof ChainTooDeepError;
}

export function isCircularPrerequisiteError(err: unknown): err is CircularPrerequisiteError {
  return err instanceof CircularPrerequisiteError;
}

export function isUnauthorizedError(err: unknown): err is UnauthorizedError {
  return err instanceof UnauthorizedError;
}

export function isCircuitOpenError(err: unknown): err is CircuitOpenError {
  return err instanceof CircuitOpenError;
}

export function isCircularForwardChainError(err: unknown): err is CircularForwardChainError {
  return err instanceof CircularForwardChainError;
}

export function isPluginAlreadyRegisteredError(err: unknown): err is PluginAlreadyRegisteredError {
  return err instanceof PluginAlreadyRegisteredError;
}

export function isInvalidBatchSizeError(err: unknown): err is InvalidBatchSizeError {
  return err instanceof InvalidBatchSizeError;
}

export function isInvoiceNotReleasedError(err: unknown): err is InvoiceNotReleasedError {
  return err instanceof InvoiceNotReleasedError;
}

export function isTransactionFailedError(err: unknown): err is TransactionFailedError {
  return err instanceof TransactionFailedError;
}

export function isTransactionNotConfirmedError(err: unknown): err is TransactionNotConfirmedError {
  return err instanceof TransactionNotConfirmedError;
}

export function isSimulationFailedError(err: unknown): err is SimulationFailedError {
  return err instanceof SimulationFailedError;
}

export function isNoReturnValueError(err: unknown): err is NoReturnValueError {
  return err instanceof NoReturnValueError;
}

export function isUnknownNetworkError(err: unknown): err is UnknownNetworkError {
  return err instanceof UnknownNetworkError;
}

export function isInsufficientSignaturesError(err: unknown): err is InsufficientSignaturesError {
  return err instanceof InsufficientSignaturesError;
}

export function isCloneChainTooDeepError(err: unknown): err is CloneChainTooDeepError {
  return err instanceof CloneChainTooDeepError;
}

export function isNoPendingPayoutError(err: unknown): err is NoPendingPayoutError {
  return err instanceof NoPendingPayoutError;
}

export function isInvalidAttestationError(err: unknown): err is InvalidAttestationError {
  return err instanceof InvalidAttestationError;
}

export function isInvoiceFlowFetcherNotRegisteredError(err: unknown): err is InvoiceFlowFetcherNotRegisteredError {
  return err instanceof InvoiceFlowFetcherNotRegisteredError;
}

export function isInvoiceFetcherNotRegisteredError(err: unknown): err is InvoiceFetcherNotRegisteredError {
  return err instanceof InvoiceFetcherNotRegisteredError;
}

export function isUnknownEndpointError(err: unknown): err is UnknownEndpointError {
  return err instanceof UnknownEndpointError;
}

export function isRpcUnavailableError(err: unknown): err is RpcUnavailableError {
  return err instanceof RpcUnavailableError;
}

export function isDiscoveryFetchError(err: unknown): err is DiscoveryFetchError {
  return err instanceof DiscoveryFetchError;
}

export function isPayerAddressRequiredError(err: unknown): err is PayerAddressRequiredError {
  return err instanceof PayerAddressRequiredError;
}

export function isSignerFailedError(err: unknown): err is SignerFailedError {
  return err instanceof SignerFailedError;
}

export function isNoSignerProvidedError(err: unknown): err is NoSignerProvidedError {
  return err instanceof NoSignerProvidedError;
}

export function isConnectionPoolConfigError(err: unknown): err is ConnectionPoolConfigError {
  return err instanceof ConnectionPoolConfigError;
}

export function isConnectionPoolDisposedError(err: unknown): err is ConnectionPoolDisposedError {
  return err instanceof ConnectionPoolDisposedError;
}

export function isSearchFailedError(err: unknown): err is SearchFailedError {
  return err instanceof SearchFailedError;
}

export function isTransactionNotSuccessfulError(err: unknown): err is TransactionNotSuccessfulError {
  return err instanceof TransactionNotSuccessfulError;
}

export function isQueueFailedError(err: unknown): err is QueueFailedError {
  return err instanceof QueueFailedError;
}

export function isUnknownExportFormatError(err: unknown): err is UnknownExportFormatError {
  return err instanceof UnknownExportFormatError;
}

export function isDexQuoteFailedError(err: unknown): err is DexQuoteFailedError {
  return err instanceof DexQuoteFailedError;
}

export function isTtlExtensionFailedError(err: unknown): err is TtlExtensionFailedError {
  return err instanceof TtlExtensionFailedError;
}

export function isTestHarnessNotInitializedError(err: unknown): err is TestHarnessNotInitializedError {
  return err instanceof TestHarnessNotInitializedError;
}

export function isUnknownTestWalletError(err: unknown): err is UnknownTestWalletError {
  return err instanceof UnknownTestWalletError;
}

export function isRelationshipTrackerNotInitializedError(err: unknown): err is RelationshipTrackerNotInitializedError {
  return err instanceof RelationshipTrackerNotInitializedError;
}

export function isFriendbotFailedError(err: unknown): err is FriendbotFailedError {
  return err instanceof FriendbotFailedError;
}

export function isDisputeEvidenceError(err: unknown): err is DisputeEvidenceError {
  return err instanceof DisputeEvidenceError;
}

export function isOraclePriceError(err: unknown): err is OraclePriceError {
  return err instanceof OraclePriceError;
}

export function isSep41AdapterError(err: unknown): err is Sep41AdapterError {
  return err instanceof Sep41AdapterError;
}

export function isTrancheProgressError(err: unknown): err is TrancheProgressError {
  return err instanceof TrancheProgressError;
}

export function isRefundGraceError(err: unknown): err is RefundGraceError {
  return err instanceof RefundGraceError;
}

export function isChannelReconciliationError(err: unknown): err is ChannelReconciliationError {
  return err instanceof ChannelReconciliationError;
}

/** Thrown when a request exceeds its configured timeout. */
export class RequestTimeoutError extends StellarSplitError {
  readonly method: string;
  readonly timeoutMs: number;

  constructor(method: string, timeoutMs: number) {
    super(
      `Request timed out after ${timeoutMs}ms (method: ${method})`,
      "REQUEST_TIMEOUT",
      { method, timeoutMs }
    );
    this.name = "RequestTimeoutError";
    this.method = method;
    this.timeoutMs = timeoutMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isRequestTimeoutError(err: unknown): err is RequestTimeoutError {
  return err instanceof RequestTimeoutError;
}

/** Thrown when too many concurrent invoice subscriptions are created. */
export class TooManySubscriptionsError extends StellarSplitError {
  constructor(maxSubscriptions: number = 10) {
    super(
      `Maximum concurrent subscriptions (${maxSubscriptions}) exceeded`,
      "TOO_MANY_SUBSCRIPTIONS",
      { maxSubscriptions }
    );
    this.name = "TooManySubscriptionsError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isTooManySubscriptionsError(err: unknown): err is TooManySubscriptionsError {
  return err instanceof TooManySubscriptionsError;
}

/**
 * Thrown when an admin operation is attempted without a valid authorized admin
 * keypair, or when the supplied keypair's public key does not match the
 * expected admin address.
 */
export class AdminOperationError extends StellarSplitError {
  /** The admin address that was checked. */
  readonly adminAddress: string;

  constructor(message: string, adminAddress: string) {
    super(message, "ADMIN_OPERATION_ERROR", { adminAddress }, message);
    this.name = "AdminOperationError";
    this.adminAddress = adminAddress;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isAdminOperationError(err: unknown): err is AdminOperationError {
  return err instanceof AdminOperationError;
}
