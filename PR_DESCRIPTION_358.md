# Typed Error Hierarchy for SDK Error Codes

This PR implements a comprehensive typed error hierarchy for the StellarSplit SDK, replacing generic `Error` objects with structured subclasses that enable callers to handle specific error cases programmatically.

## Summary

The SDK previously threw generic `Error` objects with string messages, requiring callers to use string matching for error handling. This PR introduces a `StellarSplitError` base class and 40+ specialized subclasses that cover all SDK error scenarios.

## Changes

### New Error Classes

**Base Class:**
- `StellarSplitError` - Base class extending `Error` with `code: string` and `context?: Record<string, unknown>` properties

**Invoice-Related Errors:**
- `InvoiceNotFoundError` - Invoice does not exist on-chain (`INVOICE_NOT_FOUND`)
- `InvoiceNotPendingError` - Invoice is not in Pending state (`INVOICE_NOT_PENDING`)
- `InvoiceNotReleasedError` - Invoice is not in Released status for receipt generation (`INVOICE_NOT_RELEASED`)
- `InvoiceFrozenError` - Invoice is frozen/disputed (`INVOICE_FROZEN`)
- `DeadlinePassedError` - Transaction attempted after deadline (`DEADLINE_PASSED`)
- `InsufficientBalanceError` - Payment exceeds remaining balance (`INSUFFICIENT_BALANCE`)

**Authorization & Validation Errors:**
- `UnauthorizedError` - Operation lacks proper authorization (`UNAUTHORIZED`)
- `ValidationError` - Input validation failure (`VALIDATION_ERROR`)
- `PluginAlreadyRegisteredError` - Duplicate plugin registration (`PLUGIN_ALREADY_REGISTERED`)
- `InvalidBatchSizeError` - Batch size validation failure (`INVALID_BATCH_SIZE`)
- `InvalidAttestationError` - Attestation parameter validation (`INVALID_ATTESTATION`)
- `ConfigValidationError` - Client configuration validation (`CONFIG_VALIDATION_ERROR`)

**RPC & Transaction Errors:**
- `RpcError` - RPC call failure (`RPC_ERROR`)
- `ContractError` - Contract simulation/transaction failure (`CONTRACT_ERROR`)
- `SimulationFailedError` - Transaction simulation failed (`SIMULATION_FAILED`)
- `NoReturnValueError` - No return value from contract call (`NO_RETURN_VALUE`)
- `TransactionFailedError` - Transaction submission failed (`TRANSACTION_FAILED`)
- `TransactionNotConfirmedError` - Transaction not confirmed after submission (`TRANSACTION_NOT_CONFIRMED`)
- `TransactionNotSuccessfulError` - Transaction did not succeed (`TRANSACTION_NOT_SUCCESSFUL`)

**Wallet & Connection Errors:**
- `WalletNotConnectedError` - Wallet not connected (`WALLET_NOT_CONNECTED`)
- `NoSignerProvidedError` - No signer provided for operation (`NO_SIGNER_PROVIDED`)
- `InsufficientSignaturesError` - Too few signatures collected (`INSUFFICIENT_SIGNATURES`)
- `SignerFailedError` - Signer failed to sign transaction (`SIGNER_FAILED`)
- `RpcUnavailableError` - RPC unavailable with no cached data (`RPC_UNAVAILABLE`)

**Chain & State Errors:**
- `ChainTooDeepError` - Prerequisite chain too deep (`CHAIN_TOO_DEEP`)
- `CircularPrerequisiteError` - Circular prerequisite chain detected (`CIRCULAR_PREREQUISITE`)
- `ForwardChainTooDeepError` - Forward chain too deep (`FORWARD_CHAIN_TOO_DEEP`)
- `CircularForwardChainError` - Circular forward chain detected (`CIRCULAR_FORWARD_CHAIN`)
- `CloneChainTooDeepError` - Clone chain cycle/depth exceeded (`CLONE_CHAIN_TOO_DEEP`)

**Infrastructure Errors:**
- `QueueFailedError` - Transaction queue has failed (`QUEUE_FAILED`)
- `CircuitOpenError` - Circuit breaker open (`CIRCUIT_OPEN`)
- `ConnectionPoolConfigError` - Connection pool misconfiguration (`CONNECTION_POOL_CONFIG_ERROR`)
- `ConnectionPoolDisposedError` - Connection pool disposed (`CONNECTION_POOL_DISPOSED`)
- `DiscoveryFetchError` - Discovery fetch failed (`DISCOVERY_FETCH_FAILED`)
- `UnknownEndpointError` - Unknown endpoint in load balancer (`UNKNOWN_ENDPOINT`)
- `UnknownNetworkError` - Unknown network specified (`UNKNOWN_NETWORK`)
- `NoPendingPayoutError` - No pending payout for recipient (`NO_PENDING_PAYOUT`)

**Specialized Errors:**
- `WebhookEventNotFoundError` - Webhook event not found in replay store (`WEBHOOK_EVENT_NOT_FOUND`)
- `InvoiceFetcherNotRegisteredError` - Invoice fetcher not registered (`INVOICE_FETCHER_NOT_REGISTERED`)
- `InvoiceFlowFetcherNotRegisteredError` - Invoice flow fetcher not registered (`FLOW_FETCHER_NOT_REGISTERED`)
- `QueueFailedError` - Queue has failed
- `SearchFailedError` - Search operation failed (`SEARCH_FAILED`)
- `UnknownExportFormatError` - Unknown export format (`UNKNOWN_EXPORT_FORMAT`)
- `DexQuoteFailedError` - DEX quote operation failed (`DEX_QUOTE_FAILED`)
- `TtlExtensionFailedError` - TTL extension operation failed (`TTL_EXTENSION_FAILED`)
- `TrancheProgressError` - Tranche status check failed (`TRANCHE_PROGRESS_ERROR`)
- `RefundGraceError` - Refund grace period error (`REFUND_GRACE_ERROR`)
- `DisputeEvidenceError` - Dispute evidence bundle error (`DISPUTE_EVIDENCE_ERROR`)
- `OraclePriceError` - Oracle price fetch failed (`ORACLE_PRICE_ERROR`)
- `Sep41AdapterError` - Sep41 adapter error (`SEP41_ADAPTER_ERROR`)
- `ChannelReconciliationError` - Channel reconciliation failed (`CHANNEL_RECONCILIATION_FAILED`)
- `TestHarnessNotInitializedError` - Test harness not initialized (`TEST_HARNESS_NOT_INITIALIZED`)
- `UnknownTestWalletError` - Unknown test wallet address (`UNKNOWN_TEST_WALLET`)
- `RelationshipTrackerNotInitializedError` - Relationship tracker not initialized (`RELATIONSHIP_TRACKER_NOT_INITIALIZED`)
- `FriendbotFailedError` - Friendbot request failed (`FRIENDBOT_FAILED`)

### Type Guard Helpers

All error classes have corresponding type guard functions exported:
- `isStellarSplitError(err)` - Check if error is any SDK error
- `isInvoiceNotFoundError(err)` - Check for invoice not found errors
- `isRpcError(err)` - Check for RPC errors
- `isContractError(err)` - Check for contract errors
- etc.

### Migration Guide

**Before (catching generic Error):**
```typescript
try {
  await client.getInvoice("123");
} catch (err) {
  if (err instanceof Error && err.message.includes("not found")) {
    // Handle invoice not found
  }
}
```

**After (using type guards):**
```typescript
import { isInvoiceNotFoundError, InvoiceNotFoundError } from "@stellar-split/sdk";

try {
  await client.getInvoice("123");
} catch (err) {
  if (isInvoiceNotFoundError(err)) {
    // err.invoiceId is typed as string
    console.log(`Invoice ${err.invoiceId} does not exist`);
  }
}
```

All error classes extend `StellarSplitError` which provides:
- `code: string` - Unique error identifier
- `context?: Record<string, unknown>` - Additional debugging info
- `raw?: string` - Original error string when available

## Files Modified

- `src/errors.ts` - Added all error classes and type guards
- `src/index.ts` - Updated exports to include all error classes
- `src/invoiceTemplate.ts` - Updated to use ValidationError from errors.ts
- `src/sponsorship.ts` - Updated to extend StellarSplitError
- `src/fallbackChain.ts` - Updated to extend StellarSplitError
- Multiple SDK modules - Replaced `throw new Error(...)` with typed errors

## Testing

All 66 existing tests pass with the new error types.

closes #358