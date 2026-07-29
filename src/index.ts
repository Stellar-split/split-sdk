/**
 * @stellar-split/sdk — public API (core exports)
 */

import type { Invoice } from "./types.js";
import type { StellarSplitClientConfig } from "./client.js";
import type { ExportFormat } from "./export.js";

export { StellarSplitClient } from "./client.js";
export type {
  StellarSplitClientConfig,
  NetworkConfig,
  TxResult,
  StellarSplitPlugin,
} from "./client.js";

export type {
  TelemetryHooks,
  TelemetryErrorContext,
  TelemetryCallStartParams,
  TelemetryCallEndParams,
} from "./telemetryHooks.js";

export { PluginRegistry, LoggingPlugin } from "./plugin.js";
export type { SdkPlugin, SdkMethodName, PluginArgs, PluginResult } from "./plugin.js";

export {
  serializeInvoiceTemplate,
  deserializeInvoiceTemplate,
} from "./invoiceTemplate.js";
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
  ChannelReconciliationError,
  SequenceCacheError,
  SequenceNumberTooOldError,
  PathNotFoundError,
  PathRouterError,
  OfferTrackingError,
  ClaimableBalanceLifecycleError,
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
  HorizonErrorClassification,
} from "./errors.js";

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
export {
  enrichInvoice,
  enrichInvoices,
  registerInvoiceFetcher,
  hasIPFSMetadata,
  getInvoiceMetadataCID,
} from "./enricher.js";
export type { EnrichedInvoice, EnrichOptions } from "./enricher.js";

// IPFS functionality
export {
  pinInvoiceMetadata,
  verifyCID,
  verifyCIDOrThrow,
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

export { Deduplicator } from "./dedup.js";

export { TxQueue } from "./queue.js";

export { replayEvents } from "./events.js";
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

export { checkRPCHealth } from "./health.js";
export { FallbackChain, FallbackExhaustedError } from "./fallbackChain.js";

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

export { resolveToken } from "./token.js";

export { watchExpiry } from "./watcher.js";

export { DeadlineEngine } from "./deadlineEngine.js";

export { StellarSplitTxBuilder } from "./txBuilder.js";

export { SequenceCache, isSequenceTooOld } from "./sequenceCache.js";
export type { SequenceCacheConfig } from "./sequenceCache.js";

export { PathRouter } from "./pathRouter.js";
export type { PathResult, PathHop, PathRequest, PathRouterConfig } from "./pathRouter.js";

export { OfferTracker } from "./offerTracker.js";
export type { OfferTrackerConfig, OfferTrackerEventMap } from "./offerTracker.js";

export { SimpleCache } from "./cache.js";
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
  DecodedTransactionMeta,
  DecodedLedgerEntry,
  DecodedOperation,
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
export { TraceIdManager, globalTraceIdManager } from "./traceId.js";
export type { TraceIdGenerator } from "./traceId.js";

// Injectable RpcClient (Issue #3)
export { SorobanRpcAdapter } from "./rpcClient.js";
export type { RpcClient } from "./rpcClient.js";

export { negotiateVersion, SDK_CONTRACT_VERSION } from "./version.js";
export type { VersionInfo } from "./types.js";

export { checkPayerReadiness, checkInvoiceExpiry, checkSponsorReserve } from "./preflightChecker.js";
export type { PayerReadinessResult, PayerReadinessReason, InvoiceExpiryResult, InvoiceExpiryReason, SponsorReserveCheck } from "./preflightChecker.js";

export { getSuggestion } from "./errorSuggestions.js";

// ---------------------------------------------------------------------------
// XDR Decoder — structured logging of Stellar XDR
// ---------------------------------------------------------------------------

export { decodeXDR } from "./xdrDecoder.js";

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

// ---------------------------------------------------------------------------
// Stream + SSE subscription helpers
// ---------------------------------------------------------------------------

// Real-time invoice event subscription (Issue #417)
export { createInvoiceSubscription } from "./subscription.js";
export type {
  SubscriptionLifecycleCallback,
  InvoiceEventCallback,
} from "./subscription.js";
export {
  isInvoicePaymentEvent,
  isInvoiceReleasedEvent,
  isInvoiceRefundedEvent,
  isInvoiceCancelledEvent,
  isInvoiceFrozenEvent,
  isInvoiceUnfrozenEvent,
  isInvoiceCreatedEvent,
} from "./subscription.js";
export type {
  InvoiceEvent,
  InvoiceCreatedEvent,
  InvoicePaymentEvent,
  InvoiceReleasedEvent,
  InvoiceRefundedEvent,
  InvoiceCancelledEvent,
  InvoiceFrozenEvent,
  InvoiceUnfrozenEvent,
  DisputeOpenedEvent,
  DisputeResolvedEvent,
  SplitRulesUpdatedEvent,
  AutoResolveRulesUpdatedEvent,
  VelocityLimitUpdatedEvent,
  PrerequisiteAddedEvent,
  PrerequisiteRemovedEvent,
  ForwardChainCreatedEvent,
  ScheduledReleaseSetEvent,
  PenaltyTiersUpdatedEvent,
  AllowedCallersUpdatedEvent,
  NftGateSetEvent,
  NftGateRemovedEvent,
  BaseInvoiceEvent,
  Subscription,
  SubscriptionOptions,
  SubscriptionLifecycleEvent,
  // New: AMM Calculator
  PoolSwapEstimate,
  PoolShareResult,
  // New: Timeout Escalation
  EscalationStep,
  TimeoutPolicy,
} from "./types.js";

export { analyzeCohorts } from "./cohortAnalyzer.js";
export type { CohortBucket } from "./cohortAnalyzer.js";

export {
  recordWebhookEvent,
  replayWebhook,
  configureReplayStore,
  RingBufferStore,
  WebhookEventNotFoundError,
} from "./webhookReplay.js";
export type { WebhookRecord, WebhookReplayStore } from "./webhookReplay.js";

// Webhook middleware for receiving and verifying incoming webhooks
export {
  createWebhookMiddleware,
  generateWebhookSignature,
  verifyWebhookSignature,
  parseWebhookPayload,
  isValidEventType,
  isWebhookRequest,
  InvalidSignatureError,
  TimestampOutOfBoundsError,
  ReplayAttackError,
  MissingHeaderError,
  InvalidPayloadError,
  WebhookValidationError,
} from "./webhookMiddleware.js";
export type {
  WebhookOptions,
  InvoiceEventType,
  WebhookPayload,
  WebhookRequest,
  RequestHandler,
  InvoiceCreatedData,
  InvoicePaidData,
  InvoiceReleasedData,
  InvoiceFailedData,
  InvoiceRefundedData,
  InvoiceCancelledData,
  InvoiceExpiredData,
} from "./webhookMiddleware.js";
// ---------------------------------------------------------------------------
// Lazy factories for heavy modules
// ---------------------------------------------------------------------------



export async function getExportModule(): Promise<typeof import("./export.js")> {
  return await import("./export.js");
}

export async function exportInvoice(
  invoice: Invoice,
  format: ExportFormat,
): Promise<string> {
  const m = await getExportModule();
  return m.exportInvoice(invoice, format);
}

export async function getProofModule(): Promise<typeof import("./proof.js")> {
  return await import("./proof.js");
}

export async function generatePaymentProof(
  txHash: string,
  config: StellarSplitClientConfig,
): Promise<import("./proof.js").PaymentProof> {
  const m = await getProofModule();
  return m.generatePaymentProof(txHash, config);
}

// Payment receipt generator
export {
  compilePaymentReceipt,
  generatePaymentReceipt,
  serializePaymentReceipt,
  deserializePaymentReceipt,
} from "./receipt.js";
export type {
  PaymentReceipt,
  PaymentReceiptJSON,
  InvoiceFetcher,
  ReceiptConfig,
} from "./receipt.js";

// Transaction operation effect aggregator
export { aggregateEffects } from "./effectAggregator.js";
export type { AccountEffectSummary, AssetDelta } from "./types.js";

// Merkle proof functionality
export { generateMerkleProof, verifyMerkleProof } from "./merkle.js";
export type { MerkleProof } from "./merkle.js";

// Simulation sandbox — fork ledger state via simulateTransaction and run
// sequences of SDK operations against it without touching the network.
export { SimulationSandbox } from "./sandbox/SimulationSandbox.js";
export type {
  SandboxClient,
  SimulationCost,
  SimulationResult,
  SandboxInvoiceRecord,
  SandboxPaymentRecord,
  SandboxCallLogEntry,
  SandboxLedgerDiff,
} from "./sandbox/SimulationSandbox.js";

// Horizon SSE stream manager — cursor-bookmarked payments/operations
// streaming with reconnect-and-resume, dedupe, and replay cutoff.
export {
  HorizonStreamManager,
  InMemoryCursorStore,
  createLocalStorageCursorStore,
  createSessionStorageCursorStore,
  DEFAULT_REPLAY_CUTOFF_MS,
  DEFAULT_DEDUPE_BUFFER_SIZE,
  DEFAULT_RECONNECT_DELAY_MS,
} from "./horizon/HorizonStreamManager.js";
export type {
  HorizonStreamRecord,
  HorizonCallBuilderLike,
  HorizonStreamSource,
  CursorStore,
  HorizonStreamKind,
  HorizonStreamManagerConfig,
  HorizonStreamEventMap,
} from "./horizon/HorizonStreamManager.js";

// Adaptive rate-limit throttle — sizes a token bucket from observed
// X-RateLimit-* headers and backs off further on 429s.
export {
  AdaptiveThrottle,
  DEFAULT_PENALTY_DURATION_MS,
} from "./throttle/AdaptiveThrottle.js";
export type { AdaptiveThrottleConfig, ThrottleStats } from "./throttle/AdaptiveThrottle.js";
export { parseRateLimitHeaders } from "./throttle/RateLimitParser.js";
export type { HeadersLike, RateLimitInfo } from "./throttle/RateLimitParser.js";

// Receipt chain — SHA-256-linked, tamper-evident payment receipt history
// per invoice. `PaymentReceipt` is aliased to `ChainPaymentReceipt` here to
// avoid colliding with the unrelated `PaymentReceipt` already exported from
// receipt.js (a compiled multi-payment summary receipt).
export {
  ReceiptChain,
  GENESIS_PREV_HASH,
  InMemoryReceiptChainStorage,
  createLocalStorageReceiptChainStorage,
  createSessionStorageReceiptChainStorage,
  receiptChainStorageKey,
} from "./receipts/ReceiptChain.js";
export type { ReceiptChainStorage } from "./receipts/ReceiptChain.js";
export type {
  PaymentReceipt as ChainPaymentReceipt,
  ReceiptChainEntry,
  ChainVerificationResult,
} from "./types/receipts.js";

// Connection multiplexer functionality
export { MultiplexedClient } from "./multiplexer.js";
export type { WeightedEndpoint } from "./multiplexer.js";

// Connection pool (issue #360): up to 5 persistent HTTP/2 connections to the
// primary Soroban RPC endpoint with least-busy selection, 60s idle recycle,
// and per-slot stats.
export {
  ConnectionPool,
  MAX_POOL_SIZE,
  DEFAULT_IDLE_TIMEOUT_MS,
  DEFAULT_POOL_SIZE,
} from "./connectionPool.js";
export type {
  ConnectionPoolConfig,
  PoolStats,
  PoolSlotStats,
  PooledServer,
} from "./connectionPool.js";

// Request batcher functionality
export { RequestBatcher, BatchedRpcClient } from "./requestBatcher.js";
export type { BatcherConfig, BatchFetchers, BatchCallType } from "./requestBatcher.js";

export type { ComplianceReport } from "./compliance.js";

export { exportComplianceReport, CSV_COLUMNS } from "./complianceExporter.js";
export type {
  ComplianceExportRecord,
  ComplianceExportOptions,
  ComplianceExportResult,
} from "./complianceExporter.js";

export { ScheduledPaymentManager } from "./scheduler.js";
export type { ScheduledPayment } from "./scheduler.js";

export { compileFilter, applyFilter, FilterIndex } from "./invoiceFilter.js";
export type { FilterCriteria, CompiledFilter } from "./invoiceFilter.js";

// Invoice diff utility
export { diffInvoices, hasDiff } from "./diff.js";
export type { InvoiceDiff, InvoiceDiffEntry } from "./diff.js";

export { diffSimulations } from "./simulationDiff.js";
export type {
  SimulationDiff,
  SimulationDiffSuccess,
  SimulationDiffNotComparable,
  ResourceDelta,
} from "./simulationDiff.js";

// Payment velocity tracking
export { trackVelocity } from "./velocityTracker.js";
export type { VelocityReport, InvoiceVelocity, PaymentTrend } from "./velocityTracker.js";
export type { VelocityStatus, VelocityWindowStatus } from "./types.js";

// Tranche release progress tracking
export { getTrancheProgress } from "./trancheProgress.js";
export type {
  TrancheProgress,
  TrancheProgressReport,
  TrancheProgressOptions,
  TrancheConfig,
  TranchedInvoice,
  TrancheStatus,
} from "./trancheProgress.js";
export { Sep41Adapter, createSep41Adapter } from "./sep41Adapter.js";
export type { Sep41TokenCapabilities } from "./sep41Adapter.js";

export { HorizonFallbackReader } from "./horizonFallback.js";
export type { NormalizedAccount, NormalizedBalance } from "./horizonFallback.js";

export {
  buildSponsoredOnboarding,
  MissingSponsorAccountError,
  InsufficientReserveError,
  checkSponsorshipReserve,
} from "./sponsorship.js";

export {
  extendStorageTtl,
  buildContractDataLedgerKey,
  buildInvoiceDataLedgerKey,
  buildInvoiceStorageKey,
} from "./ttlExtension.js";
export type {
  TtlExtensionOptions,
  TtlExtensionResult,
} from "./ttlExtension.js";

export {
  diffTemplate,
  migrateTemplate,
  migrateAllTemplates,
} from "./templateMigration.js";
export type {
  TemplateDiff,
  TemplateDiffField,
} from "./templateMigration.js";

export {
  validateClientConfig,
  validateOrThrow,
  InvalidConfigError,
} from "./configValidator.js";
export type {
  ConfigValidation,
  ConfigValidationErrorType,
} from "./configValidator.js";

export { FundingVelocityAlert } from "./velocityAlert.js";
export type {
  VelocityAlert,
  VelocityAlertKind,
  VelocityConfig,
} from "./velocityAlert.js";

export {
  createClaimableRefund,
  getClaimableRefunds,
  isRefundTransferError,
  ClaimableBalanceLifecycle,
} from "./claimableBalanceFallback.js";
export type {
  ClaimableRefundResult,
  ClaimableRefundEntry,
  ClaimableBalanceLifecycleConfig,
  ClaimableBalanceLifecycleEventMap,
} from "./claimableBalanceFallback.js";

export { subscribeToInvoice } from "./sse.js";
export type {
  SSEInvoiceEventType,
  SSEInvoiceEvent,
  InvoiceEventHandler,
  SubscribeToInvoiceOptions,
  EventSourceLike,
} from "./sse.js";
export type { PollingInvoiceEventHandler } from "./stream.js";

// WebSocket transport (Issue #377)
export { WebSocketTransport } from "./websocket.js";
export type { TransportType, TransportStatus, TransportEventMap } from "./websocket.js";
export {
  bundleDisputeEvidence,
  computeBundleChecksum,
  verifyBundleChecksum,
  registerProofFetcher,
  registerAuditLogFetcher,
  registerEventFetcher,
} from "./disputeEvidenceBundler.js";
export type {
  DisputeEvidenceBundle,
  ProofFetcher,
  AuditLogFetcher,
  EventFetcher,
} from "./disputeEvidenceBundler.js";

export { UsageAnalyticsCollector, wrapWithAnalytics } from "./usageAnalytics.js";
export type {
  UsageAnalyticsConfig,
  FeatureCountSnapshot,
} from "./usageAnalytics.js";
export { IdempotencyManager } from "./idempotency.js";
export type { IdempotencyConfig } from "./idempotency.js";

export {
  validateInvoicePayload,
  PayloadSizeError,
} from "./payloadGuard.js";
export type {
  PayloadGuardConfig,
  PayloadViolation,
} from "./payloadGuard.js";

export { computeCreatorReputation } from "./reputation.js";
export type {
  CreatorReputationScore,
  ReputationConfig,
} from "./reputation.js";

export { computePaymentForecast } from "./forecast.js";
export type {
  PaymentForecast,
  ForecastConfig,
  HistoricalInvoiceSample,
} from "./forecast.js";

// ---------------------------------------------------------------------------
// Split ratio validator
// ---------------------------------------------------------------------------

export { validateSplitRatios, validateSplitRatiosOrThrow, ratiosToRecipients } from "./validators/splitRatioValidator.js";
export type {
  RecipientShare,
  SplitConfig,
  SplitRatioValidationResult,
} from "./validators/splitRatioValidator.js";

// ---------------------------------------------------------------------------
// Trustline checker
// ---------------------------------------------------------------------------

export { checkTrustlines, checkSingleTrustline } from "./trustlineChecker.js";
export type { TrustlineEntry, TrustlineCheckResult } from "./trustlineChecker.js";

// ---------------------------------------------------------------------------
// XDR parser
// ---------------------------------------------------------------------------

export { parseEnvelope } from "./xdrParser.js";
export type {
  ParsedEnvelope,
  ParsedTransaction,
  ParsedOperation,
  ParsedMemo,
  ParsedSignature,
  ParsedTimeBounds,
} from "./xdrParser.js";

// ---------------------------------------------------------------------------
// Fee surge detector
// ---------------------------------------------------------------------------

export { detectFeeSurge, clearFeeSurgeCache } from "./feeSurgeDetector.js";
export type { FeeSurgeConfig, FeeRecommendation, CongestionLevel } from "./feeSurgeDetector.js";

export {
  reconcileChannel,
  registerChannelStateFetcher,
} from "./channelReconciler.js";
export type {
  ChannelState,
  ChannelReconciliationResult,
  ChannelStateFetcher,
} from "./channelReconciler.js";
export { getInvoiceStats, computeInvoiceStats } from "./invoiceStats.js";

export { previewSplitRules } from "./splitPreview.js";

export { simulateAutoResolve } from "./autoResolveSimulator.js";

export {
  resolvePrerequisiteChain,
  MAX_PREREQUISITE_CHAIN_DEPTH,
} from "./prerequisiteChain.js";

export type {
  SplitRule,
  SplitPreviewEntry,
  AutoResolveRule,
  AutoResolveSimulation,
  InvoiceStats,
  PrerequisiteChainEntry,
  PedersenCommitment,
  BlindingFactorStorageConfig,
  StoredBlindingFactor,
  RevealPaymentOptions,
  LineItem,
  InvoiceMetadata,
  IPFSConfig,
  CIDVerificationResult,
} from "./types.js";

// ---------------------------------------------------------------------------
// UI Components (React)
// ---------------------------------------------------------------------------

export type {
  DisputePanelProps,
  DisputeEvidenceItem,
} from "./ui/DisputePanel.js";

export type {
  DisputeTimelineProps,
  DisputeTimelineEvent,
  DisputeEventType,
} from "./ui/DisputeTimeline.js";

export type {
  InvoiceDetailPageProps,
} from "./ui/InvoiceDetailPage.js";

export type {
  UseInvoiceStreamOptions,
  UseInvoiceStreamResult,
} from "./ui/hooks/useInvoiceStream.js";

// Note: Actual React components are exported from ./ui/index for tree-shaking
// Import them like: import { DisputePanel } from '@stellar-split/sdk/ui'


// ---------------------------------------------------------------------------
// Cross-chain bridge payment helpers
// ---------------------------------------------------------------------------

export {
  estimateBridgeFee,
  buildBridgePayment,
  submitBridgePayment,
  computePayloadHash,
  DEFAULT_CHAIN_CONFIGS,
} from "./bridge.js";

export type { ChainBridgeConfig, BridgeConfig } from "./bridge.js";

export type {
  ChainId,
  BridgeFeeEstimate,
  BridgePaymentParams,
  BridgePaymentRequest,
  SignedBridgeProof,
} from "./types.js";

// Timeline reconstructor
export { PaymentTimelineReconstructor } from "./timeline/PaymentTimelineReconstructor.js";
export type {
  TimelineEntry,
  TimelineEventType,
  TimelineSource,
  ReconstructedTimeline,
  RebuildOptions,
} from "./types/timeline.js";
export type { PaymentTimelineReconstructorConfig } from "./timeline/PaymentTimelineReconstructor.js";
// ---------------------------------------------------------------------------
// Streaming subscriptions (SubscriptionManager)
// ---------------------------------------------------------------------------

export { SubscriptionManager, getSubscriptionManager } from "./streaming/SubscriptionManager.js";
export type { EventCursor, SubscriptionManagerLifecycleEvent } from "./types/events.js";
export type { SubscriptionOptions as SubscriptionManagerOptions } from "./types/events.js";
export { createStorageAdapter, MemoryStorageAdapter } from "./storage/storageAdapter.js";
export type { StorageAdapter, StorageKind } from "./storage/storageAdapter.js";

// ---------------------------------------------------------------------------
// Resilience (advanced CircuitBreaker)
// ---------------------------------------------------------------------------

export { CircuitBreaker as AdvancedCircuitBreaker } from "./resilience/CircuitBreaker.js";
export type {
  CircuitState as AdvancedCircuitState,
  CircuitBreakerOptions as AdvancedCircuitBreakerOptions,
  CircuitBreakerStateSnapshot as AdvancedCircuitBreakerStateSnapshot,
  CircuitBreakerLogger as AdvancedCircuitBreakerLogger,
} from "./resilience/CircuitBreaker.js";

// ---------------------------------------------------------------------------
// Waterfall payment routing
// ---------------------------------------------------------------------------

export { WaterfallRouter } from "./routing/WaterfallRouter.js";
export type { WaterfallConfig, WaterfallTier, WaterfallPlan, WaterfallStep } from "./types/routing.js";

// ---------------------------------------------------------------------------
// Optimistic UI cache
// ---------------------------------------------------------------------------

export { OptimisticCache } from "./cache/OptimisticCache.js";
export type { RollbackEvent, OptimisticEntry } from "./cache/OptimisticCache.js";

// ---------------------------------------------------------------------------
// Typed, zero-dependency event emitter (works in Node, browser, and edge runtimes)
// ---------------------------------------------------------------------------

export { TypedEventEmitter, AbortError } from "./events/TypedEventEmitter.js";
export type { Unsubscribe, EventMap } from "./events/TypedEventEmitter.js";
export type { SplitClientEventMap } from "./client.js";

// ---------------------------------------------------------------------------
// Multi-endpoint RPC load balancing
// ---------------------------------------------------------------------------

export { RpcLoadBalancer } from "./rpc/RpcLoadBalancer.js";
export type {
  EndpointConfig,
  RpcLoadBalancerOptions,
  RpcEndpointServer,
  RpcLoadBalancerEventMap,
  EndpointSnapshot,
} from "./rpc/RpcLoadBalancer.js";

// ---------------------------------------------------------------------------
// Optional OpenTelemetry instrumentation (opt-in via `otel: { enabled: true }`;
// `@opentelemetry/api` is never required unless a consumer turns this on).
// ---------------------------------------------------------------------------

export { OtelExporter, createOtelHandle, noopOtelHandle } from "./telemetry/OtelExporter.js";
export type {
  TelemetryOptions,
  OtelHandle,
  OtelSpanHandle,
  OtlpTracePayload,
} from "./telemetry/OtelExporter.js";
// #476 — OperationBuilder: fluent multi-op envelope builder with dry-run
// ---------------------------------------------------------------------------

export { OperationBuilder } from "./builder/OperationBuilder.js";
export type {
  PaymentOptions as OperationBuilderPaymentOptions,
  InvokeHostFnOptions,
  BumpSequenceOptions,
  TimeboundsOptions,
  DryRunResult,
  SubmitOptions,
  OperationBuilderConfig,
} from "./builder/OperationBuilder.js";
export {
  EnvelopeLimitError,
  isEnvelopeLimitError,
  DryRunFailedError,
  isDryRunFailedError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// #477 — AccountSignerWeightCalculator: multi-sig pre-flight weight check
// ---------------------------------------------------------------------------

export { AccountSignerWeightCalculator } from "./accounts/AccountSignerWeightCalculator.js";
export type {
  ThresholdLevel,
  SignerWeightResult,
} from "./accounts/AccountSignerWeightCalculator.js";
export {
  InsufficientSignerWeightError,
  isInsufficientSignerWeightError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// #478 — PaymentDeduplicationFingerprinter: content-based payment dedup
// ---------------------------------------------------------------------------

export { PaymentDeduplicationFingerprinter } from "./deduplication/PaymentDeduplicationFingerprinter.js";
export type {
  DeduplicationPayment,
  CheckResult as DeduplicationCheckResult,
} from "./deduplication/PaymentDeduplicationFingerprinter.js";
export {
  DuplicatePaymentError,
  isDuplicatePaymentError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// #479 — LazyInitializer + SplitClient: on-demand RPC connection
// ---------------------------------------------------------------------------

export { LazyInitializer } from "./client/LazyInitializer.js";
export { SplitClient } from "./client/SplitClient.js";
export type { SplitClientConfig } from "./client/SplitClient.js";
export {
  RpcConnectionError,
  isRpcConnectionError,
} from "./errors.js";

// ---------------------------------------------------------------------------
// #483 — ContractStorageExporter: contract storage entry snapshot exporter
// ---------------------------------------------------------------------------

export { ContractStorageExporter, scValToJson } from "./diagnostics/ContractStorageExporter.js";
export type {
  ContractStorageSnapshot,
  StorageEntry,
  StorageDiff,
  StorageModification,
  ScValJson,
  ScValJsonPrimitive,
  ScValJsonVec,
  ScValJsonMap,
  ScValPrimitive,
  ContractStorageExporterOptions,
} from "./diagnostics/ContractStorageExporter.js";
