/**
 * @stellar-split/sdk — public API (core exports)
 */

import type { Invoice } from "./types.js";
import type { StellarSplitClientConfig } from "./client.js";
import type { ExportFormat } from "./export.js";

export { StellarSplitClient } from "./client.js";
export type { StellarSplitClientConfig, NetworkConfig, TxResult } from "./client.js";
export { MultiTenantClient } from "./multiTenant.js";
export { ProfilerSession } from "./profiler.js";
export type { ProfileReport } from "./profiler.js";
export { enrichInvoice, registerInvoiceFetcher } from "./enricher.js";
export type { EnrichedInvoice } from "./enricher.js";

export { Deduplicator } from "./dedup.js";

export { TxQueue } from "./queue.js";

export { replayEvents } from "./events.js";
export { CircuitBreakerMonitor, defaultCircuitBreakerMonitor } from "./circuitBreakerMonitor.js";

export { connectWallet, getPublicKey, signTransaction } from "./wallet.js";

export { checkRPCHealth } from "./health.js";

export { getOptimisticInvoice } from "./optimistic.js";

export { watchContractUpgrade } from "./upgrade.js";

export { calculateFee } from "./fee.js";

export { resolveToken } from "./token.js";

export { watchExpiry } from "./watcher.js";

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

export { detectContractFeatures, clearFeatureCache } from "./featureDetection.js";

export { ExportPipeline } from "./exportPipeline.js";
export type { PipelineStage, PipelineSink } from "./exportPipeline.js";

export type { WalletAdapter } from "./adapters/types.js";
export { WalletConnectAdapter } from "./adapters/walletconnect.js";
export { LedgerAdapter } from "./adapters/ledger.js";

export { subscribeToInvoice } from "./stream.js";

export { validateTransition } from "./stateMachineValidator.js";

export {
  addRequestInterceptor,
  addResponseInterceptor,
} from "./interceptors.js";
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
  StellarSplitError,
  InvoiceNotFoundError,
  InvoiceNotPendingError,
  DeadlinePassedError,
  PaymentExceedsRemainingError,
  InvoiceFrozenError,
  parseSorobanError,
} from "./errors.js";

export { SimpleCache } from "./cache.js";

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
} from "./types.js";
export { InvalidTransitionError } from "./types.js";

export { LedgerAdapter } from "./adapters/ledger.js";

export { negotiateVersion, SDK_CONTRACT_VERSION } from "./version.js";
export type { VersionInfo } from "./types.js";
// ---------------------------------------------------------------------------
// Lazy factories for heavy modules
// ---------------------------------------------------------------------------

export async function getExportModule(): Promise<typeof import("./export.js")> {
  return await import("./export.js");
}

export async function exportInvoice(invoice: Invoice, format: ExportFormat): Promise<string> {
  const m = await getExportModule();
  return m.exportInvoice(invoice, format);
}

export async function getProofModule(): Promise<typeof import("./proof.js")> {
  return await import("./proof.js");
}

export async function generatePaymentProof(
  txHash: string,
  config: StellarSplitClientConfig
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

export { ScheduledPaymentManager } from "./scheduler.js";
export type { ScheduledPayment } from "./scheduler.js";

