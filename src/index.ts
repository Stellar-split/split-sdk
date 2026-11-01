/**
 * SDK health check system.
 *
 * Provides a small framework for registering health checks (service checks,
 * dependency checks, custom checks), executing them, aggregating their
 * results, and exposing the aggregated status through health endpoints.
 */

export type HealthStatus = 'healthy' | 'degraded' | 'unhealthy';

export { StellarSplitClient } from "./client.js";
export { FinalityChecker } from "./finalityChecker.js";
export { buildPaymentMemo, parsePaymentMemo } from "./memoBuilder.js";
export {
  parseAmount,
  formatAmount,
  isValidStellarAddress,
  truncateAddress,
  isExpired,
} from "./utils.js";
export type {
  StellarSplitClientConfig,
  NetworkConfig,
  TxResult,
  StellarSplitPlugin,
} from "./client.js";

import type { HealthCheckResult } from "./healthCheck.js";

export {
  NetworkEnvironment,
  NETWORK_PRESETS,
  isNetworkPreset,
  getNetworkPreset,
  detectNetworkEnvironment,
} from "./config.js";
export type { NetworkPreset } from "./config.js";

export type {
  TelemetryHooks,
  TelemetryErrorContext,
  TelemetryCallStartParams,
  TelemetryCallEndParams,
} from "./telemetryHooks.js";

export { PluginRegistry, LoggingPlugin, MetricsPlugin } from "./plugin.js";
export type { SdkPlugin, SdkMethodName, PluginArgs, PluginResult, StellarSplitClientContext } from "./plugin.js";

export {
  LogLevel,
  SdkLogger,
  parseLogLevel,
  logLevelToString,
  sanitizeLogValue,
  defaultLogFormatter,
  defaultConsoleSink,
} from "./logger.js";
export type {
  Logger,
  LoggerOptions,
  LogLevelString,
  LogEntry,
  LogFormatter,
  LogSink,
} from "./logger.js";

export {
  serializeInvoiceTemplate,
  deserializeInvoiceTemplate,
} from "./invoiceTemplate.js";
export {
  validateBulkImport,
  SUPPORTED_SCHEMA_VERSIONS,
} from "./bulkImportValidator.js";
export type {
  BulkImportRowError,
  BulkImportValidationResult,
  BulkImportPayload,
} from "./bulkImportValidator.js";
export {
  StellarSplitError,
  InvoiceNotFoundError,
  InvoiceNotPendingError,
  DeadlinePassedError,
  InsufficientBalanceError,
  PaymentExceedsRemainingError,
  InvoiceFrozenError,
  CoCreatorApprovalNotRequiredError,
  ChainTooDeepError,
  CircularPrerequisiteError,
  CircularForwardChainError,
  ForwardChainTooDeepError,
  UnauthorizedError,
  parseSorobanError,
  NftGateRequiredError,
  WalletNotConnectedError,
  RpcError,
  ContractError,
  CircuitOpenError,
  ValidationError,
  PluginAlreadyRegisteredError,
  InvalidBatchSizeError,
  InvoiceNotReleasedError,
  TransactionFailedError,
  TransactionNotConfirmedError,
  SimulationFailedError,
  NoReturnValueError,
  UnknownNetworkError,
  InsufficientSignaturesError,
  CloneChainTooDeepError,
  NoPendingPayoutError,
  InvalidAttestationError,
  InvoiceFlowFetcherNotRegisteredError,
  InvoiceFetcherNotRegisteredError,
  UnknownEndpointError,
  RpcUnavailableError,
  DiscoveryFetchError,
  PayerAddressRequiredError,
  SignerFailedError,
  NoSignerProvidedError,
  ConnectionPoolConfigError,
  ConnectionPoolDisposedError,
  SearchFailedError,
  TransactionNotSuccessfulError,
  QueueFailedError,
  UnknownExportFormatError,
  DexQuoteFailedError,
  TtlExtensionFailedError,
  TestHarnessNotInitializedError,
  UnknownTestWalletError,
  RelationshipTrackerNotInitializedError,
  FriendbotFailedError,
  DisputeEvidenceError,
  OraclePriceError,
  Sep41AdapterError,
  TrancheProgressError,
  RefundGraceError,
  PreflightError,
  ChannelReconciliationError,
  SequenceCacheError,
  SequenceNumberTooOldError,
  PathNotFoundError,
  PathRouterError,
  OfferTrackingError,
  ClaimableBalanceLifecycleError,
  InvoiceFullyFundedError,
  isInvoiceFullyFundedError,
  DelegateLimitReachedError,
  isDelegateLimitReachedError,
  isInvoiceNotFoundError,
  isInvoiceNotPendingError,
  isDeadlinePassedError,
  isInsufficientBalanceError,
  isPaymentExceedsRemainingError,
  isInvoiceFrozenError,
  isCoCreatorApprovalNotRequiredError,
  isChainTooDeepError,
  isCircularPrerequisiteError,
  isForwardChainTooDeepError,
  isUnauthorizedError,
  isWalletNotConnectedError,
  isRpcError,
  isContractError,
  isCircuitOpenError,
  isCircularForwardChainError,
  isValidationError,
  isNftGateRequiredError,
  isPluginAlreadyRegisteredError,
  isInvalidBatchSizeError,
  isInvoiceNotReleasedError,
  isTransactionFailedError,
  isTransactionNotConfirmedError,
  isSimulationFailedError,
  isNoReturnValueError,
  isUnknownNetworkError,
  isInsufficientSignaturesError,
  isCloneChainTooDeepError,
  isNoPendingPayoutError,
  isInvalidAttestationError,
  isInvoiceFlowFetcherNotRegisteredError,
  isInvoiceFetcherNotRegisteredError,
  isUnknownEndpointError,
  isRpcUnavailableError,
  isDiscoveryFetchError,
  isPayerAddressRequiredError,
  isSignerFailedError,
  isNoSignerProvidedError,
  isConnectionPoolConfigError,
  isConnectionPoolDisposedError,
  isSearchFailedError,
  isTransactionNotSuccessfulError,
  isQueueFailedError,
  isUnknownExportFormatError,
  isDexQuoteFailedError,
  isTtlExtensionFailedError,
  isTestHarnessNotInitializedError,
  isUnknownTestWalletError,
  isRelationshipTrackerNotInitializedError,
  isFriendbotFailedError,
  isDisputeEvidenceError,
  isOraclePriceError,
  isSep41AdapterError,
  isTrancheProgressError,
  isRefundGraceError,
  isPreflightError,
  isChannelReconciliationError,
  isSequenceCacheError,
  isSequenceNumberTooOldError,
  isPathNotFoundError,
  isPathRouterError,
  isOfferTrackingError,
  isClaimableBalanceLifecycleError,
  TooManySubscriptionsError,
  isTooManySubscriptionsError,
  RequestTimeoutError,
  isRequestTimeoutError,
  AdminOperationError,
  isAdminOperationError,
  NetworkMismatchError,
  isNetworkMismatchError,
  CommitmentGenerationError,
  isCommitmentGenerationError,
  BlindingFactorStorageError,
  isBlindingFactorStorageError,
  BlindingFactorNotFoundError,
  isBlindingFactorNotFoundError,
  BlindingFactorDecryptionError,
  isBlindingFactorDecryptionError,
  IPFSPinError,
  isIPFSPinError,
  IPFSFetchError,
  isIPFSFetchError,
  CIDMismatchError,
  isCIDMismatchError,
  IPFSConfigError,
  isIPFSConfigError,
  ShutdownInProgressError,
  isShutdownInProgressError,
  // New: AMM Calculator
  InsufficientLiquidityError,
  isInsufficientLiquidityError,
  // New: Timeout Escalation
  PaymentEscalationAbortError,
  isPaymentEscalationAbortError,
  // New: Recipient Deduplicator
  DuplicateRecipientError,
  isDuplicateRecipientError,
  // New: Horizon Error Classifier
  ClassifiedHorizonError,
  isClassifiedHorizonError,
  type HorizonErrorClassification,
  FinalityTimeoutError,
  isFinalityTimeoutError,
  ApprovalTimeoutError,
  isApprovalTimeoutError,
  // New: typed SdkError / SdkErrorCode (issue #607)
  SdkError,
  SdkErrorCode,
  isSdkError,
  // Keypair format and signing validation (issue #768)
  InvalidKeypairError,
  isInvalidKeypairError,
  // Batch operations errors (issue #855)
  BatchTooLargeError,
  isBatchTooLargeError,
} from "./errors.js";

// Invoice metadata JSON Schema validator (issue #533)
export { InvoiceMetadataValidator } from "./validators/invoiceMetadataValidator.js";
export type { MetadataValidationResult } from "./validators/invoiceMetadataValidator.js";
export { validateMetadataKeys, MAX_METADATA_KEY_LENGTH } from "./validators/invoiceMetadataValidator.js";

// Deadline validator (issue #1064)
export {
  validateDeadline,
  validateDeadlineOrThrow,
  isFutureDeadline,
  parseDeadline,
  DeadlineValidator,
  MAX_U64 as MAX_DEADLINE_U64,
  MS_TIMESTAMP_THRESHOLD as DEADLINE_MS_TIMESTAMP_THRESHOLD,
} from "./validators/deadlineValidator.js";
export type {
  DeadlineValidationResult,
  DeadlineValidationOptions,
} from "./validators/deadlineValidator.js";

// Amount validator (issue #1063)
export {
  validateAmount,
  validateAmountOrThrow,
  isValidAmount,
  parseToStroops,
  AmountValidator,
  STELLAR_MAX_INT64,
  STELLAR_MIN_AMOUNT,
  STELLAR_MAX_DECIMALS,
  STROOPS_PER_UNIT as AMOUNT_STROOPS_PER_UNIT,
} from "./validators/amountValidator.js";
export type {
  AmountValidationResult,
  AmountValidationOptions,
  AmountUnit,
} from "./validators/amountValidator.js";

// Address validator (issue #1062)
export {
  validateAddress,
  validateAddressOrThrow,
  isStellarAddress,
  detectAddressType,
  verifyAddressChecksum,
  AddressValidator,
  STELLAR_ADDRESS_LENGTHS,
} from "./validators/addressValidator.js";
export type {
  StellarAddressType,
  AddressValidationResult,
  AddressValidationOptions,
} from "./validators/addressValidator.js";

// Signature validator (issue #1061)
export {
  validateEd25519Signature,
  validateEd25519SignatureOrThrow,
  validateMultiSig,
  validateMultiSigOrThrow,
  validateWebhookSignature as validateWebhookSignaturePayload,
  isValidSignatureFormat,
  normalizeSignature,
  normalizePublicKey,
  normalizeMessage,
  SignatureValidator,
  ED25519_SIGNATURE_BYTE_LENGTH,
  ED25519_PUBLIC_KEY_BYTE_LENGTH,
} from "./validators/signatureValidator.js";
export type {
  SignatureValidationResult,
  Ed25519ValidationParams,
  MultiSigEntry,
  SignerWeightConfig,
  MultiSigValidationParams,
  MultiSigValidationResult,
  WebhookValidationParams,
} from "./validators/signatureValidator.js";


// ---------------------------------------------------------------------------
// Lifecycle management (graceful shutdown)
// ---------------------------------------------------------------------------

export { GracefulShutdownHandler, ShutdownTimeoutError } from "./lifecycle/GracefulShutdownHandler.js";
export type { ShutdownOptions, TimeoutAction } from "./lifecycle/GracefulShutdownHandler.js";

export { getScheduledReleaseCountdown } from "./client.js";
export { verifyCompletionProof } from "./client.js";
export { MultiTenantClient } from "./multiTenant.js";
export type { PoolOptions } from "./multiTenant.js";
export { ProfilerSession } from "./profiler.js";
export type {
  ProfileReport,
  ProfileEntry,
  ProfileSession,
  RpcCallTiming,
  SpeedscopeProfile,
  SpeedscopeEventedProfile,
  SpeedscopeFrame,
  SpeedscopeEvent,
  ProfilerSessionOptions,
} from "./profiler.js";
export { MemoryProfiler, memoryProfiler, ProfilerNotInitializedError } from "./memoryProfiler.js";
export type { MemorySnapshot } from "./memoryProfiler.js";
export {
  enrichInvoice,
  enrichInvoices,
  registerInvoiceFetcher,
  hasIPFSMetadata,
  getInvoiceMetadataCID,
} from "./enricher.js";
export type { EnrichedInvoice, EnrichOptions } from "./enricher.js";
export { EnricherCache } from "./enricher.js";

// IPFS functionality
export {
  pinInvoiceMetadata,
  verifyCID,
  verifyCIDOrThrow,
  verifyCIDDetailed,
  computeCidV0,
  computeCidV1,
  fetchFromIPFS,
  fetchInvoiceMetadata,
  parseIPFSCid,
  configureIPFS,
  getIPFSConfig,
  resetIPFSConfig,
  createLineItem,
  createInvoiceMetadata,
  deserializeMetadata,
  DEFAULT_IPFS_CONFIG,
} from "./ipfs.js";

// Confidential payments (Pedersen commitments)
export {
  generateCommitment,
  verifyCommitment,
  storeBlindingFactor,
  loadBlindingFactor,
  deleteBlindingFactor,
  configureBlindingFactorStorage,
  resetBlindingFactorStorageConfig,
  buildRevealTransaction,
  generateAndStoreCommitment,
  buildRevealTransactionFromStorage,
} from "./confidential.js";

export {
  Deduplicator,
  generateIdempotencyKey,
  isKnownKey,
  registerKey,
  clearKeys,
} from "./dedup.js";
export type { IdempotencyKeyParams } from "./dedup.js";

export { TxQueue } from "./queue.js";

export { replayEvents } from "./events.js";
export { sdkEvents } from "./events.js";
export type { FinalityServerLike } from "./finalityChecker.js";
export { ApprovalWorkflowSequencer, ApprovalSession } from "./approvalWorkflowSequencer.js";
export type { ApprovalWorkflowOptions, NotificationAdapter, SignatureApplier } from "./approvalWorkflowSequencer.js";
export { OperationChunker, MAX_OPERATIONS_PER_TRANSACTION } from "./operationChunker.js";
export { StreamHealthProbe } from "./streamHealthProbe.js";
export type { MonitoredStream, StreamHealthProbeOptions } from "./streamHealthProbe.js";
export {
  EventChecksumChain,
  verifyChain,
  findTamperedEvent,
} from "./eventChecksum.js";
export {
  CircuitBreakerMonitor,
  defaultCircuitBreakerMonitor,
} from "./circuitBreakerMonitor.js";

// Circuit breaker + retry resilience layer (Issue #419)
export { CircuitBreaker } from "./circuitBreaker.js";
export type {
  CircuitBreakerConfig,
  CircuitBreakerState,
} from "./circuitBreaker.js";
export { ResilientRpcClient } from "./resilientRpc.js";
export type { RetryConfig } from "./resilientRpc.js";

export { connectWallet, getPublicKey, signTransaction } from "./wallet.js";
export { LobstrAdapter } from "./wallets/adapters/LobstrAdapter.js";
export type { LobstrAdapterOptions } from "./wallets/adapters/LobstrAdapter.js";
export { WalletConnectionTimeoutError, isWalletConnectionTimeoutError } from "./errors.js";

export { checkRPCHealth } from "./health.js";
export { FallbackChain, FallbackExhaustedError } from "./fallbackChain.js";

// ---------------------------------------------------------------------------
// #544 — Soroban Contract Event Log Subscriber
// ---------------------------------------------------------------------------

export { ContractEventSubscriber } from "./contractEventSubscriber.js";
export type {
  ContractEventFilter,
  ParsedContractEvent,
  ContractEventSubscriberConfig,
} from "./contractEventSubscriber.js";

// ---------------------------------------------------------------------------
// #546 — Horizon Endpoint Availability Prober
// ---------------------------------------------------------------------------

export { HorizonProber } from "./horizonProber.js";
export type {
  HorizonProbeResult,
  HorizonProberConfig,
} from "./horizonProber.js";

// Invoice calculator
export {
  calculateSplitAmounts,
  computeAmounts,
  formatSplitPercentage,
  calculateInvoiceSubtotal,
  calculateInvoiceBreakdown,
} from "./invoice/calculator.js";

// Fee estimator
export { estimateFeeForAmount } from "./feeEstimator.js";
export type { FeeForAmountOpts } from "./feeEstimator.js";

// AMM Calculator
export { estimateSwapOutput, calculatePoolShare } from "./ammCalculator.js";

// Recipient Deduplicator
export { deduplicateRecipients } from "./validators/recipientDeduplicator.js";
export type { DedupMode } from "./validators/recipientDeduplicator.js";

// Horizon Error Classifier
export { classifyHorizonError, isHorizonErrorRetryable } from "./horizonErrorClassifier.js";
export { groupInvoicesByPattern } from "./smartGrouping.js";
export type { InvoiceCluster } from "./smartGrouping.js";

export { getOptimisticInvoice } from "./optimistic.js";

export { watchContractUpgrade } from "./upgrade.js";

export { calculateFee } from "./fee.js";

export { formatAddress } from "./utils.js";

export { resolveToken } from "./token.js";

export { watchExpiry } from "./watcher.js";

export { DeadlineEngine } from "./deadlineEngine.js";

export { LedgerCloseEstimator } from "./ledgerCloseEstimator.js";
export type {
  LedgerCloseEstimatorOptions,
  LedgerRecord,
  CalibrationState,
} from "./ledgerCloseEstimator.js";

export { StellarSplitTxBuilder } from "./txBuilder.js";

export { SequenceCache, isSequenceTooOld } from "./sequenceCache.js";
export type { SequenceCacheConfig } from "./sequenceCache.js";

export { PathRouter } from "./pathRouter.js";
export type { PathResult, PathHop, PathRequest, PathRouterConfig } from "./pathRouter.js";
export { PathQueryBuilder } from "./pathQueryBuilder.js";
export type {
  StrictSendQueryParams,
  StrictReceiveQueryParams,
  PathQueryBuilderConfig,
} from "./pathQueryBuilder.js";

export { OfferTracker } from "./offerTracker.js";
export type { OfferTrackerConfig, OfferTrackerEventMap } from "./offerTracker.js";

export { SimpleCache, Cache } from "./cache.js";
export { Recorder, createRecorder } from "./recorder.js";
export type { SessionRecording, RecordingEntry, ReplayResult } from "./recorder.js";

export { TabSync, tabSyncPlugin, createTabSyncPlugin } from "./tabSync.js";
export type { TabSyncEvent, TabSyncEventType, TabSyncOptions } from "./tabSync.js";

export type {
  Invoice,
  InvoiceReceipt,
  Payment,
  Recipient,
  InvoiceStatus,
  CreateInvoiceParams,
  PayParams,
  InvoiceTemplate,
  PaginatedResult,
  PaginationOptions,
  BatchPayment,
  InvoiceEventCallbacks,
  SimulateCreateInvoiceResult,
  SimulatePayResult,
  PreviewTokenSwapResult,
  SDKHealth,
  FeeBreakdown,
  TokenInfo,
  ExpiryEvent,
  ExpiryCallback,
  PaymentProof,
  CircuitBreakerStatus,
  HistoricalInvoice,
  ContractFeatures,
  CloneOverrides,
  OverflowBehavior,
  InvoiceExt,
  PaymentOptions,
  NftGateResult,
  ClaimPayoutResult,
  PayWithAttestationParams,
  AttestationPaymentReceipt,
  CreatorVolumeCap,
  PaymentCooldown,
  CrossChainRef,
  SetCrossChainRefParams,
  RolloverResult,
  ScheduledReleaseCountdown,
  DisputeStatus,
  AuctionBid,
  AuctionInfo,
  TimelockAction,
  QueueActionParams,
  CompletionProof,
  AdminFreezeResult,
  AdminUnfreezeResult,
  TransitionRecord,
  SponsorshipConfig,
  SponsorReserveCheckResult,
  InvoiceRecord,
  XDRType,
  DecodedXDR,
  DecodedTransactionEnvelope,
  DecodedTransactionResult,
  DecodedOperationResult,
  DecodedTransactionMeta,
  DecodedLedgerEntry,
  DecodedOperation,
  ProtocolStats,
} from "./types.js";
export { InvalidTransitionError } from "./types.js";

// Invoice status transition validation (state machine)
export { InvoiceStateMachine } from "./state/InvoiceStateMachine.js";
export type {
  InvoiceStateMachineEventMap,
  TransitionEvent,
  InvalidTransitionEvent,
} from "./state/InvoiceStateMachine.js";
export type { StateMachineConfig, TransitionGraph } from "./types/state.js";

// Per-method timeout (Issue #1)
export { TimeoutManager, withTimeout, EscalationManager, RequestTimeoutError as TimeoutError } from "./timeout.js";
export type { TimeoutConfig, EscalationEvent, EscalationCallback } from "./timeout.js";

// Trace IDs (Issue #2)
export { TraceIdManager, globalTraceIdManager, generateTraceId } from "./traceId.js";
export type { TraceIdGenerator } from "./traceId.js";

// Injectable RpcClient (Issue #3)
export { SorobanRpcAdapter } from "./rpcClient.js";
export type { RpcClient } from "./rpcClient.js";

export { negotiateVersion, SDK_CONTRACT_VERSION } from "./version.js";
export type { VersionInfo } from "./types.js";

export { checkPayerReadiness, checkInvoiceExpiry, checkSponsorReserve, checkRecipientFlags, runPreflight } from "./preflightChecker.js";
export type { PayerReadinessResult, PayerReadinessReason, InvoiceExpiryResult, InvoiceExpiryReason, SponsorReserveCheck, RecipientFlagsCheck, RunPreflightOptions } from "./preflightChecker.js";

export { inspectFlags, hasAnyRestrictiveFlag } from "./accountFlagsInspector.js";
export { detectLockState, assertAccountUnlocked } from "./accountStateDetector.js";
export { AccountFrozenError, AccountLockedError } from "./errors.js";
export type { AccountFlagSet, AccountLockState } from "./types.js";

export { getSuggestion } from "./errorSuggestions.js";

// Comprehensive error codes — descriptions and retryability (issue #1067)
export {
  SDK_ERROR_CODE_DESCRIPTIONS,
  RETRYABLE_ERROR_CODES,
  describeSdkErrorCode,
  isRetryableErrorCode,
  InvalidContractAddressError,
  isInvalidContractAddressError,
  TransactionVerificationError,
  isTransactionVerificationError,
} from "./errors.js";

// Soroban contract address validation (issue #1065)
export {
  validateContractAddress,
  isValidContractAddress,
  assertValidContractAddress,
  CONTRACT_ADDRESS_LENGTH,
  CONTRACT_ADDRESS_PREFIX,
} from "./contractAddressValidator.js";
export type { ContractAddressValidationResult } from "./contractAddressValidator.js";

// Pre-submit transaction verification (issue #1066)
export {
  verifyTransaction,
  verifyTransactionSignatures,
  assertTransactionVerified,
} from "./transactionVerifier.js";
export type {
  TransactionCheckName,
  TransactionCheckResult,
  TransactionVerificationOptions,
  TransactionVerificationResult,
  SignatureVerificationResult,
} from "./transactionVerifier.js";

// Error recovery strategies (issue #1068)
export {
  RECOVERY_STRATEGY_TABLE,
  getRecoveryStrategy,
  getRecoveryPlan,
  executeWithRecovery,
} from "./errorRecovery.js";
export type {
  RecoveryAction,
  RecoveryStrategy,
  RecoveryPlan,
  RecoveryRunOptions,
} from "./errorRecovery.js";

// ---------------------------------------------------------------------------
// XDR Decoder — structured logging of Stellar XDR
// ---------------------------------------------------------------------------

export { decodeXDR, decode, decodeInt128 } from "./xdrDecoder.js";
export { decodeTransactionResult } from "./txResultDecoder.js";

// ---------------------------------------------------------------------------
// SSE Cursor Tracker — persistent cursor for stream resumption
// ---------------------------------------------------------------------------

export {
  configureCursorStore,
  getCursor,
  setCursor,
  removeCursor,
  setCursorFromSnapshot,
  _resetCursorTrackerForTesting,
} from "./cursorTracker.js";
export type { CursorPersistence } from "./cursorTracker.js";

export interface HealthReport {
  status: HealthStatus;
  timestamp: string;
  durationMs: number;
  checks: HealthCheckResult[];
}

export type HealthCheckFn = () => Promise<HealthCheckResult> | HealthCheckResult;

export interface HealthCheck {
  name: string;
  critical: boolean;
  check: HealthCheckFn;
}

export interface HealthEndpointResponse {
  statusCode: number;
  body: HealthReport;
}

const STATUS_RANK: Record<HealthStatus, number> = {
  healthy: 0,
  degraded: 1,
  unhealthy: 2,
};

function worstStatus(a: HealthStatus, b: HealthStatus): HealthStatus {
  return STATUS_RANK[a] >= STATUS_RANK[b] ? a : b;
}

function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Framework for registering and running health checks.
 */
export class HealthCheckRegistry {
  private readonly checks = new Map<string, HealthCheck>();

  register(check: HealthCheck): this {
    if (!check.name) {
      throw new Error('Health check must have a name');
    }
    this.checks.set(check.name, check);
    return this;
  }

  unregister(name: string): boolean {
    return this.checks.delete(name);
  }

  has(name: string): boolean {
    return this.checks.has(name);
  }

  list(): HealthCheck[] {
    return Array.from(this.checks.values());
  }

  /**
   * Run a single check, capturing errors and timing.
   */
  async runCheck(check: HealthCheck): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      const result = await check.check();
      return {
        ...result,
        name: check.name,
        durationMs: Date.now() - start,
        timestamp: result.timestamp ?? nowIso(),
      };
    } catch (err) {
      return {
        name: check.name,
        status: 'unhealthy',
        message: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
        timestamp: nowIso(),
      };
    }
  }

  /**
   * Run all registered checks and aggregate the results.
   */
  async runAll(): Promise<HealthReport> {
    const start = Date.now();
    const checks = this.list();
    const results = await Promise.all(checks.map((c) => this.runCheck(c)));

    let status: HealthStatus = 'healthy';
    for (let i = 0; i < results.length; i++) {
      const result = results[i]!;
      const check = checks[i]!;
      // Non-critical checks can only degrade overall health, never fail it.
      if (!check.critical && result.status === 'unhealthy') {
        status = worstStatus(status, 'degraded');
      } else {
        status = worstStatus(status, result.status);
      }
    }

    return {
      status,
      timestamp: nowIso(),
      durationMs: Date.now() - start,
      checks: results,
    };
  }
}

/**
 * Build a health check for an external service reachable via a probe function.
 */
export function createServiceCheck(
  name: string,
  probe: () => Promise<boolean> | boolean,
  options: { critical?: boolean } = {},
): HealthCheck {
  return {
    name,
    critical: options.critical ?? true,
    async check(): Promise<HealthCheckResult> {
      const start = Date.now();
      const ok = await probe();
      return {
        name,
        status: ok ? 'healthy' : 'unhealthy',
        message: ok ? undefined : `Service ${name} is unavailable`,
        durationMs: Date.now() - start,
        timestamp: nowIso(),
      };
    },
  };
}

/**
 * Build a health check for a dependency (e.g. database, cache, queue).
 */
export function createDependencyCheck(
  name: string,
  verify: () => Promise<boolean> | boolean,
  options: { critical?: boolean } = {},
): HealthCheck {
  return {
    name: `dependency:${name}`,
    critical: options.critical ?? true,
    async check(): Promise<HealthCheckResult> {
      const start = Date.now();
      const ok = await verify();
      return {
        name: `dependency:${name}`,
        status: ok ? 'healthy' : 'unhealthy',
        message: ok ? undefined : `Dependency ${name} failed verification`,
        durationMs: Date.now() - start,
        timestamp: nowIso(),
      };
    },
  };
}

/**
 * Health endpoint handlers returning aggregated health status.
 */
export class HealthEndpoints {
  constructor(private readonly registry: HealthCheckRegistry) {}

  /** Liveness: process is up. */
  async liveness(): Promise<HealthEndpointResponse> {
    return {
      statusCode: 200,
      body: {
        status: 'healthy',
        timestamp: nowIso(),
        durationMs: 0,
        checks: [],
      },
    };
  }

  /** Readiness: all critical checks pass. */
  async readiness(): Promise<HealthEndpointResponse> {
    const report = await this.registry.runAll();
    const statusCode = report.status === 'unhealthy' ? 503 : 200;
    return { statusCode, body: report };
  }

  /** Full health report. */
  async health(): Promise<HealthEndpointResponse> {
    const report = await this.registry.runAll();
    const statusCode = report.status === 'unhealthy' ? 503 : 200;
    return { statusCode, body: report };
  }
}

/**
 * Periodic health monitoring that records the latest report and notifies
 * listeners on status changes.
 */
export class HealthMonitor {
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastReport: HealthReport | null = null;
  private readonly listeners: Array<(report: HealthReport) => void> = [];

  constructor(
    private readonly registry: HealthCheckRegistry,
    private readonly intervalMs: number = 30_000,
  ) {}

  onReport(listener: (report: HealthReport) => void): this {
    this.listeners.push(listener);
    return this;
  }

  getLastReport(): HealthReport | null {
    return this.lastReport;
  }

  async runOnce(): Promise<HealthReport> {
    const report = await this.registry.runAll();
    const previous = this.lastReport;
    this.lastReport = report;
    if (!previous || previous.status !== report.status) {
      for (const listener of this.listeners) {
        listener(report);
      }
    }
    return report;
  }

  start(): this {
    if (this.timer) return this;
    void this.runOnce();
    this.timer = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs);
    return this;
  }

  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * SDK metrics and statistics collection.
 *
 * Provides counters, gauges, and histograms registered in a central registry,
 * plus export and analysis helpers for monitoring.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricSnapshot {
  name: string;
  type: MetricType;
  value: number | HistogramSummary;
  labels?: Record<string, string>;
}

export interface HistogramSummary {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  percentiles: Record<string, number>;
}

export interface MetricAnalysis {
  totalMetrics: number;
  byType: Record<MetricType, number>;
  counters: Record<string, number>;
  gauges: Record<string, number>;
  histograms: Record<string, HistogramSummary>;
}

/** Monotonically increasing counter. */
export class Counter {
  readonly type: MetricType = 'counter';
  private value = 0;

  constructor(readonly name: string, readonly labels?: Record<string, string>) {}

  inc(amount: number = 1): this {
    if (amount < 0) {
      throw new Error(`Counter ${this.name} cannot be decremented`);
    }
    this.value += amount;
    return this;
  }

  get(): number {
    return this.value;
  }

  reset(): void {
    this.value = 0;
  }
}

/** Gauge that can be set, incremented, or decremented. */
export class Gauge {
  readonly type: MetricType = 'gauge';
  private value = 0;

  constructor(readonly name: string, readonly labels?: Record<string, string>) {}

  set(value: number): this {
    this.value = value;
    return this;
  }

  inc(amount: number = 1): this {
    this.value += amount;
    return this;
  }

  dec(amount: number = 1): this {
    this.value -= amount;
    return this;
  }

  get(): number {
    return this.value;
  }
}

/** Histogram with configurable buckets and summary statistics. */
export class Histogram {
  readonly type: MetricType = 'histogram';
  private readonly buckets: number[];
  private readonly counts: number[];
  private count = 0;
  private sum = 0;
  private min = Infinity;
  private max = -Infinity;
  private readonly samples: number[] = [];

  constructor(
    readonly name: string,
    buckets: number[] = [5, 10, 25, 50, 100, 250, 500, 1000],
    readonly labels?: Record<string, string>,
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.counts = new Array(this.buckets.length + 1).fill(0);
  }

  observe(value: number): this {
    this.count++;
    this.sum += value;
    if (value < this.min) this.min = value;
    if (value > this.max) this.max = value;
    this.samples.push(value);
    let idx = this.buckets.length;
    for (let i = 0; i < this.buckets.length; i++) {
      if (value <= this.buckets[i]!) {
        idx = i;
        break;
      }
    }
    this.counts[idx]!++;
    return this;
  }

  summary(percentiles: number[] = [50, 90, 95, 99]): HistogramSummary {
    const sorted = [...this.samples].sort((a, b) => a - b);
    const pct: Record<string, number> = {};
    for (const p of percentiles) {
      if (sorted.length === 0) {
        pct[`p${p}`] = 0;
        continue;
      }
      const rank = Math.ceil((p / 100) * sorted.length) - 1;
      pct[`p${p}`] = sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]!;
    }
    return {
      count: this.count,
      sum: this.sum,
      min: this.count === 0 ? 0 : this.min,
      max: this.count === 0 ? 0 : this.max,
      mean: this.count === 0 ? 0 : this.sum / this.count,
      percentiles: pct,
    };
  }

  bucketCounts(): number[] {
    return [...this.counts];
  }
}


// Connection Pooling (#1136)
export { RpcConnectionPool } from "./connectionPool.js";
export type { ConnectionPoolConfig, PoolStats, ManagedConnection } from "./connectionPool.js";

// Request Debouncing (#1137)
export { RequestDebouncer } from "./requestDebouncer.js";
export type { DebounceConfig } from "./requestDebouncer.js";

// Memory Optimization (#1138)
export { ObjectPool, MemoryOptimizer } from "./memoryOptimizer.js";
export type { MemoryReport } from "./memoryOptimizer.js";

// Streaming Datasets (#1139)
export { StreamingDatasetIterator } from "./streamingDataset.js";
export type { PageResult, StreamingDatasetOptions } from "./streamingDataset.js";
