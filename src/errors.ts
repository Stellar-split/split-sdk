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

/** Thrown when submitting a WaterfallPlan with an unsatisfied tier and `allowPartial` was not set. */
export class WaterfallInsufficientFundsError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string, context?: Record<string, unknown>) {
    super(
      `Waterfall plan for invoice ${invoiceId} has one or more unsatisfied tiers; pass allowPartial: true to submit anyway`,
      "WATERFALL_INSUFFICIENT_FUNDS",
      { invoiceId, ...context },
    );
    this.name = "WaterfallInsufficientFundsError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isWaterfallInsufficientFundsError(err: unknown): err is WaterfallInsufficientFundsError {
  return err instanceof WaterfallInsufficientFundsError;
}

// ---------------------------------------------------------------------------
// #476 OperationBuilder errors
// ---------------------------------------------------------------------------

/**
 * Thrown when an operation envelope exceeds the maximum number of operations
 * (100) or the maximum base fee (10_000_000 stroops).
 */
export class EnvelopeLimitError extends StellarSplitError {
  readonly operationCount: number;
  readonly limit: number;

  constructor(operationCount: number, limit: number, raw?: string) {
    super(
      `Envelope exceeds limit: ${operationCount} operations (max ${limit})`,
      "ENVELOPE_LIMIT",
      { operationCount, limit },
      raw,
    );
    this.name = "EnvelopeLimitError";
    this.operationCount = operationCount;
    this.limit = limit;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isEnvelopeLimitError(err: unknown): err is EnvelopeLimitError {
  return err instanceof EnvelopeLimitError;
}

/**
 * Thrown when `.submit()` is called but the prior `.dryRun()` simulation
 * returned an error field from the RPC.
 */
export class DryRunFailedError extends StellarSplitError {
  readonly simulationError: string;

  constructor(simulationError: string, raw?: string) {
    super(
      `Dry-run simulation failed: ${simulationError}`,
      "DRY_RUN_FAILED",
      { simulationError },
      raw,
    );
    this.name = "DryRunFailedError";
    this.simulationError = simulationError;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isDryRunFailedError(err: unknown): err is DryRunFailedError {
  return err instanceof DryRunFailedError;
}

// ---------------------------------------------------------------------------
// #477 AccountSignerWeightCalculator errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the provided signing keys do not meet the required threshold
 * weight for a Stellar multi-sig account.
 */
export class InsufficientSignerWeightError extends StellarSplitError {
  readonly provided: string[];
  readonly totalWeight: number;
  readonly required: number;

  constructor(
    provided: string[],
    totalWeight: number,
    required: number,
    raw?: string,
  ) {
    super(
      `Insufficient signer weight: ${totalWeight} < ${required} (required)`,
      "INSUFFICIENT_SIGNER_WEIGHT",
      { provided, totalWeight, required },
      raw,
    );
    this.name = "InsufficientSignerWeightError";
    this.provided = provided;
    this.totalWeight = totalWeight;
    this.required = required;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isInsufficientSignerWeightError(err: unknown): err is InsufficientSignerWeightError {
  return err instanceof InsufficientSignerWeightError;
}

// ---------------------------------------------------------------------------
// #478 PaymentDeduplicationFingerprinter errors
// ---------------------------------------------------------------------------

/**
 * Thrown when a payment fingerprint matches a recently submitted payment
 * within the configured deduplication window.
 */
export class DuplicatePaymentError extends StellarSplitError {
  readonly fingerprint: string;
  readonly existingTxHash: string;
  readonly submittedAt: number;

  constructor(fingerprint: string, existingTxHash: string, submittedAt: number, raw?: string) {
    super(
      `Duplicate payment detected (fingerprint: ${fingerprint}, existing tx: ${existingTxHash})`,
      "DUPLICATE_PAYMENT",
      { fingerprint, existingTxHash, submittedAt },
      raw,
    );
    this.name = "DuplicatePaymentError";
    this.fingerprint = fingerprint;
    this.existingTxHash = existingTxHash;
    this.submittedAt = submittedAt;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isDuplicatePaymentError(err: unknown): err is DuplicatePaymentError {
  return err instanceof DuplicatePaymentError;
}

// ---------------------------------------------------------------------------
// #479 LazyInitializer errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the lazy RPC connection factory fails to connect.
 * All pending method calls awaiting initialization receive this error.
 * A retry after failure will re-attempt initialization.
 */
export class RpcConnectionError extends StellarSplitError {
  readonly url: string;

  constructor(url: string, cause?: string, raw?: string) {
    super(
      `RPC connection failed for ${url}${cause ? `: ${cause}` : ""}`,
      "RPC_CONNECTION_ERROR",
      { url, cause },
      raw,
    );
    this.name = "RpcConnectionError";
    this.url = url;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isRpcConnectionError(err: unknown): err is RpcConnectionError {
  return err instanceof RpcConnectionError;
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

/** Thrown when a new write request is attempted during graceful shutdown. */
export class ShutdownInProgressError extends StellarSplitError {
  constructor(message: string = "SDK shutdown is in progress; new transaction submissions are disabled") {
    super(message, "SHUTDOWN_IN_PROGRESS");
    this.name = "ShutdownInProgressError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isShutdownInProgressError(err: unknown): err is ShutdownInProgressError {
  return err instanceof ShutdownInProgressError;
}

/** Thrown when graceful shutdown times out while requests are still pending. */
export class GracefulShutdownTimeoutError extends StellarSplitError {
  readonly signal: string;
  readonly timeoutMs: number;
  readonly pendingRequests: Array<{ id: string; method: string; startedAt: number }>;

  constructor(
    signal: string,
    timeoutMs: number,
    pendingRequests: Array<{ id: string; method: string; startedAt: number }>,
  ) {
    super(
      `Graceful shutdown timed out after ${timeoutMs}ms while handling ${signal}`,
      "GRACEFUL_SHUTDOWN_TIMEOUT",
      {
        signal,
        timeoutMs,
        pendingRequests,
      },
    );
    this.name = "GracefulShutdownTimeoutError";
    this.signal = signal;
    this.timeoutMs = timeoutMs;
    this.pendingRequests = pendingRequests;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isGracefulShutdownTimeoutError(
  err: unknown,
): err is GracefulShutdownTimeoutError {
  return err instanceof GracefulShutdownTimeoutError;
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

// ---------------------------------------------------------------------------
// Confidential Payment Errors (Pedersen Commitments)
// ---------------------------------------------------------------------------

/** Thrown when Pedersen commitment generation fails. */
export class CommitmentGenerationError extends StellarSplitError {
  constructor(message: string) {
    super(message, "COMMITMENT_GENERATION_ERROR", undefined, message);
    this.name = "CommitmentGenerationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isCommitmentGenerationError(err: unknown): err is CommitmentGenerationError {
  return err instanceof CommitmentGenerationError;
}

/** Thrown when blinding factor storage operation fails. */
export class BlindingFactorStorageError extends StellarSplitError {
  readonly invoiceId?: string;

  constructor(message: string, invoiceId?: string) {
    super(message, "BLINDING_FACTOR_STORAGE_ERROR", { invoiceId }, message);
    this.name = "BlindingFactorStorageError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isBlindingFactorStorageError(err: unknown): err is BlindingFactorStorageError {
  return err instanceof BlindingFactorStorageError;
}

/** Thrown when blinding factor is not found for an invoice. */
export class BlindingFactorNotFoundError extends StellarSplitError {
  readonly invoiceId: string;

  constructor(invoiceId: string) {
    super(
      `Blinding factor not found for invoice: ${invoiceId}`,
      "BLINDING_FACTOR_NOT_FOUND",
      { invoiceId }
    );
    this.name = "BlindingFactorNotFoundError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isBlindingFactorNotFoundError(err: unknown): err is BlindingFactorNotFoundError {
  return err instanceof BlindingFactorNotFoundError;
}

/** Thrown when blinding factor decryption fails. */
export class BlindingFactorDecryptionError extends StellarSplitError {
  readonly invoiceId?: string;

  constructor(message: string, invoiceId?: string) {
    super(message, "BLINDING_FACTOR_DECRYPTION_ERROR", { invoiceId }, message);
    this.name = "BlindingFactorDecryptionError";
    this.invoiceId = invoiceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isBlindingFactorDecryptionError(err: unknown): err is BlindingFactorDecryptionError {
  return err instanceof BlindingFactorDecryptionError;
}

// ---------------------------------------------------------------------------
// IPFS-related errors
// ---------------------------------------------------------------------------

/** Thrown when IPFS pinning operation fails. */
export class IPFSPinError extends StellarSplitError {
  readonly url?: string;

  constructor(message: string, url?: string) {
    super(message, "IPFS_PIN_ERROR", { url }, message);
    this.name = "IPFSPinError";
    this.url = url;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isIPFSPinError(err: unknown): err is IPFSPinError {
  return err instanceof IPFSPinError;
}

/** Thrown when IPFS content fetch fails. */
export class IPFSFetchError extends StellarSplitError {
  readonly cid: string;

  constructor(message: string, cid: string) {
    super(message, "IPFS_FETCH_ERROR", { cid }, message);
    this.name = "IPFSFetchError";
    this.cid = cid;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isIPFSFetchError(err: unknown): err is IPFSFetchError {
  return err instanceof IPFSFetchError;
}

/** Thrown when CID verification detects tampered or mismatched content. */
export class CIDMismatchError extends StellarSplitError {
  readonly expectedCID: string;
  readonly computedCID?: string;

  constructor(expectedCID: string, computedCID?: string) {
    const msg = computedCID
      ? `CID mismatch: expected ${expectedCID}, got ${computedCID}`
      : `CID mismatch: content does not match ${expectedCID}`;
    super(msg, "CID_MISMATCH", { expectedCID, computedCID }, msg);
    this.name = "CIDMismatchError";
    this.expectedCID = expectedCID;
    this.computedCID = computedCID;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isCIDMismatchError(err: unknown): err is CIDMismatchError {
  return err instanceof CIDMismatchError;
}

/** Thrown when IPFS configuration is invalid or missing. */
export class IPFSConfigError extends StellarSplitError {
  constructor(message: string) {
    super(message, "IPFS_CONFIG_ERROR", undefined, message);
    this.name = "IPFSConfigError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class PassphraseMismatchError extends StellarSplitError {
  constructor(configured: string, reported: string) {
    super(
      `Network Passphrase Mismatch: Configured [${configured}] but RPC node reported [${reported}].`,
      "PASSPHRASE_MISMATCH",
      { configured, reported }
    );
    this.name = "PassphraseMismatchError";
  }
}

// ---------------------------------------------------------------------------
// Sequence cache errors
// ---------------------------------------------------------------------------

/** Thrown when the sequence cache fails to fetch an account from Horizon. */
export class SequenceCacheError extends StellarSplitError {
  readonly accountId: string;

  constructor(message: string, accountId: string) {
    super(message, "SEQUENCE_CACHE_ERROR", { accountId }, message);
    this.name = "SequenceCacheError";
    this.accountId = accountId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isSequenceCacheError(err: unknown): err is SequenceCacheError {
  return err instanceof SequenceCacheError;
}

/** Thrown when a SEQUENCE_NUMBER_TOO_OLD error is detected at submission time. */
export class SequenceNumberTooOldError extends StellarSplitError {
  readonly accountId: string;
  readonly cachedSequence: bigint;

  constructor(accountId: string, cachedSequence: bigint) {
    super(
      `Sequence number too old for ${accountId} (cached: ${cachedSequence})`,
      "SEQUENCE_NUMBER_TOO_OLD",
      { accountId, cachedSequence: cachedSequence.toString() },
    );
    this.name = "SequenceNumberTooOldError";
    this.accountId = accountId;
    this.cachedSequence = cachedSequence;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isSequenceNumberTooOldError(err: unknown): err is SequenceNumberTooOldError {
  return err instanceof SequenceNumberTooOldError;
}

// ---------------------------------------------------------------------------
// Path router errors
// ---------------------------------------------------------------------------

/** Thrown when no DEX path could be found between two assets. */
export class PathNotFoundError extends StellarSplitError {
  readonly sourceAsset: string;
  readonly destAsset: string;
  readonly amount: bigint;

  constructor(sourceAsset: string, destAsset: string, amount: bigint) {
    super(
      `No DEX path found from ${sourceAsset} to ${destAsset} for amount ${amount}`,
      "PATH_NOT_FOUND",
      { sourceAsset, destAsset, amount: amount.toString() },
    );
    this.name = "PathNotFoundError";
    this.sourceAsset = sourceAsset;
    this.destAsset = destAsset;
    this.amount = amount;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isPathNotFoundError(err: unknown): err is PathNotFoundError {
  return err instanceof PathNotFoundError;
}

/** Thrown when the path router encounters an unexpected error. */
export class PathRouterError extends StellarSplitError {
  constructor(message: string) {
    super(message, "PATH_ROUTER_ERROR", undefined, message);
    this.name = "PathRouterError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isPathRouterError(err: unknown): err is PathRouterError {
  return err instanceof PathRouterError;
}

// ---------------------------------------------------------------------------
// Offer tracker errors
// ---------------------------------------------------------------------------

/** Thrown when offer tracking or cancellation fails. */
export class OfferTrackingError extends StellarSplitError {
  constructor(message: string) {
    super(message, "OFFER_TRACKING_ERROR", undefined, message);
    this.name = "OfferTrackingError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isOfferTrackingError(err: unknown): err is OfferTrackingError {
  return err instanceof OfferTrackingError;
}

// ---------------------------------------------------------------------------
// Claimable balance lifecycle errors
// ---------------------------------------------------------------------------

/** Thrown when claimable balance lifecycle operations fail. */
export class ClaimableBalanceLifecycleError extends StellarSplitError {
  readonly balanceId: string;

  constructor(message: string, balanceId: string) {
    super(message, "CLAIMABLE_BALANCE_LIFECYCLE_ERROR", { balanceId }, message);
    this.name = "ClaimableBalanceLifecycleError";
    this.balanceId = balanceId;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isClaimableBalanceLifecycleError(err: unknown): err is ClaimableBalanceLifecycleError {
  return err instanceof ClaimableBalanceLifecycleError;
}

export function isIPFSConfigError(err: unknown): err is IPFSConfigError {
  return err instanceof IPFSConfigError;
}

// ---------------------------------------------------------------------------
// AMM Calculator errors
// ---------------------------------------------------------------------------

/**
 * Thrown when swap input exceeds a configurable ratio of pool reserves,
 * or when pool reserves are zero / insufficient.
 */
export class InsufficientLiquidityError extends StellarSplitError {
  readonly reserveAmount: string;
  readonly inputAmount: string;

  constructor(message: string, reserveAmount: string, inputAmount: string) {
    super(message, "INSUFFICIENT_LIQUIDITY", { reserveAmount, inputAmount }, message);
    this.name = "InsufficientLiquidityError";
    this.reserveAmount = reserveAmount;
    this.inputAmount = inputAmount;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isInsufficientLiquidityError(err: unknown): err is InsufficientLiquidityError {
  return err instanceof InsufficientLiquidityError;
}

// ---------------------------------------------------------------------------
// Timeout Escalation errors
// ---------------------------------------------------------------------------

/**
 * Thrown when the `abort` escalation step fires, cancelling the payment.
 */
export class PaymentEscalationAbortError extends StellarSplitError {
  readonly invoiceId: string;
  readonly remainingMs: number;

  constructor(invoiceId: string, remainingMs: number) {
    super(
      `Payment escalation aborted for invoice ${invoiceId} with ${remainingMs}ms remaining`,
      "PAYMENT_ESCALATION_ABORT",
      { invoiceId, remainingMs }
    );
    this.name = "PaymentEscalationAbortError";
    this.invoiceId = invoiceId;
    this.remainingMs = remainingMs;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isPaymentEscalationAbortError(err: unknown): err is PaymentEscalationAbortError {
  return err instanceof PaymentEscalationAbortError;
}

// ---------------------------------------------------------------------------
// Recipient Deduplicator errors
// ---------------------------------------------------------------------------

/**
 * Thrown when duplicate recipient account IDs are detected in `reject` mode.
 */
export class DuplicateRecipientError extends StellarSplitError {
  readonly duplicateAddresses: string[];

  constructor(duplicateAddresses: string[]) {
    super(
      `Duplicate recipient addresses detected: ${duplicateAddresses.join(", ")}`,
      "DUPLICATE_RECIPIENT",
      { duplicateAddresses }
    );
    this.name = "DuplicateRecipientError";
    this.duplicateAddresses = duplicateAddresses;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isDuplicateRecipientError(err: unknown): err is DuplicateRecipientError {
  return err instanceof DuplicateRecipientError;
}

// ---------------------------------------------------------------------------
// Horizon Error Classification Types
// ---------------------------------------------------------------------------

/** Structured classification of a Horizon transaction/operation result code. */
export interface HorizonErrorClassification {
  /** The primary result code string. */
  code: string;
  /** Whether the error is safe to retry. */
  isRetryable: boolean;
  /** Severity level of the error. */
  severity: "low" | "medium" | "high" | "critical" | "unknown";
  /** Human-readable description of what went wrong. */
  description: string;
  /** Recommended action for the caller to take. */
  suggestedAction: string;
  /** The specific operation result code, if available. */
  operationCode?: string;
}

/**
 * Wraps a classified Horizon error with the structured classification.
 */
export class ClassifiedHorizonError extends StellarSplitError {
  readonly classification: HorizonErrorClassification;

  constructor(
    message: string,
    classification: HorizonErrorClassification
  ) {
    super(message, "CLASSIFIED_HORIZON_ERROR", { classification });
    this.name = "ClassifiedHorizonError";
    this.classification = classification;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isClassifiedHorizonError(err: unknown): err is ClassifiedHorizonError {
  return err instanceof ClassifiedHorizonError;
}

// ---------------------------------------------------------------------------
// Account freeze / lock state errors
// ---------------------------------------------------------------------------

/** Thrown when a payment targets an account whose trustline has been frozen by the issuer. */
export class AccountFrozenError extends StellarSplitError {
  readonly accountId: string;
  readonly assetCode: string;

  constructor(accountId: string, assetCode: string) {
    super(
      `Account ${accountId} has a frozen trustline for ${assetCode}`,
      "ACCOUNT_FROZEN",
      { accountId, assetCode },
    );
    this.name = "AccountFrozenError";
    this.accountId = accountId;
    this.assetCode = assetCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isAccountFrozenError(err: unknown): err is AccountFrozenError {
  return err instanceof AccountFrozenError;
}

/** Thrown when a payment targets an account that can never be authorized again for the asset (`AUTH_IMMUTABLE`). */
export class AccountLockedError extends StellarSplitError {
  readonly accountId: string;
  readonly assetCode: string;

  constructor(accountId: string, assetCode: string) {
    super(
      `Account ${accountId} is permanently locked out of authorization for ${assetCode}`,
      "ACCOUNT_LOCKED",
      { accountId, assetCode },
    );
    this.name = "AccountLockedError";
    this.accountId = accountId;
    this.assetCode = assetCode;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export function isAccountLockedError(err: unknown): err is AccountLockedError {
  return err instanceof AccountLockedError;
}
