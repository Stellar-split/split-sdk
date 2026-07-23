# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Chores

- Upgrade SDK to TypeScript strict mode (`strict`, `noImplicitAny`, `strictNullChecks`, `strictFunctionTypes`) and enable `noUncheckedIndexedAccess` for safer type-checking for SDK consumers.

### Features


- **Build invoice diff utility — compare two invoice states (closes #363)**
  - `diffInvoices(a: Invoice, b: Invoice)` returns structured diff of two invoice objects
  - Returns `InvoiceDiff` as `{ field: string, before: unknown, after: unknown }[]` — only changed fields listed
  - Handles nested objects (recipients list, split rules) and arrays (payment history)
  - BigInt fields compared numerically, not by reference
  - `hasDiff(a, b)` convenience function returns boolean
  - Pure functions with no RPC calls or side effects
  - Full TypeScript types exported: `InvoiceDiff`, `InvoiceDiffEntry`
  - Useful for cache invalidation, change tracking, and reconciliation
  - Complete documentation in `docs/INVOICE_DIFF.md`
- **Add SDK telemetry hooks for error and performance monitoring (closes #362)**
  - `client.setTelemetryHooks({ onError, onCallStart, onCallEnd })` accepts hook functions
  - `onError(err: StellarSplitError, context)` called on every SDK error before it's thrown
  - `onCallStart({ method, args, timestamp })` called before each RPC call
  - `onCallEnd({ method, durationMs, success, error? })` called after each RPC call
  - Hooks are fire-and-forget — hook exceptions do not propagate to SDK callers
  - `client.clearTelemetryHooks()` removes all registered hooks
  - TypeScript types for all hook signatures exported from the package root: `TelemetryHooks`, `TelemetryErrorContext`, `TelemetryCallStartParams`, `TelemetryCallEndParams`
  - Enables integration with Sentry, Datadog, or custom monitoring solutions without SDK dependencies
  - Zero performance overhead when hooks are not configured
  - Full documentation in `docs/TELEMETRY_HOOKS.md`
  - Example integrations in `examples/telemetry-hooks-example.ts`
- Add SDK event subscription via polling with exponential backoff (closes #359)
  - `subscribeToInvoice(invoiceId, handler, intervalMs)` polls contract for events
  - Polls every 5 seconds initially; backs off to 30 seconds after 3 unchanged polls
  - Resets to 5 seconds immediately when a change is detected
  - Handler receives `InvoiceEvent[]` containing only events since the last poll
  - Polling pauses when `document.hidden` is true (Page Visibility API); resumes on focus
  - Works in Node.js environments (no document dependency unless available)
  - Maximum 10 concurrent subscriptions; 11th throws `TooManySubscriptionsError`
- Add typed error hierarchy for SDK error codes (closes #358)
  - Base class `StellarSplitError` with `code: string` and `context?: Record<string, unknown>` properties
  - Error subclasses: `InvoiceNotFoundError`, `DeadlinePassedError`, `InsufficientBalanceError`, `WalletNotConnectedError`, `RpcError`, `ContractError`, `ValidationError`, `InvoiceNotPendingError`, `InvoiceFrozenError`, `CoCreatorApprovalNotRequiredError`, `ChainTooDeepError`, `CircularPrerequisiteError`, `ForwardChainTooDeepError`, `UnauthorizedError`, `CircularForwardChainError`, `CircuitOpenError`, `WebhookEventNotFoundError`, `PluginAlreadyRegisteredError`, `InvalidBatchSizeError`, `InvoiceNotReleasedError`, `TransactionFailedError`, `TransactionNotConfirmedError`, `SimulationFailedError`, `NoReturnValueError`, `UnknownNetworkError`, `InsufficientSignaturesError`, `CloneChainTooDeepError`, `NoPendingPayoutError`, `InvalidAttestationError`, `InvoiceFlowFetcherNotRegisteredError`, `InvoiceFetcherNotRegisteredError`, `UnknownEndpointError`, `RpcUnavailableError`, `DiscoveryFetchError`, `PayerAddressRequiredError`, `SignerFailedError`, `NoSignerProvidedError`, `ConnectionPoolConfigError`, `ConnectionPoolDisposedError`, `SearchFailedError`, `TransactionNotSuccessfulError`, `QueueFailedError`, `UnknownExportFormatError`, `DexQuoteFailedError`, `TtlExtensionFailedError`, `TestHarnessNotInitializedError`, `UnknownTestWalletError`, `RelationshipTrackerNotInitializedError`, `FriendbotFailedError`, `DisputeEvidenceError`, `OraclePriceError`, `Sep41AdapterError`, `TrancheProgressError`, `RefundGraceError`, `ChannelReconciliationError`
  - All `StellarSplitError` subclasses extend from a single base class for unified error handling
  - All errors are now human-readable without needing to check the code field
  - All error classes and type guards are exported from the package root
- add request deduplication for getInvoice() (`b09519a`)
- Add multi-network support (`ec092ca`)
- Build Soroban event replayer (`d8ba854`)
- Add invoice export formatter (`e1887d6`)
- Implement transaction queue (`464f3ff`)
- Build full TypeScript declaration file (`b477dac`)
- Add vesting schedule calculator (`dc152e8`)
- Implement group invoice management (`0fea394`)
- Build invoice search client (`8423d76`)
- Add contract upgrade detection (`10e2bb3`)
- Add SDK telemetry module (`f88c6d0`)
- Add batch invoice creation (`b45eb0c`)
- Add optimistic update helpers (`15fad20`)
- Implement recurring invoice management (`e8d74fe`)
- Add RPC health checker (`49b16f0`)
- Build invoice template client methods (`af14e4f`)
- Add USDC balance poller (`65fbb92`)
- Add StellarSplitClient, Freighter wallet adapter, and public index (`3e4ad8e`)
- Add Invoice/Payment/Recipient types and USDC amount utilities (`012b9a2`)

### Migration Guide: Typed Error Hierarchy

The SDK now throws typed error classes instead of generic `Error` objects. Update your error handling as follows:

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
  } else if (err instanceof InvoiceNotFoundError) {
    // Alternative: use instanceof check
  }
}
```

**Available error classes and codes:**

| Error Class | Code | Context Fields |
|------------|------|--------------|
| `InvoiceNotFoundError` | `INVOICE_NOT_FOUND` | `invoiceId` |
| `InvoiceNotPendingError` | `INVOICE_NOT_PENDING` | `invoiceId` |
| `DeadlinePassedError` | `DEADLINE_PASSED` | `invoiceId` |
| `InsufficientBalanceError` | `INSUFFICIENT_BALANCE` | `invoiceId`, `amount`, `remaining` |
| `InvoiceFrozenError` | `INVOICE_FROZEN` | `invoiceId` |
| `CoCreatorApprovalNotRequiredError` | `CO_CREATOR_APPROVAL_NOT_REQUIRED` | `invoiceId` |
| `ChainTooDeepError` | `CHAIN_TOO_DEEP` | `maxDepth` |
| `CircularPrerequisiteError` | `CIRCULAR_PREREQUISITE` | `invoiceId` |
| `ForwardChainTooDeepError` | `FORWARD_CHAIN_TOO_DEEP` | `depth`, `invoiceId` |
| `CircularForwardChainError` | `CIRCULAR_FORWARD_CHAIN` | `invoiceId` |
| `UnauthorizedError` | `UNAUTHORIZED` | - |
| `NftGateRequiredError` | `NFT_GATE_REQUIRED` | `creatorAddress`, `nftContractAddress` |
| `WalletNotConnectedError` | `WALLET_NOT_CONNECTED` | - |
| `RpcError` | `RPC_ERROR` | `statusCode`, `url` |
| `ContractError` | `CONTRACT_ERROR` | `method`, `errorCode` |
| `ValidationError` | `VALIDATION_ERROR` | - |
| `ConfigValidationError` | `CONFIG_VALIDATION_ERROR` | `validationErrors[]` |
| `WebhookEventNotFoundError` | `WEBHOOK_EVENT_NOT_FOUND` | `eventId` |
| `PollerNotInitializedError` | `POLLER_NOT_INITIALIZED` | `action` |
| `CircuitOpenError` | `CIRCUIT_OPEN` | - |

**Type guards available:**
- `isStellarSplitError(err)` - checks if error is any SDK error
- `isInvoiceNotFoundError(err)`, `isDeadlinePassedError(err)`, `isInsufficientBalanceError(err)`, etc. - checks specific error types
- All type guards follow the pattern `is${ErrorClassName}(err)` for each error class

All errors extend `StellarSplitError` which has:
- `code: string` - unique error identifier
- `context?: Record<string, unknown>` - additional debugging info
- `raw?: string` - original error string when available

### Bug Fixes

- update to freighter-api v3 getAddress, stellar-sdk rpc namespace, and address regex (`69ce017`)

### Chores

- add .gitignore (`f4852ec`)
- add vitest unit tests, npm publish workflow, and CONTRIBUTING guide (`27ad223`)
- init @stellar-split/sdk package with tsup build and MIT license (`0f77a54`)