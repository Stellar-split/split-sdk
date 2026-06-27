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

export {
  formatAmount,
  parseAmount,
  isValidAddress,
  deadlineFromDays,
  isExpired,
  truncateAddress,
} from "./utils.js";

export { pollUSDCBalance, initPoller } from "./poller.js";

export { telemetry } from "./telemetry.js";
export { TelemetryCollector } from "./telemetryCollector.js";
export type { TelemetryReport } from "./telemetryCollector.js";
export { DIContainer } from "./container.js";
export type { IRPCClient, ICacheStore, IWalletAdapter } from "./container.js";
export { PaymentAggregator } from "./paymentAggregator.js";
export type {
  PaymentLedger,
  PaymentSnapshot,
  PaymentSnapshotPayer,
  PaymentSnapshotPayment,
  PaymentSummary,
  TopPayer,
} from "./paymentAggregator.js";
export type { PaymentValidation } from "./paymentValidator.js";

export { generateGraphQLSchema } from "./graphql.js";

export { registerWebhook, triggerWebhook } from "./webhook.js";
export { validateWebhookSignature } from "./webhookValidator.js";
export type { WebhookConfig, WebhookEvent } from "./webhook.js";

export {
  detectContractFeatures,
  clearFeatureCache,
} from "./featureDetection.js";

export { ExportPipeline } from "./exportPipeline.js";
export type { PipelineStage, PipelineSink } from "./exportPipeline.js";

export type { WalletAdapter } from "./adapters/types.js";
export { WalletConnectAdapter } from "./adapters/walletconnect.js";

export { validateTransition } from "./stateMachineValidator.js";

export {
  addRequestInterceptor,
  addResponseInterceptor,
} from "./interceptors.js";
export { verifyBatchPayments } from "./batchVerifier.js";
export type {
  BatchVerificationResult,
  BatchInvoiceValidation,
  VerifyBatchPayResult,
} from "./batchVerifier.js";
export { createRequestSigningInterceptor } from "./requestSigner.js";
export type {
  RequestInterceptor,
  ResponseInterceptor,
  RPCRequest,
  RPCResponse,
} from "./interceptors.js";

export { diffInvoice } from "./diff.js";

export { getSDKHealth, resetSDKHealth } from "./healthDashboard.js";

export { getInvoiceAtTime } from "./timeMachine.js";
export { NotificationCenter } from "./notificationCenter.js";
export {
  renderTemplate,
  builtInNotificationTemplates,
} from "./notificationTemplates.js";
export type {
  InvoiceEvent,
  InvoiceEventType,
} from "./notificationTemplates.js";
export { LoadBalancer } from "./loadBalancer.js";
export type { EndpointState, LoadBalancerOptions } from "./loadBalancer.js";

export { AutoRecoveryMonitor } from "./autoRecovery.js";
export type { AutoRecoveryOptions } from "./autoRecovery.js";

export { generateReceiptPdf } from "./pdfReceipt.js";

export { estimateOperationCost } from "./feeEstimator.js";
export type { FeeEstimate, FeeEstimateError } from "./feeEstimator.js";

export { AclManager } from "./accessControl.js";
export type { AsyncAclStore } from "./accessControl.js";
export {
  generateFlowDiagram,
  registerInvoiceFlowFetcher,
} from "./flowVisualizer.js";
export type { InvoiceFlowFetcher } from "./flowVisualizer.js";
export {
  compressPayload,
  decompressPayload,
  createCompressionRequestInterceptor,
  createCompressionResponseInterceptor,
} from "./compression.js";
export type {
  CompressionAlgorithm,
  CompressionConfig,
  CompressionPayload,
  CompressedPayload,
} from "./compression.js";

export {
  StellarSplitError,
  InvoiceNotFoundError,
  InvoiceNotPendingError,
  DeadlinePassedError,
  PaymentExceedsRemainingError,
  InvoiceFrozenError,
  CoCreatorApprovalNotRequiredError,
  ChainTooDeepError,
  CircularPrerequisiteError,
  ForwardChainTooDeepError,
  UnauthorizedError,
  parseSorobanError,
  NftGateRequiredError,
} from "./errors.js";

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
  InvoiceDiff,
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

// Merkle proof functionality
export { generateMerkleProof, verifyMerkleProof } from "./merkle.js";
export type { MerkleProof } from "./merkle.js";

// Connection multiplexer functionality
export { MultiplexedClient } from "./multiplexer.js";
export type { WeightedEndpoint } from "./multiplexer.js";

// Request batcher functionality
export { RequestBatcher } from "./requestBatcher.js";
export type { BatcherConfig } from "./requestBatcher.js";

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
  ConfigValidationError,
} from "./configValidator.js";
export type {
  ConfigValidation,
  ConfigValidationError as ConfigValidationErrorType,
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
