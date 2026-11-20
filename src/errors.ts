/**
 * Typed error hierarchy for StellarSplit SDK.
 *
 * Maps known Soroban contract panic messages to structured subclasses
 * so callers can handle specific failure cases with instanceof checks.
 *
 * @example
 * ```ts
 * try {
 *   await client.pay(invoiceId, amount);
 * } catch (error) {
 *   if (error instanceof StellarSplitError) {
 *     console.error(error.code, error.context);
 *   }
 * }
 * ```
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
  /** Invoice identifier that could not be located. */
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
  /** Invoice identifier that is not currently pending. */
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
  /** Invoice identifier whose deadline has passed. */
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
  /** Invoice identifier being funded. */
  readonly invoiceId: string;
  /** Requested payment amount. */
  readonly amount: bigint;
  /** Remaining amount available to fund. */
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
  constructor(
    message: string,
    context?: Record<string, unknown>,
    code: string = "VALIDATION_ERROR"
  ) {
    super(message, code, context, message);
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

/**
 * Thrown by {@link DeployPipeline} when a WASM upload or contract
 * instantiation step keeps failing with `tx_bad_seq` after retrying with
 * a freshly-fetched sequence number.
 */
export class DeploySequenceError extends StellarSplitError {
  readonly step: string;
  readonly attempts: number;

  constructor(step: string, attempts: number) {
    super(
      `Deploy step "${step}" failed after ${attempts} sequence retries due to tx_bad_seq`,
      "DEPLOY_SEQUENCE_ERROR",
      { step, attempts }
    );
    this.name = "DeploySequenceError";
    this.step = step;
    this.attempts = attempts;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown by {@link WebhookAgent.deliver} when a webhook delivery has
 * exhausted its configured retry budget without a successful response.
 */
export class WebhookExhaustedError extends StellarSplitError {
  readonly url: string;
  readonly attempts: number;
  readonly lastError?: string;

  constructor(url: string, attempts: number, lastError?: string) {
    super(
      `Webhook delivery to ${url} failed after ${attempts} attempts${lastError ? `: ${lastError}` : ""}`,
      "WEBHOOK_EXHAUSTED",
      { url, attempts, lastError }
    );
    this.name = "WebhookExhaustedError";
    this.url = url;
    this.attempts = attempts;
    this.lastError = lastError;
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

/** Thrown when a queued contract invocation exhausts its retry attempts. */
export class ContractRetryExhaustedError extends StellarSplitError {
  readonly attempts: number;

  constructor(attempts: number, lastError: unknown) {
    super(
      `Contract invocation retry exhausted after ${attempts} attempts`,
      "CONTRACT_RETRY_EXHAUSTED",
      { attempts, lastError: lastError instanceof Error ? lastError.message : String(lastError) }
    );
    this.name = "ContractRetryExhaustedError";
    this.attempts = attempts;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a line item's asset has no oracle price available for normalisation. */
export class UnsupportedLineItemAssetError extends StellarSplitError {
  readonly asset: string;

  constructor(asset: string) {
    super(
      `No oracle price available for line item asset: ${asset}`,
      "UNSUPPORTED_LINE_ITEM_ASSET",
      { asset }
    );
    this.name = "UnsupportedLineItemAssetError";
    this.asset = asset;
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

/** Thrown when a preflight check fails before the SDK attempts contract calls. */
export class PreflightError extends StellarSplitError {
  /** The endpoint URL the failing check targeted. */
  readonly url: string;
  /** Human-readable reason the check failed. */
  readonly reason: string;

  constructor(url: string, reason: string) {
    super(`Preflight check failed for ${url}: ${reason}`, "PREFLIGHT_ERROR", { url, reason });
    this.name = "PreflightError";
    this.url = url;
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
    pattern: /deadline.*passed|expired|past.*dead