# Error Code Reference Guide

This document is the comprehensive reference guide for all error codes, causes, recovery actions, and error-handling patterns in the StellarSplit SDK.

---

## Table of Contents

1. [Error Handling Architecture](#1-error-handling-architecture)
2. [Master Error Code Index](#2-master-error-code-index)
3. [Invoice Lifecycle Errors](#3-invoice-lifecycle-errors)
4. [Payment & Settlement Errors](#4-payment--settlement-errors)
5. [Network, RPC & Submission Errors](#5-network-rpc--submission-errors)
6. [Authorization & Access Control Errors](#6-authorization--access-control-errors)
7. [Dispute & Governance Errors](#7-dispute--governance-errors)
8. [Milestones, Rounds & Referrals Errors](#8-milestones-rounds--referrals-errors)
9. [Validation & Batch Errors](#9-validation--batch-errors)
10. [Recommended Error Handling Patterns](#10-recommended-error-handling-patterns)
11. [Additional Error Codes (Lookup)](#11-additional-error-codes-lookup)

---

## 1. Error Handling Architecture

All typed errors thrown by the SDK extend `StellarSplitError` (which extends the JavaScript `Error` class).

```typescript
export class StellarSplitError extends Error {
  readonly code: string;                     // Unique programmatic error code
  readonly context?: Record<string, unknown>; // Diagnostic metadata (IDs, amounts, etc.)
  readonly raw?: string;                     // Raw panic message from Soroban RPC
}
```

### Key Error Handling Capabilities
- **`instanceof` discrimination**: Catch specific error classes cleanly without string parsing.
- **`isRetryable(error)`**: Synchronous helper returning `true` for transient network/RPC glitches or cooldown windows, and `false` for terminal business logic errors.
- **Type Guard functions**: Every error class provides a companion type guard function (e.g. `isInvoiceNotFoundError(err)`).

---

## 2. Master Error Code Index

| Error Code | Error Class | Retryable? | Domain |
| :--- | :--- | :--- | :--- |
| `INVOICE_NOT_FOUND` | `InvoiceNotFoundError` | No | Invoice |
| `INVOICE_NOT_PENDING` | `InvoiceNotPendingError` | No | Invoice |
| `DEADLINE_PASSED` | `DeadlinePassedError` | No | Invoice |
| `INVOICE_EXPIRED` | `InvoiceExpiredError` | No | Invoice |
| `INVOICE_FROZEN` | `InvoiceFrozenError` | No | Invoice / Admin |
| `INVOICE_FULLY_FUNDED` | `InvoiceFullyFundedError` | No | Invoice / Payment |
| `INVOICE_NOT_RELEASED` | `InvoiceNotReleasedError` | No | Invoice |
| `INVOICE_NOT_CLONEABLE` | `InvoiceNotCloneableError` | No | Invoice |
| `CLONE_CHAIN_TOO_DEEP` | `CloneChainTooDeepError` | No | Invoice |
| `DELEGATE_LIMIT_REACHED` | `DelegateLimitReachedError` | No | Invoice |
| `INVALID_TRANSITION` | `InvalidTransitionError` | No | State Machine |
| `INSUFFICIENT_BALANCE` | `InsufficientBalanceError` | No | Payment |
| `PAYMENT_EXCEEDS_REMAINING` | `PaymentExceedsRemainingError` | No | Payment |
| `DUPLICATE_PAYMENT` | `DuplicatePaymentError` | No | Payment |
| `PAYMENT_EXPIRED` | `PaymentExpiredError` | No | Payment |
| `PAYMENT_COOLDOWN_ACTIVE` | `PaymentCooldownActiveError` | **Yes** | Payment |
| `CONTRIBUTION_CAP_EXCEEDED` | `ContributionCapExceededError` | No | Payment |
| `NO_PENDING_PAYOUT` | `NoPendingPayoutError` | No | Payment |
| `INSUFFICIENT_LIQUIDITY` | `InsufficientLiquidityError` | No | Liquidity Pool |
| `WATERFALL_INSUFFICIENT_FUNDS` | `WaterfallInsufficientFundsError` | No | Payment |
| `RPC_ERROR` | `RpcError` | **Yes** (429/503) | Network & RPC |
| `RPC_UNAVAILABLE` | `RpcUnavailableError` | **Yes** | Network & RPC |
| `RPC_CONNECTION_ERROR` | `RpcConnectionError` | **Yes** | Network & RPC |
| `REQUEST_TIMEOUT` | `RequestTimeoutError` | **Yes** | Network & RPC |
| `CIRCUIT_OPEN` | `CircuitOpenError` | **Yes** | Network & RPC |
| `TRANSACTION_FAILED` | `TransactionFailedError` | No | Submission |
| `TRANSACTION_NOT_CONFIRMED` | `TransactionNotConfirmedError` | **Yes** | Submission |
| `SIMULATION_FAILED` | `SimulationFailedError` | No | Simulation |
| `PASSPHRASE_MISMATCH` | `PassphraseMismatchError` | No | Network Config |
| `NETWORK_MISMATCH` | `NetworkMismatchError` | No | Network Config |
| `UNAUTHORIZED` | `UnauthorizedError` | No | Auth & Access |
| `WALLET_NOT_CONNECTED` | `WalletNotConnectedError` | No | Wallet |
| `INSUFFICIENT_SIGNATURES` | `InsufficientSignaturesError` | No | Multi-sig |
| `INSUFFICIENT_SIGNER_WEIGHT` | `InsufficientSignerWeightError` | No | Multi-sig |
| `NFT_GATE_REQUIRED` | `NftGateRequiredError` | No | Access Control |
| `TOKEN_GATE_ACCESS_DENIED` | `TokenGateAccessDeniedError` | No | Access Control |
| `PAYER_NOT_WHITELISTED` | `PayerNotWhitelistedError` | No | Access Control |
| `CONTRACT_FROZEN` | `ContractFrozenError` | No | Contract |
| `ADMIN_OPERATION_ERROR` | `AdminOperationError` | No | Admin |
| `DISPUTE_EVIDENCE_ERROR` | `DisputeEvidenceError` | No | Dispute |
| `CO_CREATOR_APPROVAL_NOT_REQUIRED` | `CoCreatorApprovalNotRequiredError` | No | Multi-party |
| `ROUND_NOT_ENDED` | `RoundNotEndedError` | No | Rounds |
| `WRONG_MILESTONE` | `WrongMilestoneError` | No | Milestones |
| `NOTHING_TO_CLAIM` | `NothingToClaimError` | No | Referrals |
| `VALIDATION_ERROR` | `ValidationError` | No | Validation |
| `BATCH_TOO_LARGE` | `BatchTooLargeError` | No | Batch Operations |

---

## 3. Invoice Lifecycle Errors

### `INVOICE_NOT_FOUND`
- **Class**: `InvoiceNotFoundError`
- **Cause**: The requested invoice ID does not exist in contract instance storage or has been purged.
- **Recovery Action**: Check that the invoice ID is formatted correctly; verify that the invoice creation transaction succeeded on the target network.
- **Example**:
```typescript
try {
  const invoice = await client.invoices.get("inv-999");
} catch (err) {
  if (err instanceof InvoiceNotFoundError) {
    console.warn(`Invoice ${err.invoiceId} does not exist.`);
    // Prompt user to verify ID or recreate invoice
  }
}
```

### `INVOICE_NOT_PENDING`
- **Class**: `InvoiceNotPendingError`
- **Cause**: An operation requiring an unfunded active invoice was called on an invoice in `Released`, `Refunded`, or `Cancelled` status.
- **Recovery Action**: Fetch the latest invoice status via `client.invoices.get(id)` and update UI controls to disable payment or cancellation buttons.

### `DEADLINE_PASSED` / `INVOICE_EXPIRED`
- **Classes**: `DeadlinePassedError`, `InvoiceExpiredError`
- **Cause**: The Unix timestamp deadline for the invoice has passed. Further payments or modifications are rejected by the contract.
- **Recovery Action**: Request the invoice creator or co-creators to vote on extending the deadline (`client.voteExtendDeadline()`), or issue a fresh replacement invoice.
- **Example**:
```typescript
try {
  await client.payments.pay({ invoiceId, amount, payer });
} catch (err) {
  if (err instanceof DeadlinePassedError) {
    console.error(`Invoice ${err.invoiceId} expired.`);
    // Offer to clone or recreate invoice
  }
}
```

### `INVOICE_FULLY_FUNDED`
- **Class**: `InvoiceFullyFundedError`
- **Cause**: Attempted to submit a payment or match pledge toward an invoice that has already met 100% of its target funding amount.
- **Recovery Action**: Read `invoice.funded` and `totalOwed` before payment; clamp proposed payments to `totalOwed - funded`.

### `DELEGATE_LIMIT_REACHED`
- **Class**: `DelegateLimitReachedError`
- **Cause**: The maximum number of delegates (default: 3) for the invoice has already been reached.
- **Recovery Action**: Remove an existing delegate with `client.removeDelegate()` before adding another.

---

## 4. Payment & Settlement Errors

### `INSUFFICIENT_BALANCE` / `PAYMENT_EXCEEDS_REMAINING`
- **Classes**: `InsufficientBalanceError`, `PaymentExceedsRemainingError`
- **Cause**: Proposed payment amount is greater than the remaining unfunded balance (`totalOwed - funded`).
- **Recovery Action**: Compute the remaining balance and adjust the payment amount input.
- **Example**:
```typescript
const total = invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);
const remaining = total - invoice.funded;

if (proposedAmount > remaining) {
  console.log(`Clamping payment from ${proposedAmount} to ${remaining}`);
  proposedAmount = remaining;
}
```

### `PAYMENT_COOLDOWN_ACTIVE`
- **Class**: `PaymentCooldownActiveError`
- **Retryable**: Yes
- **Cause**: Payer has made a payment recently and is subject to a rate-limiting cooldown window configured by the creator.
- **Recovery Action**: Inspect `err.retryAfter` (a `Date` instance) and schedule automatic retry after the cooldown expires.
- **Example**:
```typescript
try {
  await client.payments.pay({ invoiceId, amount, payer });
} catch (err) {
  if (err instanceof PaymentCooldownActiveError) {
    const delayMs = err.retryAfter.getTime() - Date.now();
    console.log(`Cooldown active. Retrying in ${delayMs}ms at ${err.retryAfter}`);
    setTimeout(() => client.payments.pay({ invoiceId, amount, payer }), Math.max(0, delayMs));
  }
}
```

### `CONTRIBUTION_CAP_EXCEEDED`
- **Class**: `ContributionCapExceededError`
- **Cause**: Payer's cumulative contribution exceeds the configured per-payer maximum cap.
- **Recovery Action**: Inform the user of their cap limit (`err.cap`) and reduce the payment amount to fit within remaining allowance.

### `DUPLICATE_PAYMENT`
- **Class**: `DuplicatePaymentError`
- **Cause**: Idempotency token or identical payment signature was detected in-flight or already settled.
- **Recovery Action**: Retrieve the existing payment receipt using `client.payments.getReceipt(invoiceId, payer)` instead of resubmitting.

---

## 5. Network, RPC & Submission Errors

### `RPC_ERROR` / `RPC_UNAVAILABLE`
- **Classes**: `RpcError`, `RpcUnavailableError`, `RpcConnectionError`
- **Retryable**: Yes (for HTTP 429 and 503 status codes)
- **Cause**: Soroban RPC node is overloaded, unreachable, or returned a transient error.
- **Recovery Action**: The SDK's resilient RPC engine retries automatically using exponential backoff with jitter. Configure backup RPC endpoints via `rpcEndpoints` to enable transparent failover.

### `CIRCUIT_OPEN`
- **Class**: `CircuitOpenError`
- **Retryable**: Yes
- **Cause**: The circuit breaker tripped open after exceeding the failure threshold (e.g., 5 consecutive RPC failures).
- **Recovery Action**: Pause automated requests until the reset timeout elapses (probing / half-open state), or call `client.resetCircuitBreaker()` if the underlying network issue has been resolved.

### `SIMULATION_FAILED`
- **Class**: `SimulationFailedError`
- **Cause**: Soroban simulated transaction execution reverted (contract panic).
- **Recovery Action**: Inspect the simulation logs and error string in `err.message` or `err.raw`; verify authorizations, signatures, and contract parameters before attempting on-chain submission.

---

## 6. Authorization & Access Control Errors

### `UNAUTHORIZED`
- **Class**: `UnauthorizedError`
- **Cause**: Caller address is not the creator, admin, or authorized party for this operation.
- **Recovery Action**: Ensure the connected signer or wallet keypair matches the expected role on-chain.

### `WALLET_NOT_CONNECTED`
- **Class**: `WalletNotConnectedError`
- **Cause**: An operation requiring transaction signing was invoked without an active wallet connection.
- **Recovery Action**: Call `await client.connectWallet(adapter)` before triggering payment or administrative flows.

### `NFT_GATE_REQUIRED` / `TOKEN_GATE_ACCESS_DENIED`
- **Classes**: `NftGateRequiredError`, `TokenGateAccessDeniedError`
- **Cause**: The creator or invoice requires callers to hold a qualifying NFT or asset balance.
- **Recovery Action**: Query gating status via `client.checkNftGate(address)`; verify user's wallet holds the required token balance.

### `CONTRACT_FROZEN`
- **Class**: `ContractFrozenError`
- **Cause**: The entire StellarSplit smart contract has been administratively paused or frozen.
- **Recovery Action**: Await administrative unfreeze notice before issuing new operations.

---

## 7. Dispute & Governance Errors

### `DISPUTE_EVIDENCE_ERROR`
- **Class**: `DisputeEvidenceError`
- **Cause**: The evidence hash or URI provided is invalid, empty, or submitted outside the active dispute window.
- **Recovery Action**: Ensure evidence URI points to a valid decentralized resource (e.g. IPFS CID) and invoice status is currently disputed.

### `CO_CREATOR_APPROVAL_NOT_REQUIRED`
- **Class**: `CoCreatorApprovalNotRequiredError`
- **Cause**: Attempted to submit co-creator approval on an invoice that was created without co-creators.
- **Recovery Action**: Check `invoice.coCreators` before displaying approval options in the interface.

---

## 8. Milestones, Rounds & Referrals Errors

### `ROUND_NOT_ENDED`
- **Class**: `RoundNotEndedError`
- **Cause**: `closeRound` was called before the round timestamp has passed.
- **Recovery Action**: Inspect `err.roundEnd`; display a countdown timer and only enable round closure once current time > `roundEnd`.
- **Example**:
```typescript
try {
  await client.milestones.closeRound("inv-100");
} catch (err) {
  if (err instanceof RoundNotEndedError) {
    const remainingSeconds = err.roundEnd - Math.floor(Date.now() / 1000);
    console.log(`Round is still active. Please wait ${remainingSeconds}s.`);
  }
}
```

### `WRONG_MILESTONE`
- **Class**: `WrongMilestoneError`
- **Cause**: `completeMilestone` was called for an inactive milestone index.
- **Recovery Action**: Query `client.milestones.getActive(invoiceId)` and complete milestones sequentially.

### `NOTHING_TO_CLAIM`
- **Class**: `NothingToClaimError`
- **Cause**: User called `claimReferralRewards()`, but their referral balance is 0.
- **Recovery Action**: Query `client.getReferralBalance(address)` prior to calling claim.

---

## 9. Validation & Batch Errors

### `BATCH_TOO_LARGE`
- **Class**: `BatchTooLargeError`
- **Cause**: Submitted batch of payments exceeds maximum batch limit (default: 20).
- **Recovery Action**: Chunk array of payments into slices of `maxSize` using `chunk()` utility before submission.

### `VALIDATION_ERROR`
- **Class**: `ValidationError`
- **Cause**: Provided arguments failed client-side validation (e.g., negative stroop amounts, invalid address checksums, malformed metadata).
- **Recovery Action**: Correct input arguments based on `err.context`.

---

## 10. Recommended Error Handling Patterns

```typescript
import {
  StellarSplitClient,
  StellarSplitError,
  isRetryable,
  InvoiceNotFoundError,
  PaymentCooldownActiveError,
} from "@stellar-split/sdk";

async function executePaymentWithRecovery(client: StellarSplitClient, invoiceId: string, amount: bigint, payer: string) {
  try {
    const tx = await client.payments.pay({ invoiceId, amount, payer });
    console.log(`Payment successful: ${tx.txHash}`);
    return tx;
  } catch (err: unknown) {
    // 1. Check for transient/retryable conditions
    if (isRetryable(err)) {
      if (err instanceof PaymentCooldownActiveError) {
        console.warn(`Cooldown active until ${err.retryAfter}. Retrying later.`);
        return;
      }
      console.warn("Transient RPC failure encountered. Retrying...");
      // Backoff and retry
    }

    // 2. Specific domain errors
    if (err instanceof InvoiceNotFoundError) {
      console.error(`Invoice ${err.invoiceId} was not found on-chain.`);
      return;
    }

    // 3. Catch-all for typed StellarSplit errors
    if (err instanceof StellarSplitError) {
      console.error(`SDK Error [${err.code}]: ${err.message}`, err.context);
      if (err.raw) {
        console.error("Soroban contract panic:", err.raw);
      }
      return;
    }

    // 4. Unexpected generic errors
    console.error("Unexpected error:", err);
  }
}
```

---

## 11. Additional Error Codes (Lookup)

Less common errors, grouped in one alphabetical lookup table. All extend `StellarSplitError`, so `err.code` and `err.context` are always available. Search this page for the code or class name to jump to it.

Recovery by category:

- **Config / initialization errors** (`*_NOT_REGISTERED`, `*_NOT_INITIALIZED`, `*_CONFIG_ERROR`, `UNKNOWN_*`): programmer errors. Fix the setup; do not retry.
- **Network / timeout errors** (`*_TIMEOUT`, `*_FETCH_*`, `FRIENDBOT_FAILED`, `CHANNEL_EXHAUSTED`, `RATE_LIMIT_EXCEEDED`): usually transient. Retry with backoff (`isRetryable(err)`), honoring `retryAfterMs` where present.
- **Validation / integrity errors** (`*_VALIDATION*`, `INVALID_*`, `CID_MISMATCH`, `INVOICE_INTEGRITY`): correct the input; retrying with the same input will fail again.
- **Shutdown errors** (`SHUTDOWN_IN_PROGRESS`, `GRACEFUL_SHUTDOWN_TIMEOUT`): stop issuing writes and re-create the client after restart.

```typescript
import { StellarSplitError, RateLimitExceededError } from "@stellar-split/sdk";

try {
  await client.pay(invoiceId, amount);
} catch (err) {
  if (err instanceof RateLimitExceededError) {
    await sleep(err.retryAfterMs); // back off, then retry
  } else if (err instanceof StellarSplitError && err.code === "CID_MISMATCH") {
    // content was tampered with or the CID is wrong: do not retry
  }
}
```

| Error Code | Error Class | Cause |
| :--- | :--- | :--- |
| `ACCOUNT_FROZEN` | `AccountFrozenError` | An account's trustline has been frozen by the asset issuer |
| `ACCOUNT_LOCKED` | `AccountLockedError` | An account is permanently locked out of authorization (auth_immutable without auth) |
| `APPROVAL_TIMEOUT` | `ApprovalTimeoutError` | An approval workflow exceeds its configured timeout |
| `BLINDING_FACTOR_DECRYPTION_ERROR` | `BlindingFactorDecryptionError` | Blinding factor decryption fails |
| `BLINDING_FACTOR_NOT_FOUND` | `BlindingFactorNotFoundError` | Blinding factor is not found for an invoice |
| `BLINDING_FACTOR_STORAGE_ERROR` | `BlindingFactorStorageError` | Blinding factor storage operation fails |
| `CERTIFICATE_PINNING_ERROR` | `CertificatePinningError` | A TLS certificate fingerprint for an anchor HTTPS endpoint does not match the configured pinned fingerprint |
| `CHAIN_TOO_DEEP` | `ChainTooDeepError` | A prerequisite chain exceeds the maximum traversal depth |
| `CHANNEL_EXHAUSTED` | `ChannelExhaustedError` | All channel accounts in the pool are busy and the acquire timeout elapses |
| `CHANNEL_RECONCILIATION_FAILED` | `ChannelReconciliationError` | Channel reconciliation fails |
| `CID_MISMATCH` | `CIDMismatchError` | CID verification detects tampered or mismatched content |
| `CIRCULAR_FORWARD_CHAIN` | `CircularForwardChainError` | A forward chain contains a cycle |
| `CIRCULAR_PREREQUISITE` | `CircularPrerequisiteError` | A prerequisite chain contains a cycle |
| `CLAIMABLE_BALANCE_LIFECYCLE_ERROR` | `ClaimableBalanceLifecycleError` | Claimable balance lifecycle operations fail |
| `CLASSIFIED_HORIZON_ERROR` | `ClassifiedHorizonError` | Wraps a classified Horizon error with the structured classification |
| `COMMITMENT_GENERATION_ERROR` | `CommitmentGenerationError` | Pedersen commitment generation fails |
| `CONNECTION_POOL_CONFIG_ERROR` | `ConnectionPoolConfigError` | Connection pool is improperly configured |
| `CONNECTION_POOL_DISPOSED` | `ConnectionPoolDisposedError` | Connection pool is already disposed |
| `CONTRACT_ERROR` | `ContractError` | A simulation or transaction fails due to contract error |
| `CONTRACT_RETRY_EXHAUSTED` | `ContractRetryExhaustedError` | A queued contract invocation exhausts its retry attempts |
| `CSRF_VALIDATION_FAILED` | `CsrfValidationError` | A CSRF token is missing, malformed, expired or does not match |
| `DATA_ENTRY_VALIDATION_ERROR` | `DataEntryValidationError` | See class JSDoc in `src/errors.ts` |
| `DEPLOY_SEQUENCE_ERROR` | `DeploySequenceError` | Thrown by `DeployPipeline` when a WASM upload or contract instantiation step keeps failing with `tx_bad_seq` after retrying with a freshly-fetched sequence number |
| `DEX_QUOTE_FAILED` | `DexQuoteFailedError` | A DEX quote operation fails |
| `DISCOVERY_FETCH_FAILED` | `DiscoveryFetchError` | Discovery fetch fails |
| `DRY_RUN_FAILED` | `DryRunFailedError` | `.submit()` is called but the prior `.dryRun()` simulation returned an error field from the RPC |
| `DUPLICATE_RECIPIENT` | `DuplicateRecipientError` | Duplicate recipient account IDs are detected in `reject` mode |
| `ENVELOPE_LIMIT` | `EnvelopeLimitError` | An operation envelope exceeds the maximum number of operations (100) or the maximum base fee (10_000_000 stroops) |
| `FINALITY_TIMEOUT` | `FinalityTimeoutError` | A transaction is not confirmed within the finality wait budget |
| `FLOW_FETCHER_NOT_REGISTERED` | `InvoiceFlowFetcherNotRegisteredError` | Invoice flow fetcher is not registered |
| `FORWARD_CHAIN_TOO_DEEP` | `ForwardChainTooDeepError` | Resolving a forward chain exceeds the maximum depth limit |
| `FRIENDBOT_FAILED` | `FriendbotFailedError` | Friendbot request fails |
| `GRACEFUL_SHUTDOWN_TIMEOUT` | `GracefulShutdownTimeoutError` | Graceful shutdown times out while requests are still pending |
| `INSUFFICIENT_SPONSOR_RESERVE` | `InsufficientSponsorReserveError` | A sponsor account lacks the reserve to cover new ledger entries |
| `INVALID_ATTESTATION` | `InvalidAttestationError` | Attestation parameters are invalid |
| `INVALID_BATCH_SIZE` | `InvalidBatchSizeError` | Batch size validation fails |
| `INVALID_CONTRACT_ADDRESS` | `InvalidContractAddressError` | A string is not a well-formed Soroban contract address (`C...`, 56 base32 characters, valid CRC16 checksum) |
| `INVALID_KEYPAIR` | `InvalidKeypairError` | A KeypairSigner is constructed with an invalid secret key or keypair |
| `INVALID_PATH_QUERY` | `InvalidPathQueryError` | See class JSDoc in `src/errors.ts` |
| `INVALID_TRANSACTION_TYPE` | `InvalidTransactionTypeError` | A fee-bump inner transaction is not a v1 transaction |
| `INVOICE_FETCHER_NOT_REGISTERED` | `InvoiceFetcherNotRegisteredError` | Invoice fetcher is not registered |
| `INVOICE_INTEGRITY` | `InvoiceIntegrityError` | An invoice's content hash diverges from its declared hash |
| `IPFS_CONFIG_ERROR` | `IPFSConfigError` | IPFS configuration is invalid or missing |
| `IPFS_FETCH_ERROR` | `IPFSFetchError` | IPFS content fetch fails |
| `IPFS_PIN_ERROR` | `IPFSPinError` | IPFS pinning operation fails |
| `KEY_ACCESS_DENIED` | `KeyAccessDeniedError` | Access to a stored key is denied by the access-control policy |
| `KEY_ENCRYPTION_ERROR` | `KeyEncryptionError` | Encryption or decryption of a stored key fails |
| `MERGE_CONFLICT` | `MergeConflictError` | Thrown by `mergeInvoices` when both local and remote branches have modified the same field relative to the common base, producing a conflict that cannot be resolved automatically |
| `METADATA_VALIDATION` | `MetadataValidationError` | Invoice metadata fails validation (ajv-style error list) |
| `NO_RETURN_VALUE` | `NoReturnValueError` | No return value is received from a contract call |
| `NO_SIGNER_PROVIDED` | `NoSignerProvidedError` | At least one signer is required |
| `OFFER_TRACKING_ERROR` | `OfferTrackingError` | Offer tracking or cancellation fails |
| `ORACLE_PRICE_ERROR` | `OraclePriceError` | Oracle price fetch fails |
| `PATH_NOT_FOUND` | `PathNotFoundError` | No DEX path could be found between two assets |
| `PATH_ROUTER_ERROR` | `PathRouterError` | The path router encounters an unexpected error |
| `PAYER_ADDRESS_REQUIRED` | `PayerAddressRequiredError` | Payer address is required but not provided |
| `PAYMENT_ESCALATION_ABORT` | `PaymentEscalationAbortError` | The `abort` escalation step fires, cancelling the payment |
| `PLUGIN_ALREADY_REGISTERED` | `PluginAlreadyRegisteredError` | A plugin with the same name is already registered |
| `PREFLIGHT_ERROR` | `PreflightError` | A preflight check fails before the SDK attempts contract calls |
| `QUEUE_FAILED` | `QueueFailedError` | Queue has failed |
| `RATE_LIMIT_EXCEEDED` | `RateLimitExceededError` | A request exceeds its configured rate limit |
| `RECIPIENT_PRE_CHECK_FAILED` | `RecipientPreCheckFailedError` | One or more recipients fail a pre-payment balance pre-check |
| `REFUND_GRACE_ERROR` | `RefundGraceError` | Refund grace period error occurs |
| `RELATIONSHIP_TRACKER_NOT_INITIALIZED` | `RelationshipTrackerNotInitializedError` | Relationship tracker is not initialized |
| `SANITIZATION_ERROR` | `SanitizationError` | An input fails sanitization and cannot be safely coerced into an acceptable value (e.g. it contains a disallowed pattern or is not on the configured whitelist) |
| `SDK_ERROR` | `AddressValidationError` | Address validation fails |
| `SDK_ERROR` | `AmountValidationError` | Amount validation fails |
| `SDK_ERROR` | `DeadlineValidationError` | Deadline validation fails |
| `SDK_ERROR` | `SdkError` | Generic SDK error carrying a typed `SdkErrorCode` and optional details |
| `SDK_ERROR` | `Sep41AdapterError` | Sep41 adapter unexpected return type |
| `SDK_ERROR` | `SignatureValidationError` | Signature validation fails |
| `SDK_ERROR` | `WhitelistViolationError` | An input value is not present in the configured whitelist |
| `SEARCH_FAILED` | `SearchFailedError` | Search operation fails |
| `SEQUENCE_CACHE_ERROR` | `SequenceCacheError` | The sequence cache fails to fetch an account from Horizon |
| `SEQUENCE_NUMBER_TOO_OLD` | `SequenceNumberTooOldError` | A SEQUENCE_NUMBER_TOO_OLD error is detected at submission time |
| `SHUTDOWN_IN_PROGRESS` | `ShutdownInProgressError` | A new write request is attempted during graceful shutdown |
| `SIGNER_FAILED` | `SignerFailedError` | A signer fails to sign a transaction |
| `STELLAR_TOML_FETCH_ERROR` | `StellarTomlFetchError` | A stellar.toml file cannot be fetched or is unreachable |
| `TEST_HARNESS_NOT_INITIALIZED` | `TestHarnessNotInitializedError` | Test harness is not initialized |
| `TOO_MANY_SUBSCRIPTIONS` | `TooManySubscriptionsError` | Too many concurrent invoice subscriptions are created |
| `TRANCHE_PROGRESS_ERROR` | `TrancheProgressError` | Tranche status check fails |
| `TRANSACTION_NOT_SUCCESSFUL` | `TransactionNotSuccessfulError` | Transaction status is not successful |
| `TTL_EXTENSION_FAILED` | `TtlExtensionFailedError` | TTL extension operation fails |
| `UNKNOWN_ENDPOINT` | `UnknownEndpointError` | LoadBalancer endpoint is not found |
| `UNKNOWN_EXPORT_FORMAT` | `UnknownExportFormatError` | Export format is unknown |
| `UNKNOWN_NETWORK` | `UnknownNetworkError` | An unknown network is specified |
| `UNKNOWN_SPLIT` | `UnknownSplitError` | See class JSDoc in `src/errors.ts` |
| `UNKNOWN_TEST_WALLET` | `UnknownTestWalletError` | An unknown test wallet address is provided |
| `UNSUPPORTED_LINE_ITEM_ASSET` | `UnsupportedLineItemAssetError` | A line item's asset has no oracle price available for normalisation |
| `UNSUPPORTED_TOML_VERSION` | `UnsupportedTomlVersionError` | A `stellar.toml` file carries a VERSION that is not listed in `SUPPORTED_TOML_VERSIONS` |
| `VERIFICATION_FAILED` | `TransactionVerificationError` | Thrown by transaction verification when one or more checks fail |
| `WALLET_CONNECTION_TIMEOUT` | `WalletConnectionTimeoutError` | A wallet deep-link or extension connection times out |
| `WEBHOOK_EXHAUSTED` | `WebhookExhaustedError` | Thrown by `WebhookAgent` when a webhook delivery has exhausted its configured retry budget without a successful response |
