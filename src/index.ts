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
  isStellarSplitError,
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
  TooManySubscriptionsError,
  isTooManySubscriptionsError,
  RequestTimeoutError,
  isRequestTimeoutError,
} from "./errors.js";
export { getScheduledReleaseCountdown } from "./client.js";
export { verifyCompletionProof } from "./client.js";
export { MultiTenantClient } from "./multiTenant.js";
export { ProfilerSession } from "./profiler.js";
export type { ProfileReport } from "./profiler.js";
export { enrichInvoice, registerInvoiceFetcher } from "./enricher.js";
export type { EnrichedInvoice } from "./enricher.js";

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

export { connectWallet, getPublicKey, signTransaction } from "./wallet.js";

export { checkRPCHealth } from "./health.js";
export { FallbackChain, FallbackExhaustedError } from "./fallbackChain.js";
export { groupInvoicesByPattern } from "./smartGrouping.js";
export type { InvoiceCluster } from "./smartGrouping.js";

export { getOptimisticInvoice } from "./optimistic.js";

export { watchContractUpgrade } from "./upgrade.js";

export { calculateFee } from "./fee.js";

export { resolveToken } from "./token.js";

export { watchExpiry } from "./watcher.js";

export { DeadlineEngine } from "./deadlineEngine.js";

export { StellarSplitTxBuilder } from "./txBuilder.js";

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
} from "./types.js";
export { InvalidTransitionError } from "./types.js";

// Per-method timeout (Issue #1)
export { TimeoutManager, withTimeout, RequestTimeoutError as TimeoutError } from "./timeout.js";
export type { TimeoutConfig } from "./timeout.js";

// Trace IDs (Issue #2)
export { TraceIdManager, globalTraceIdManager } from "./traceId.js";
export type { TraceIdGenerator } from "./traceId.js";

// Injectable RpcClient (Issue #3)
export { SorobanRpcAdapter } from "./rpcClient.js";
export type { RpcClient } from "./rpcClient.js";

export { negotiateVersion, SDK_CONTRACT_VERSION } from "./version.js";
export type { VersionInfo } from "./types.js";

export { checkPayerReadiness } from "./preflightChecker.js";
export type { PayerReadinessResult, PayerReadinessReason } from "./preflightChecker.js";

export { getSuggestion } from "./errorSuggestions.js";

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
} from "./receipt.js";

// Merkle proof functionality
export { generateMerkleProof, verifyMerkleProof } from "./merkle.js";
export type { MerkleProof } from "./merkle.js";

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
} from "./claimableBalanceFallback.js";
export type {
  ClaimableRefundResult,
  ClaimableRefundEntry,
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
} from "./types.js";
