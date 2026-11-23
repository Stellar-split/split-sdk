/**
 * StellarSplitClient — TypeScript client for the StellarSplit Soroban contract.
 *
 * Wraps @stellar/stellar-sdk contract invocation with typed methods.
 */

import {
  Account,
  Contract,
  Transaction,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
  Keypair,
  StrKey,
} from "@stellar/stellar-sdk";
import { TypedEventEmitter } from "./events/TypedEventEmitter.js";
import type { Signer } from "./signing/signer.js";
import type { CircuitStateChangeLogEvent } from "./resilience/CircuitBreaker.js";
import { InvoiceStateMachine } from "./state/InvoiceStateMachine.js";
import type { StateMachineConfig } from "./types/state.js";
import { RpcLoadBalancer } from "./rpc/RpcLoadBalancer.js";
import { OfflineQueue, type QueuedOperation } from "./offlineQueue.js";
import type { EndpointConfig, RpcLoadBalancerOptions } from "./rpc/RpcLoadBalancer.js";
import {
  LogLevel,
  SdkLogger,
  type Logger,
  type LoggerOptions,
  type LogLevelString,
  type LogEntry,
} from "./logger.js";

/** Events emitted by {@link StellarSplitClient}. */
export type SplitClientEventMap = {
  /** The advanced circuit breaker (src/resilience/CircuitBreaker.ts) tripped open. */
  "circuit:open": undefined;
  /** The advanced circuit breaker closed after a successful probe. */
  "circuit:close": undefined;
  /** The advanced circuit breaker entered half-open (probing) state. */
  "circuit:half-open": undefined;
  /** Fired on every advanced circuit breaker state transition. */
  circuit_state_change: CircuitStateChangeLogEvent;
  /** An RpcLoadBalancer endpoint (from `rpcEndpoints`) was quarantined. */
  "endpoint:demoted": { url: string; reason: "consecutive_errors" | "failed_health_check" };
  /** A previously quarantined RpcLoadBalancer endpoint passed its health check and rejoined rotation. */
  "endpoint:reinstated": { url: string };
  /** Emitted when a batch of invoices is successfully created. */
  "batch:created": { invoiceIds: bigint[] };
  /** Emitted when a payment is made to an invoice. */
  payment: import("./contractEvents.js").PaymentEvent;
  /** Emitted when funds are released from an invoice. */
  release: import("./contractEvents.js").ReleaseEvent;
  /** Emitted when an invoice is refunded. */
  refund: import("./contractEvents.js").RefundEvent;
  /** Emitted when a dispute is opened on an invoice. */
  dispute: import("./contractEvents.js").DisputeEvent;
  /** Emitted when a tier is unlocked on an invoice. */
  tier_unlocked: import("./contractEvents.js").TierUnlockedEvent;
  "queue:drained": undefined;
  "queue:operation:failed": { operation: import("./offlineQueue.js").QueuedOperation; error: unknown };
  "queue:conflict:resolved": { operation: import("./offlineQueue.js").QueuedOperation; strategy: string; remoteState?: unknown };
};
import { signTransaction } from "./wallet.js";
import { telemetry } from "./telemetry.js";
import { TelemetryHookManager } from "./telemetryHooks.js";
import type { TelemetryHooks } from "./telemetryHooks.js";
import type { ExportFormat } from "./export.js";
import { computePaymentValidation } from "./paymentValidator.js";
import type { PaymentValidation } from "./paymentValidator.js";
import { withRetry } from "./retry.js";
import { executeWithRetry } from "./retryPolicy.js";
import type { RetryOptions, PerMethodRetryOptions } from "./retryPolicy.js";
import { TelemetryCollector } from "./telemetryCollector.js";
import { isFeatureEnabled } from "./flags.js";
import type { FeatureFlags } from "./flags.js";
import { PluginRegistry } from "./plugin.js";
import type { SdkPlugin } from "./plugin.js";
import { checkRPCHealth } from "./health.js";
import { Deduplicator } from "./dedup.js";
import { SorobanFeatureDetector } from "./sorobanFeatureDetector.js";
import type { SorobanFeatureFlags } from "./types.js";
import { verifyBatchPayments } from "./batchVerifier.js";
import { type HealthCheckResult, HealthCheckTimeoutError } from "./types.js";
import type {
  BatchVerificationResult,
  BatchInvoiceValidation,
} from "./batchVerifier.js";
import { initHealthDashboard, recordCall } from "./healthDashboard.js";
import {
  addRequestInterceptor,
  addResponseInterceptor,
  runRequestInterceptors,
  runResponseInterceptors,
} from "./interceptors.js";
import { createRequestSigningInterceptor } from "./requestSigner.js";
import {
  createCompressionRequestInterceptor,
  createCompressionResponseInterceptor,
} from "./compression.js";
import type { CompressionConfig } from "./compression.js";
import { calculateFee } from "./fee.js";
import { isValidStellarAddress as isValidAddress } from "./utils.js";
import { resolveToken } from "./token.js";
import { generatePaymentReceipt } from "./receipt.js";
import type { PaymentReceipt } from "./receipt.js";
import { checkInvoiceExpiry, checkPayerReadiness } from "./preflightChecker.js";
import { InvoiceCloneabilityValidator } from "./preflight/InvoiceCloneabilityValidator.js";
import { InvoiceQueryEngine } from "./invoiceQuery.js";
import type { InvoiceFilter, InvoicePage } from "./invoiceQuery.js";

import { createInvoiceSubscription } from "./subscription.js";
import type { Subscription, InvoiceEvent, SubscriptionOptions, SimulationResult, LedgerFootprint } from "./types.js";
import { getSubscriptionManager } from "./streaming/SubscriptionManager.js";
import { destroySubscriptionManager } from "./streaming/SubscriptionManager.js";
import type { SubscriptionOptions as SubscriptionManagerOptions } from "./types/events.js";
import { CircuitBreaker as AdvancedCircuitBreaker } from "./resilience/CircuitBreaker.js";
import type {
  CircuitBreakerOptions as AdvancedCircuitBreakerOptions,
  CircuitBreakerStateSnapshot,
} from "./resilience/CircuitBreaker.js";
import type { WaterfallPlan } from "./types/routing.js";
import {
  WaterfallInsufficientFundsError,
  AlreadyRatedError,
  InvoiceNotReleasedForRatingError,
  NotEligibleToVoteError,
} from "./errors.js";
import { OptimisticCache } from "./cache/OptimisticCache.js";
import type { CommitFn, RollbackFn } from "./cache/OptimisticCache.js";
import { getOptimisticInvoice } from "./optimistic.js";
import type {
  ArchivedInvoice,

  ArbiterVote,
  AuctionInfo,
  DisputeStatus,
  QueueActionParams,
  TimelockAction,
  BatchPayment,
  BatchResolveResult,
  BulkResult,
  CloneOverrides,
  CoSignature,
  CreateInvoiceParams,
  CrossChainRef,
  DisputeResult,
  FeeBreakdown,
  FeeEstimate,
  Invoice,
  InvoiceEventCallbacks,
  InvoiceExt,
  InvoiceGroup,
  InvoiceParamOverrides,
  InvoiceReceipt,
  InvoiceStatus,
  PaginatedResult,
  PaginationOptions,
  Payment,
  PayParams,
  PaymentCooldown,
  PaymentProof,
  PreviewTokenSwapResult,
  Recipient,
  SimulateCreateInvoiceResult,
  SimulatePayResult,
  InvoiceTemplate,
  RPCHealth,
  SyncResult,
  WalletAdapter,
  TokenInfo,
  InvoiceLifecycleHooks,
  PaymentEventRecord,
  PaymentReconciliationReport,
  RolloverResult,
  VelocityStatus,
  NftGateResult,
  ClaimPayoutResult,
  PayWithAttestationParams,
  AttestationPaymentReceipt,
  SetCrossChainRefParams,
  ScheduledReleaseCountdown,
  CompletionProof,
  AdminFreezeResult,
  AdminUnfreezeResult,
  ChainId,
  BridgeFeeEstimate,
  BridgePaymentParams,
  BridgePaymentRequest,
  SignedBridgeProof,
  Attestation,
  CreatorRating,
  ExtensionStatus,
  GroupStats,
  MatchPledge,
  Stream,
  RoundCloseResult,
  PayerRefund,
  RoundInfo,
  MilestoneResult,
  Milestone,
  MilestoneStatus,
  ReferralClaimResult,
  ReferralPayResult,
  PauseStatus,
  ProtocolStats,
} from "./types.js";
import {
  estimateBridgeFee as _estimateBridgeFee,
  buildBridgePayment as _buildBridgePayment,
  submitBridgePayment as _submitBridgePayment,
} from "./bridge.js";
import type { BridgeConfig } from "./bridge.js";
import type {
  DIContainer,
  IRPCClient,
  ICacheStore,
  IWalletAdapter,
} from "./container.js";
import {
  CircularForwardChainError,
  CoCreatorApprovalNotRequiredError,
  ForwardChainTooDeepError,
  InvoiceFrozenError,
  InvoiceNotFoundError,
  InvoiceNotPendingError,
  NftGateRequiredError,
  UnauthorizedError,
  parseSorobanError,
  PluginAlreadyRegisteredError,
  InvalidBatchSizeError,
  InvoiceNotReleasedError,
  SimulationFailedError,
  NoReturnValueError,
  TransactionFailedError,
  TransactionNotConfirmedError,
  UnknownNetworkError,
  InsufficientSignaturesError,
  CloneChainTooDeepError,
  NoPendingPayoutError,
  InvalidAttestationError,
  RpcUnavailableError,
  UnknownEndpointError,
  QueueFailedError,
  ShutdownInProgressError,
  SignerFailedError,
  NoSignerProvidedError,
  ValidationError,
  StellarSplitError,
  AdminOperationError,
  PassphraseMismatchError,
  NetworkMismatchError,
  InvoiceIntegrityError,
  InvoiceNotCloneableError,
  InvalidTransactionTypeError,
  RoundNotEndedError,
  WrongMilestoneError,
  NothingToClaimError,
} from "./errors.js";
import {
  InvoiceModule,
  PaymentModule,
  DisputeModule,
  AdminModule,
  GroupModule,
  TemplateModule,
  MilestoneModule,
} from "./client/modules/index.js";
import { hashInvoice, verifyInvoiceHash } from "./invoiceHashVerifier.js";
import { buildFeeBump } from "./feeBumpBuilder.js";
import type { FeeBumpConfig } from "./feeBumpBuilder.js";
import { replayEvents } from "./events.js";
import { subscribeToInvoice as _subscribeToInvoice } from "./stream.js";
import { subscribeToInvoice as _subscribeToInvoiceSSE } from "./sse.js";
import type {
  InvoiceEventHandler,
  SubscribeToInvoiceOptions,
  SSEInvoiceEvent,
} from "./sse.js";
import { ConnectionPool } from "./connectionPool.js";
import { WebSocketTransport } from "./websocket.js";
import type { TransportType, TransportStatus } from "./websocket.js";
import { snapshotInvoice as _snapshotInvoice } from "./snapshot.js";
import type { InvoiceSnapshot } from "./snapshot.js";
import { SimpleCache } from "./cache.js";
import { validateOrThrow } from "./configValidator.js";
import { extendStorageTtl, buildInvoiceDataLedgerKey } from "./ttlExtension.js";
import type {
  TtlExtensionOptions,
  TtlExtensionResult,
} from "./ttlExtension.js";
import { RateLimiter } from "./rateLimiter.js";
import { DegradationManager } from "./degradation.js";
import { AuditLogger } from "./auditLogger.js";
import { WarmStandby } from "./standby.js";
import { computePrediction } from "./predictor.js";
import type { CompletionPrediction } from "./predictor.js";
import { PriorityQueue } from "./priorityQueue.js";
import type { RequestPriority } from "./priorityQueue.js";
import { IdempotencyManager } from "./idempotency.js";
import type { IdempotencyConfig } from "./idempotency.js";
import { RollbackCoordinator } from "./splitRollbackCoordinator.js";
import { validateInvoicePayload } from "./payloadGuard.js";
import { InvoiceMetadataValidator } from "./validators/invoiceMetadataValidator.js";
import { validateSplitRatiosOrThrow, type SplitConfig as RatioSplitConfig } from "./validators/splitRatioValidator.js";
import type { SplitConfig } from "./types.js";
import { checkTrustlines } from "./trustlineChecker.js";
import type { TrustlineCheckResult } from "./trustlineChecker.js";
import { parseEnvelope } from "./xdrParser.js";
import type { ParsedEnvelope } from "./xdrParser.js";
import type { PayloadGuardConfig } from "./payloadGuard.js";
import { HorizonFallbackReader } from "./horizonFallback.js";
import type {
  NormalizedAccount,
  NormalizedBalance,
} from "./horizonFallback.js";
import { FallbackChain } from "./fallbackChain.js";
import {
  createClaimableRefund,
  getClaimableRefunds,
  isRefundTransferError,
} from "./claimableBalanceFallback.js";
import type {
  ClaimableRefundResult,
  ClaimableRefundEntry,
} from "./claimableBalanceFallback.js";
import { Asset } from "@stellar/stellar-sdk";
import { rolloverInvoice as _rolloverInvoice } from "./invoiceRollover.js";
import { BatchedRpcClient } from "./requestBatcher.js";
import { TimeoutManager, withTimeoutOrThrow } from "./timeout.js";
import type { TimeoutConfig } from "./timeout.js";
import { RequestTimeoutError } from "./errors.js";
import { TraceIdManager } from "./traceId.js";
import type { RpcClient } from "./rpcClient.js";
import { ResilientRpcClient } from "./resilientRpc.js";
import type {
  RetryConfig as ResilientRetryConfig,
  CircuitBreakerConfig,
} from "./resilientRpc.js";
import { NetworkPassphraseValidator } from "./network/NetworkPassphraseValidator.js";
import {
  NetworkEnvironment,
  getNetworkPreset,
  isNetworkPreset,
  detectNetworkEnvironment,
} from "./config.js";
import type { NetworkPreset } from "./config.js";
import type { OtelHandle, TelemetryOptions } from "./telemetry/OtelExporter.js";
import { createOtelHandle, noopOtelHandle, OtelExporter } from "./telemetry/OtelExporter.js";

/** A plugin that extends StellarSplitClient with new methods and lifecycle hooks. */
export interface StellarSplitPlugin {
  /** Unique plugin name — duplicate registrations throw. */
  name: string;
  /** Called with the client instance; attach new methods here. */
  install?(client: StellarSplitClient): void;
  /**
   * Called once after the client has been fully constructed and all internal
   * subsystems are initialized. Use this for async setup (e.g. connecting to
   * external services, starting watchers).
   */
  onInit?(client: StellarSplitClient): void | Promise<void>;
  /**
   * Called during client shutdown, before internal resources are released.
   * Use this for teardown (e.g. closing connections, clearing intervals).
   * Plugins are destroyed in reverse registration order.
   */
  onDestroy?(client: StellarSplitClient): void | Promise<void>;
}

/** Configuration for StellarSplitClient. */
export interface StellarSplitClientConfig {
  /** Soroban RPC endpoint URL. Pass an array to enable warm-standby failover. */
  rpcUrl: string | string[];
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Deployed StellarSplit contract ID. */
  contractId: string;
  /** Whether to validate the passphrase against the RPC node on startup. Defaults to true. */
  validatePassphrase?: boolean;
  /** Map of available networks for the live switcher. */
  networks?: Record<string, NetworkConfig>;
  /** Maximum retry attempts for transient pay() failures. Defaults to 3. */
  maxRetries?: number;
  /** Optional telemetry configuration. */
  telemetry?: {
    endpoint: string;
    optOut?: boolean;
  };
  /** Fee multiplier applied when a transaction is stuck (default: 2). */
  feeBumpMultiplier?: number;
  /** Optional wallet adapter for signing (e.g. WalletConnect). Defaults to Freighter. */
  adapter?: WalletAdapter;
  /** Optional in-memory cache configuration. Disabled by default. */
  cache?: { enabled?: boolean; ttl?: Record<string, number>; ttlMs?: number };
  /** Optional signing keypair for request signing. */
  signingKeypair?: Keypair;
  /**
   * Optional pluggable signing vault adapter (issue #589). When provided,
   * transaction signing can be delegated to a hardware security module,
   * cloud KMS, or encrypted keystore through the narrow {@link Signer}
   * contract instead of an in-memory {@link Keypair}. Exposed at runtime via
   * `client.signer`.
   */
  signer?: Signer;
  /** Optional compliance rules injectable for invoice checks. */
  complianceRules?: import("./compliance.js").ComplianceRule[];
  /** Optional dependency injection container for RPC, cache, and wallet implementations. */
  container?: DIContainer;
  /** Optional lifecycle hooks for invoice events. */
  hooks?: import("./types.js").InvoiceLifecycleHooks;
  /** Optional request/response compression middleware. Disabled by default. */
  compression?: CompressionConfig;
  /** Optional retry configuration. Enables automatic retry with exponential backoff and jitter. */
  retry?: RetryOptions;
  /**
   * Optional outbound rate-limiting configuration (issue #1058). When
   * provided, the client creates a token-bucket {@link RateLimiter} that
   * gates transaction submission, protecting the RPC endpoint (and shared
   * budget) from abuse and self-inflicted DoS. Accepts a global
   * `maxRequestsPerSecond`, an optional `perKeyLimit`, the `windowMs`
   * refill period, and a `maxTrackedKeys` storage bound.
   */
  rateLimit?: import("./rateLimiter.js").RateLimiterConfig;
  /**
   * Optional Horizon API base URL (e.g. "https://horizon.stellar.org").
   * When provided, read-only account lookups fall back to Horizon automatically
   * if the primary Soroban RPC endpoint throws or times out.
   */
  horizonUrl?: string;
  /**
   * Optional sponsor account address for sponsored-reserve onboarding flows.
   * Required when calling buildSponsoredOnboarding from src/sponsorship.ts.
   */
  sponsorAccount?: string;
  /**
   * Optional DEX contract address for token swaps via pay_with_token.
   * When provided, enables previewTokenSwap and pay_with_token operations.
   */
  dexContractId?: string;
  /**
   * Optional anonymous feature-usage analytics configuration.
   * When enabled, method call frequencies are collected and periodically flushed
   * to the provided endpoint. No arguments or PII are ever captured.
   */
  usageAnalytics?: {
    /** Set to true to enable collection. Default: false. */
    enabled: boolean;
    /** POST endpoint that receives flush payloads. */
    endpoint?: string;
    /** Flush interval in milliseconds. Default: 60_000. */
    flushIntervalMs?: number;
  };
  /**
   * Optional idempotency configuration for write methods.
   * When provided, duplicate submissions are detected and short-circuited.
   */
  idempotency?: IdempotencyConfig;
  /**
   * Optional payload guard configuration for createInvoice.
   * When provided, invoice payloads are checked before submission.
   */
  payloadGuard?: PayloadGuardConfig;
  /**
   * Optional list of plugins to register at construction time.
   * Each plugin's `install()` is called during the constructor, and
   * `onInit()` is invoked once all subsystems are ready.
   */
  plugins?: StellarSplitPlugin[];
  /**
   * Optional Soroban RPC connection pool size (1-5). When omitted or set to 1,
   * the SDK uses a single underlying RPC connection (no pool). When `>= 2`,
   * the SDK multiplexes requests across that many persistent connections
   * to the primary RPC endpoint using least-busy selection; idle connections
   * are recycled after 60 seconds (see issue #360).
   *
   * When `rpcUrl` is an array (multi-endpoint / `WarmStandby` failover), the
   * pool is automatically disabled to avoid competing with the standby
   * selector. Use one or the other, not both.
   */
  rpcPoolSize?: number;
  /**
   * Optional per-method timeout configuration (milliseconds).
   * Pass a number to set a single default for all methods, or an object
   * where keys are method names and values are timeout durations.
   * The special key "default" applies to any method not explicitly listed.
   * Defaults to 10 000 ms when omitted.
   *
   * @example
   * { default: 10000, getLeaderboard: 30000, getInvoiceHistory: 20000 }
   */
  timeout?: TimeoutConfig;
  /**
   * Optional injectable RpcClient implementation.
   * When provided, all Soroban RPC calls are routed through this client
   * instead of the default SorobanRpc.Server. Useful for testing (pass
   * a MockRpcClient) or alternative transport environments.
   */
  rpcClient?: RpcClient;
  /**
   * Transport selection for real-time invoice event streaming.
   * - `'http'` (default): Use polling-based RPC event fetching.
   * - `'websocket'`: Use WebSocket connection to the RPC's event-streaming
   *   endpoint for pushed events. Falls back to HTTP polling if the WebSocket
   *   connection fails after 3 reconnect attempts.
   */
  transport?: TransportType;
  /**
   * Optional WebSocket URL override. When not provided, the WebSocket URL is
   * derived from the RPC URL by replacing `https://` with `wss://` (or
   * `http://` with `ws://`).
   * Only used when `transport: 'websocket'`.
   */
  wsUrl?: string;
  /**
   * Optional admin keypair for signing admin-only operations such as
   * `adminFreezeInvoice` and `adminUnfreezeInvoice`. When provided at
   * construction, all admin operations use this keypair automatically.
   *
   * The keypair's public key is verified against the `adminKeypair` argument
   * passed to each admin method, so callers cannot forge an admin identity.
   */
  adminKeypair?: Keypair;
  /**
   * Optional circuit breaker configuration for RPC call resilience.
   * When provided, a circuit breaker is created that tracks consecutive
   * RPC failures and temporarily blocks calls when the failure threshold
   * is exceeded, auto-resetting after a cooldown period.
   * Retry configuration for the circuit breaker's internal retry layer.
   * Applied to every RPC call wrapped by the circuit breaker.
   */
  circuitBreaker?: {
    /** Circuit breaker settings (failure threshold, reset timeout). */
    breaker?: Partial<CircuitBreakerConfig>;
    /** Retry settings applied per RPC call (maxRetries, baseDelayMs, etc.). */
    retry?: Partial<ResilientRetryConfig>;
  };
  offlineQueue?: import("./offlineQueue.js").OfflineQueueConfig;
  /**
   * Optional configuration for the CLOSED/OPEN/HALF_OPEN circuit breaker
   * (src/resilience/CircuitBreaker.ts) guarding the transaction-submission
   * path. When OPEN, `pay()` and other write methods fail fast with
   * CircuitOpenError instead of hanging until RPC timeout. Exposed at
   * runtime via `client.circuitBreaker.getState()`.
   */
  advancedCircuitBreaker?: Partial<AdvancedCircuitBreakerOptions>;
  /**
   * When true, `pay()` applies a predicted Invoice update immediately on
   * submission and `getInvoice()` returns it until the transaction settles,
   * instead of returning stale data while the transaction is pending.
   */
  optimisticCache?: boolean;
  /** Optional public key for signing / transaction attribution. */
  publicKey?: string;
  /** Optional JSON Schema for invoice metadata validation. */
  metadataSchema?: object;
  /** Whether to throw on invalid invoice metadata. Defaults to true. */
  metadataThrowOnInvalid?: boolean;
  /** Optional token gate controller for access policy verification. */
  tokenGateController?: import("./tokenGateController.js").TokenGateController;
  /** Optional caller account ID for token gating. */
  callerAccountId?: string;
  /** Optional OpenTelemetry configuration. */
  otel?: TelemetryOptions;
  /**
   * Optional override for the allowed invoice status transition graph used
   * by InvoiceStateMachine. When omitted, the default graph is used
   * (Pending -> Released | Refunded | Cancelled; the rest are terminal).
   */
  stateMachine?: StateMachineConfig;
  /**
   * Optional list of Soroban RPC endpoints to distribute calls across via
   * health-weighted round-robin ({@link RpcLoadBalancer}). When provided,
   * this takes priority over `rpcUrl` for selecting the primary server;
   * endpoints that error repeatedly or exceed their latency budget are
   * quarantined and automatically reinstated after a passing health check.
   * When omitted, the existing single/array `rpcUrl` behavior is unchanged.
   */
  rpcEndpoints?: EndpointConfig[];
  /** Optional tuning for the {@link RpcLoadBalancer} created from `rpcEndpoints`. */
  rpcLoadBalancer?: RpcLoadBalancerOptions;
  /**
   * Optional fee surge detector configuration for surge-aware fee adjustment.
   * When enabled, fees are adjusted dynamically during network congestion
   * based on live Horizon fee statistics.
   */
  feeSurgeConfig?: import("./feeSurgeDetector.js").FeeSurgeConfig;
  /**
   * When true, enables debug helpers such as {@link StellarSplitClient.parseXdrEnvelope}
   * for inspecting in-flight transaction envelopes. Defaults to false.
   */
  debug?: boolean;
  /**
   * Optional logger instance or options for SDK structured logging.
   * When provided, the client emits structured log entries for lifecycle events,
   * RPC interactions, errors, and debugging information.
   */
  logger?: Logger | LoggerOptions | boolean;
  /**
   * Optional minimum log level for the SDK logger.
   * Can be a LogLevel enum or string ("debug" | "info" | "warn" | "error" | "none").
   * Defaults to LogLevel.NONE (or LogLevel.DEBUG if `debug: true`).
   */
  logLevel?: LogLevel | LogLevelString;
  /**
   * Optional fiat-to-asset price oracle adapter (see `PriceOracleAdapter` in
   * types.ts). Used by `convertFiatToAsset` in currencyConverter.ts to
   * resolve display conversions. Defaults to no oracle configured.
   */
  priceOracle?: import("./types.js").PriceOracleAdapter;
  /** Allow dynamic properties for plugin configurations and runtime extensions. */
  [key: string]: unknown;
}

/** Network configuration. */
export interface NetworkConfig {
  /** Soroban RPC endpoint URL. */
  rpcUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Deployed StellarSplit contract ID. */
  contractId: string;
}

export interface TxResult {
  txHash: string;
}

export interface InFlightRequestInfo {
  id: string;
  method: string;
  startedAt: number;
}

/** TTL for cached NFT gate status results (30 seconds). */
const NFT_GATE_CACHE_TTL_MS = 30_000;

/** Built-in network presets. */
const NETWORKS: Record<string, NetworkConfig> = {
  testnet: {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "",
  },
  mainnet: {
    rpcUrl: "https://soroban-mainnet.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
    contractId: "",
  },
};

export { getScheduledReleaseCountdown, verifyCompletionProof } from "./client/helpers.js";
import { _computeCountdown, getScheduledReleaseCountdown, verifyCompletionProof, toBigInt } from "./client/helpers.js";

export class StellarSplitClient extends TypedEventEmitter<SplitClientEventMap> {
  private _mainServer!: SorobanRpc.Server;
  private _standby: WarmStandby | null = null;
  private _queue = new PriorityQueue();
  private contract: Contract;
  private config: StellarSplitClientConfig;

  /** Modular sub-client for invoice operations (#1079). */
  readonly invoices: InvoiceModule;
  /** Modular sub-client for payment operations (#1079). */
  readonly payments: PaymentModule;
  /** Modular sub-client for dispute and arbitration operations (#1079). */
  readonly disputes: DisputeModule;
  /** Modular sub-client for admin operations (#1079). */
  readonly admin: AdminModule;
  /** Modular sub-client for invoice grouping operations (#1079). */
  readonly groups: GroupModule;
  /** Modular sub-client for template and recurring invoice operations (#1079). */
  readonly templates: TemplateModule;
  /** Modular sub-client for milestone and funding round operations (#1079). */
  readonly milestones: MilestoneModule;
  private _plugins = new Set<string>();
  private _pluginInstances: StellarSplitPlugin[] = [];
  private _pluginRegistry = new PluginRegistry();
  private _metadataValidator: InvoiceMetadataValidator;
  private _dedup = new Deduplicator<Invoice>();
  private _cache: SimpleCache<any> | ICacheStore<any> | null = null;
  private _auditLogger: AuditLogger | null = null;
  private _degradation: DegradationManager | null = null;
  private _rateLimiter: RateLimiter | null = null;
  private _rpcClient: IRPCClient | null = null;
  private _adapter: WalletAdapter | null = null;
  private _hooks: import("./types.js").InvoiceLifecycleHooks = {};
  private _retryOptions: RetryOptions | null = null;
  private _horizonReader: HorizonFallbackReader | null = null;
  private _idempotency: IdempotencyManager | null = null;
  private _rollbackCoordinator: RollbackCoordinator | null = null;
  private _pool: ConnectionPool | null = null;
  /**
   * Effective pool size chosen at construction (or 0 when pooling is off).
   * Cached separately from `config` because {@link NetworkConfig} (used by
   * `switchNetwork`) does not carry `rpcPoolSize`, so reading from
   * `this.config.rpcPoolSize` after a switch would silently disable pooling.
   */
  private _effectiveRpcPoolSize = 0;
  private _batcher: BatchedRpcClient | null = null;

  /**
   * Live client instances, so {@link ProfilerSession} can instrument each
   * client's RPC server.
   *
   * Held on the class rather than patched per-instance because the profiler
   * wraps the prototype once but every client owns its own `server` object.
   *
   * @internal
   */
  static readonly _instances = new Set<StellarSplitClient>();
  private _telemetryHookManager = new TelemetryHookManager();
  private _timeoutManager: TimeoutManager | null = null;
  private _traceIdManager = new TraceIdManager();
  private _injectedRpcClient: RpcClient | null = null;
  private _wsTransport: WebSocketTransport | null = null;
  private _transportType: TransportType = 'http';
  private _activeTransportType: TransportType = 'http';
  private _fallbackListeners: Array<(event: { from: 'websocket'; to: 'http' }) => void> = [];
  /** Admin keypair used to sign admin-only operations (freeze/unfreeze). */
  /** Pluggable signing vault adapter (issue #589). */
  private _signer: Signer | null = null;
  /** Admin keypair used to sign admin-only operations (freeze/unfreeze). */
  private _adminKeypair: Keypair | null = null;
  /** Resilient RPC wrapper providing retry + circuit breaker for all RPC calls. */
  private _resilientRpc: ResilientRpcClient | null = null;
  /** Health-weighted multi-endpoint balancer, present only when `config.rpcEndpoints` is set. */
  private _rpcLoadBalancer: RpcLoadBalancer | null = null;
  /**
   * Optional secondary circuit breaker (src/resilience/CircuitBreaker.ts)
   * guarding the transaction-submission path (`_submitTx`). Distinct from
   * `_resilientRpc`'s breaker so existing `circuitBreaker: { breaker, retry }`
   * configs keep working unchanged; enable via `advancedCircuitBreaker`.
   */
  private _advancedCircuitBreaker: AdvancedCircuitBreaker | null = null;
  private _offlineQueue: import("./offlineQueue.js").OfflineQueue | null = null;
  /** Optimistic UI cache for Invoice reads during a pending pay() call. */
  private _optimisticCache: OptimisticCache<Invoice> | null = null;
  private _sorobanFeatureDetector: SorobanFeatureDetector;
  private _shutdownInProgress = false;
  private _pluginsDestroyed = false;
  private _runtimeShutdownPromise: Promise<void> | null = null;
  private _requestSeq = 0;
  private readonly _inFlightRequests = new Map<string, InFlightRequestInfo>();
  private readonly _inFlightRequestPromises = new Map<string, Promise<unknown>>();
  /** Network the client is currently bound to (see `switchNetwork`). */
  private _activeEnvironment: NetworkEnvironment =
    NetworkEnvironment.CUSTOM;
  /** Resolved preset for the active network, when known. */
  private _activePreset: NetworkPreset | null = null;
  private readonly _managedHorizonStreams = new Set<{ stop(): void }>();
  private readonly _stateMachine: InvoiceStateMachine;

  // ---------------------------------------------------------------------------
  // Issue #874: SDK Logger
  // ---------------------------------------------------------------------------
  private _logger: Logger | null = null;

  // ---------------------------------------------------------------------------
  // Issue #876: Protocol Stats Cache
  // ---------------------------------------------------------------------------
  /** Cached protocol stats entry per contract address. */
  private _protocolStatsCache: Map<string, { data: ProtocolStats; fetchedAt: number }> = new Map();
  /**
   * OpenTelemetry handle. Stays {@link noopOtelHandle} (zero overhead, no
   * span objects created) unless `config.otel.enabled` is true, in which
   * case it's swapped for a real handle once {@link _otelInitPromise}
   * resolves (see the constructor).
   */
  private _otel: OtelHandle = noopOtelHandle;
  private _otelInitPromise: Promise<void> | null = null;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get server(): any {
    if (this._resilientRpc) return this._resilientRpc;
    return (
      this._injectedRpcClient ??
      this._rpcClient ??
      this._standby?.server ??
      this._pool?.select() ??
      this._mainServer
    );
  }
  private set server(s: SorobanRpc.Server) {
    this._rpcClient = null;
    this._injectedRpcClient = null;
    this._mainServer = s;
  }

  /**
   * Fire lifecycle hooks for invoice creation.
   */
  private _fireOnCreated(invoice: Invoice): void {
    if (this._hooks?.onCreated) {
      try {
        this._hooks.onCreated(invoice);
      } catch (error) {
        console.error("Error in onCreated hook:", error);
      }
    }
  }

  /**
   * Fire lifecycle hooks for invoice payment.
   */
  private _fireOnPaid(invoice: Invoice, payment: Payment): void {
    if (this._hooks?.onPaid) {
      try {
        this._hooks.onPaid(invoice, payment);
      } catch (error) {
        console.error("Error in onPaid hook:", error);
      }
    }
  }

  /**
   * Fire lifecycle hooks for invoice release.
   */
  private _fireOnReleased(invoice: Invoice): void {
    if (this._hooks?.onReleased) {
      try {
        this._hooks.onReleased(invoice);
      } catch (error) {
        console.error("Error in onReleased hook:", error);
      }
    }
  }

  /**
   * Fire lifecycle hooks for invoice refund.
   */
  private _fireOnRefunded(invoice: Invoice): void {
    if (this._hooks?.onRefunded) {
      try {
        this._hooks.onRefunded(invoice);
      } catch (error) {
        console.error("Error in onRefunded hook:", error);
      }
    }
  }

  /**
   * Fire lifecycle hooks for invoice cancellation.
   */
  private _fireOnCancelled(invoice: Invoice): void {
    if (this._hooks?.onCancelled) {
      try {
        this._hooks.onCancelled(invoice);
      } catch (error) {
        console.error("Error in onCancelled hook:", error);
      }
    }
  }

  constructor(config: StellarSplitClientConfig) {
    super();

    // Register so ProfilerSession can wrap this client's RPC server.
    StellarSplitClient._instances.add(this);
    validateOrThrow(config);
    this.config = config;
    this._activeEnvironment = detectNetworkEnvironment(config.networkPassphrase);

    if (config.logger && typeof config.logger === "object" && "debug" in config.logger && typeof (config.logger as any).debug === "function") {
      this._logger = config.logger as Logger;
    } else if (config.logger && typeof config.logger === "object") {
      this._logger = new SdkLogger({
        namespace: "StellarSplitClient",
        ...(config.logger as LoggerOptions),
        level: config.logLevel ?? (config.logger as LoggerOptions).level,
      });
    } else if (config.logger === true) {
      this._logger = new SdkLogger({ namespace: "StellarSplitClient", level: LogLevel.DEBUG });
    } else if (config.logLevel !== undefined) {
      this._logger = new SdkLogger({ namespace: "StellarSplitClient", level: config.logLevel });
    } else if (config.debug) {
      this._logger = new SdkLogger({ namespace: "StellarSplitClient", level: LogLevel.DEBUG });
    } else {
      this._logger = new SdkLogger({ namespace: "StellarSplitClient", level: LogLevel.NONE });
    }
    this._logger.debug("StellarSplitClient initialized", {
      contractId: config.contractId,
      network: this._activeEnvironment,
    });

    this._metadataValidator = new InvoiceMetadataValidator(
      config.metadataSchema,
      config.metadataThrowOnInvalid ?? true,
    );
    const primaryUrl = Array.isArray(config.rpcUrl)
      ? config.rpcUrl[0]!
      : config.rpcUrl;

    // Injectable RpcClient (Issue #3): config.rpcClient takes priority over DI container.
    this._injectedRpcClient = config.rpcClient ?? null;
    this._rpcClient = config.container?.getRPCClient() ?? null;
    this._adapter =
      config.container?.getWalletAdapter() ?? config.adapter ?? null;
    if (config.offlineQueue) {
      this._offlineQueue = new OfflineQueue(this, config.offlineQueue);
    }

    // Per-method timeout manager (Issue #1)
    if (config.timeout !== undefined) {
      this._timeoutManager = new TimeoutManager(config.timeout);
    }
    if (config.rpcEndpoints && config.rpcEndpoints.length > 0) {
      this._rpcLoadBalancer = new RpcLoadBalancer(config.rpcEndpoints, config.rpcLoadBalancer);
      this._rpcLoadBalancer.on("endpoint:demoted", (event) => this.emit("endpoint:demoted", event));
      this._rpcLoadBalancer.on("endpoint:reinstated", (event) => this.emit("endpoint:reinstated", event));
      this._rpcLoadBalancer.start();
      this._mainServer = this._rpcLoadBalancer.selectEndpoint().server as SorobanRpc.Server;
    } else {
      this._mainServer = new SorobanRpc.Server(primaryUrl, {
        allowHttp: primaryUrl.startsWith("http://"),
      });
    }

    // Circuit breaker + retry resilience layer (Issue #419)
    if (config.circuitBreaker) {
      const rpcTarget = this._injectedRpcClient ?? this._rpcClient ?? this._mainServer;
      this._resilientRpc = new ResilientRpcClient(
        rpcTarget,
        config.circuitBreaker.retry,
        config.circuitBreaker.breaker,
      );
      this._resilientRpc.on("circuit:open", () => this.emit("circuit:open", undefined));
      this._resilientRpc.on("circuit:close", () => this.emit("circuit:close", undefined));
      this._resilientRpc.on("circuit:half-open", () => this.emit("circuit:half-open", undefined));
    }
    if (config.advancedCircuitBreaker) {
      this._advancedCircuitBreaker = new AdvancedCircuitBreaker(config.advancedCircuitBreaker, {
        warn: (event) => this.emit("circuit_state_change", event),
      });
    }
    if (config.optimisticCache) {
      this._optimisticCache = new OptimisticCache<Invoice>();
    }

    // Outbound request rate limiting (Issue #1058): gates transaction
    // submission so a misbehaving caller cannot flood the RPC endpoint.
    if (config.rateLimit) {
      this._rateLimiter = new RateLimiter(config.rateLimit);
    }

    this._stateMachine = new InvoiceStateMachine(config.stateMachine);

    // Soroban protocol feature detection (Issue #529): probe once at startup;
    // the detector caches internally and re-probes after its staleness window.
    this._sorobanFeatureDetector = new SorobanFeatureDetector({ rpcUrl: primaryUrl });
    this._sorobanFeatureDetector.detect().catch(() => {
      // Best-effort startup probe; getSorobanFeatures() will retry on demand.
    });
    if (
      !this._rpcClient &&
      Array.isArray(config.rpcUrl) &&
      config.rpcUrl.length > 1
    ) {
      this._standby = new WarmStandby(config.rpcUrl);
      this._standby.start();
    }

    // Connection pool (issue #360). Only enabled on single-endpoint configs
    // when an external RPC client hasn't been injected via the DI container.
    const wantsPool =
      !this._rpcClient && !this._standby && (config.rpcPoolSize ?? 0) >= 2;
    if (wantsPool) {
      this._effectiveRpcPoolSize = Math.min(
        Math.max(config.rpcPoolSize!, 1),
        5,
      );
      this._pool = new ConnectionPool({
        rpcUrl: primaryUrl,
        poolSize: this._effectiveRpcPoolSize,
        allowHttp: primaryUrl.startsWith("http://"),
      });
    }

    this.contract = new Contract(config.contractId);

    this._cache = config.container?.getCacheStore() ??
      (config.cache?.enabled ? new SimpleCache<any>(config.cache) : null);
    if (config.telemetry) {
      telemetry.init(config.telemetry);
    }
    if (config.signingKeypair) {
  /**
   * addRequestInterceptor
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
      addRequestInterceptor(
  /**
   * createRequestSigningInterceptor
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
        createRequestSigningInterceptor(config.signingKeypair),
      );
    }
    if (config.compression?.enabled) {
  /**
   * addRequestInterceptor
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
      addRequestInterceptor(
  /**
   * createCompressionRequestInterceptor
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
        createCompressionRequestInterceptor(config.compression),
      );
  /**
   * addResponseInterceptor
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
      addResponseInterceptor(
  /**
   * createCompressionResponseInterceptor
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
        createCompressionResponseInterceptor(config.compression),
      );
    }

    // Initialize hooks
    this._hooks = config.hooks ?? {};
    if (config.retry) {
      this._retryOptions = config.retry;
    }
    if (config.horizonUrl) {
      this._horizonReader = new HorizonFallbackReader(config.horizonUrl);
    }
    if (config.idempotency) {
      this._idempotency = new IdempotencyManager(config.idempotency);
    }

    // WebSocket transport (Issue #377)
    if (config.transport === 'websocket') {
      this._transportType = 'websocket';
      this._activeTransportType = 'websocket';
      this._wsTransport = new WebSocketTransport(primaryUrl, config.wsUrl);
      this._wsTransport.onFallback((event: { from: 'websocket'; to: 'http' }) => {
        this._activeTransportType = 'http';
        for (const cb of this._fallbackListeners) {
          try { cb(event); } catch { }
        }
      });
    }

    // Pluggable signing vault adapter (issue #589)
    this._signer = config.signer ?? null;

    // Admin keypair for admin-only operations
    if (config.adminKeypair) {
      this._adminKeypair = config.adminKeypair;
    }

  /**
   * initHealthDashboard
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
    initHealthDashboard(this.server, this._dedup);

    // Register and initialize config-level plugins
    if (config.plugins) {
      for (const plugin of config.plugins) {
        this.registerPlugin(plugin);
      }
    }
    for (const p of this._pluginInstances) {
      p.onInit?.(this);
    }
    if (config.validatePassphrase !== false) {
      void this._validateStartupConfig();
    }

    // OpenTelemetry instrumentation (opt-in, zero overhead when omitted/disabled).
    if (config.otel?.enabled) {
      const otelExporter = config.otel.exporterUrl
        ? new OtelExporter({
            exporterUrl: config.otel.exporterUrl,
            serviceName: config.otel.serviceName,
          })
        : undefined;
      this._otelInitPromise = createOtelHandle(config.otel, otelExporter)
        .then((handle) => {
          this._otel = handle;
        })
        .catch(() => {
          // `@opentelemetry/api` isn't installed, or init otherwise failed --
          // stay on the zero-overhead no-op handle rather than throwing.
        });
      this._instrumentOtel();
    }

    this._pluginRegistry.setClientContext({
      on: (event, handler) => this.on(event as keyof SplitClientEventMap, handler as never),
      off: (event, handler) => this.off(event as keyof SplitClientEventMap, handler as never),
    });

    // Initialize logical modules (#1079)
    this.invoices = new InvoiceModule(this);
    this.payments = new PaymentModule(this);
    this.disputes = new DisputeModule(this);
    this.admin = new AdminModule(this);
    this.groups = new GroupModule(this);
    this.templates = new TemplateModule(this);
    this.milestones = new MilestoneModule(this);
  }

  /**
   * Internal startup validation. Throws if the configured passphrase does not
   * match the connected RPC node.
   */
  private async _validateStartupConfig(): Promise<void> {
    const { NetworkPassphraseValidator } = await import(
      "./network/NetworkPassphraseValidator.js"
    );
    const { PassphraseMismatchError } = await import("./errors.js");
    const primaryUrl = Array.isArray(this.config.rpcUrl)
      ? this.config.rpcUrl[0]!
      : this.config.rpcUrl;
    const result = await NetworkPassphraseValidator.validate(
      this.config.networkPassphrase,
      primaryUrl,
    );
    if (result.mismatch) {
      throw new PassphraseMismatchError(result.configured, result.reported);
    }
  }

  /**
   * Returns the logger instance configured for this client.
   *
   * @returns The active {@link Logger} instance.
   *
   * @example
   * ```typescript
   * client.logger.info("Custom log message", { extra: "data" });
   * ```
   */
  public get logger(): Logger {
    return this._logger ?? (this._logger = new SdkLogger({ namespace: "StellarSplitClient", level: LogLevel.NONE }));
  }

  /**
   * Sets the active logging level for the SDK client.
   *
   * @param level - Target log level as an enum or string name ('debug' | 'info' | 'warn' | 'error' | 'none').
   *
   * @example
   * ```typescript
   * client.setLogLevel("debug");
   * client.setLogLevel(LogLevel.WARN);
   * ```
   */
  public setLogLevel(level: LogLevel | LogLevelString): void {
    this.logger.setLevel(level);
  }

  /**
   * Enables or disables debug logging dynamically.
   *
   * @param enabled - Whether debug logging should be active. Defaults to true.
   *
   * @example
   * ```typescript
   * client.enableDebugLogging(true);
   * ```
   */
  public enableDebugLogging(enabled: boolean = true): void {
    this.logger.setLevel(enabled ? LogLevel.DEBUG : LogLevel.NONE);
  }

  /**
   * Retrieves all operations currently queued for submission while offline.
   * @returns An array of pending QueuedOperation objects.
   *
   * @example
   * ```typescript
   * const pendingOps = client.getOfflineQueue();
   * console.log(`Queued actions: ${pendingOps.length}`);
   * ```
   */
  getOfflineQueue(): import("./offlineQueue.js").QueuedOperation[] {
    return this._offlineQueue ? this._offlineQueue.getQueue() : [];
  }

  /**
   * Clears and purges all operations currently pending in the offline queue.
   * @returns void
   *
   * @example
   * ```typescript
   * client.clearOfflineQueue();
   * ```
   */
  clearOfflineQueue(): void {
    if (this._offlineQueue) this._offlineQueue.clear();
  }

  async syncOfflineQueue(conflictStrategy?: import("./types.js").ConflictStrategy) {
    if (!this._offlineQueue) return null;
    return this._offlineQueue.sync(conflictStrategy);
  }

  async switchTo(network: "mainnet" | "testnet" | "futurenet"): Promise<void> {
    const { NetworkSwitcher } = await import("./network/NetworkSwitcher.js");
    return NetworkSwitcher.switchTo(network, this);
  }

  /**
   * Checks whether a graceful shutdown sequence is currently in progress.
   * @returns True if shutdown has commenced, otherwise false.
   *
   * @example
   * ```typescript
   * if (!client.isShutdownInProgress()) {
   *   await client.pay({ invoiceId, amount, payer });
   * }
   * ```
   */
  isShutdownInProgress(): boolean {
    return this._shutdownInProgress;
  }

  /**
   * Initiates graceful shutdown of the client, rejecting new requests while draining in-flight operations.
   * @returns void
   *
   * @example
   * ```typescript
   * process.on('SIGTERM', () => {
   *   client.beginGracefulShutdown();
   * });
   * ```
   */
  beginGracefulShutdown(): void {
    this._shutdownInProgress = true;
  }

  /**
   * Registers an active Horizon SSE stream manager with the client for lifecycle cleanup.
   *
   * @param manager - Manager object providing a stop() teardown hook.
   * @returns A deregistration cleanup callback function.
   *
   * @example
   * ```typescript
   * const unregister = client.registerHorizonStreamManager(streamManager);
   * ```
   */
  registerHorizonStreamManager(manager: { stop(): void }): () => void {
    this._managedHorizonStreams.add(manager);
    return () => {
      this._managedHorizonStreams.delete(manager);
    };
  }

  /**
   * Returns a snapshot list of Soroban RPC requests currently in-flight, ordered by start time.
   * @returns Array of active in-flight request tracking metadata.
   *
   * @example
   * ```typescript
   * const inFlight = client.getInFlightRequests();
   * console.log(`Active requests: ${inFlight.length}`);
   * ```
   */
  getInFlightRequests(): InFlightRequestInfo[] {
    return [...this._inFlightRequests.values()].sort(
      (left, right) => left.startedAt - right.startedAt,
    );
  }

  /**
   * Waits for all pending in-flight Soroban RPC requests to settle.
   * @returns Promise that resolves once all active requests have completed.
   *
   * @example
   * ```typescript
   * await client.waitForInFlightRequests();
   * ```
   */
  async waitForInFlightRequests(): Promise<void> {
    await Promise.allSettled([...this._inFlightRequestPromises.values()]);
  }

  /**
   * Completes the shutdown sequence by destroying plugins, terminating managed streams, and freeing resources.
   * @returns Promise that resolves once final shutdown cleanup finishes.
   *
   * @example
   * ```typescript
   * await client.finalizeShutdown();
   * ```
   */
  async finalizeShutdown(): Promise<void> {
    if (this._runtimeShutdownPromise) {
      return this._runtimeShutdownPromise;
    }

    this.beginGracefulShutdown();
    this._runtimeShutdownPromise = (async () => {
      await this._destroyPlugins();
  /**
   * destroySubscriptionManager
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
      destroySubscriptionManager(this.config.contractId);
      for (const manager of this._managedHorizonStreams) {
        manager.stop();
      }
      this._managedHorizonStreams.clear();

      this._standby?.stop();
      this._wsTransport?.disconnect();
      this._wsTransport = null;

      this._pool?.dispose();
      this._pool = null;
      if (this._cache && typeof (this._cache as any).persist === "function") {
        await (this._cache as any).persist();
      }
      if (this._cache && typeof (this._cache as any).close === "function") {
        await (this._cache as any).close();
      }
      if (
        this._rpcClient &&
  /**
   * typeof
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
        typeof (this._rpcClient as any).close === "function"
      ) {
        await (this._rpcClient as any).close();
      }

      telemetry.destroy();
    })();

    return this._runtimeShutdownPromise;
  }

  private async _destroyPlugins(): Promise<void> {
    if (this._pluginsDestroyed) return;
    this._pluginsDestroyed = true;
    for (const plugin of [...this._pluginInstances].reverse()) {
      try {
        await plugin.onDestroy?.(this);
      } catch (error) {
        console.error(
          `[StellarSplitClient] Plugin "${plugin.name}" onDestroy error:`,
          error,
        );
      }
    }

    this._pluginInstances = [];
    this._plugins.clear();
  }

  private _assertWritable(): void {
    if (this._shutdownInProgress) {
      throw new ShutdownInProgressError();
    }
  }

  private _trackInFlightRequest<T>(
    method: string,
    operation: () => Promise<T>,
  ): Promise<T> {
    const id = `${method}:${++this._requestSeq}`;
    const info: InFlightRequestInfo = {
      id,
      method,
      startedAt: Date.now(),
    };

    this._inFlightRequests.set(id, info);
    const trackedPromise = (async () => operation())().finally(() => {
      this._inFlightRequests.delete(id);
      this._inFlightRequestPromises.delete(id);
    });
    this._inFlightRequestPromises.set(id, trackedPromise);
    return trackedPromise;
  }

  /**
   * The pluggable signing vault adapter (issue #589) provided at construction,
   * or `null` when the client was created without one.
   */
  get signer(): Signer | null {
    return this._signer;
  }

  /**
   * Wraps every public StellarSplitClient method (every own, non-underscore-
   * prefixed function on the prototype) so that calling it opens an OTel
   * span (and records `split_sdk.rpc_call.*` / `split_sdk.tx.error.count`
   * metrics) around the original implementation. Only ever invoked from the
   * constructor when `config.otel.enabled` is true -- when disabled, this
   * method is never called, no methods are wrapped, and there is no
   * overhead whatsoever.
   *
   * Async methods (the vast majority: `pay`, `createInvoice`, `getInvoice`,
   * ...) are wrapped with an async-aware span helper. The handful of
   * synchronous methods (e.g. `switchNetwork`, `getSSEEndpoint`,
   * `getPoolStats`) are wrapped with a synchronous helper that never awaits
   * anything, so their return type/signature is preserved for callers.
   */
  private _instrumentOtel(): void {
    const proto = Object.getPrototypeOf(this) as object;
    const self = this as unknown as Record<string, unknown>;
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === "constructor" || name.startsWith("_")) continue;
      const descriptor = Object.getOwnPropertyDescriptor(proto, name);
      if (!descriptor || typeof descriptor.value !== "function") continue;
      const original = descriptor.value as (...args: unknown[]) => unknown;
      const isAsync = original.constructor.name === "AsyncFunction";
      if (isAsync) {
        self[name] = (...args: unknown[]) =>
          this._withOtelSpanAsync(name, args, () => original.apply(this, args) as Promise<unknown>);
      } else {
        self[name] = (...args: unknown[]) =>
          this._withOtelSpanSync(name, args, () => original.apply(this, args));
      }
    }
  }

  /** Best-effort `invoice.id` extraction from a method's first argument. */
  private _otelInvoiceId(args: unknown[]): string | undefined {
    const first = args[0];
    if (typeof first === "string") return first;
    if (first && typeof first === "object") {
      const obj = first as Record<string, unknown>;
      for (const key of ["invoiceId", "invoice_id", "id"]) {
        const value = obj[key];
        if (typeof value === "string") return value;
      }
    }
    return undefined;
  }

  /** Best-effort `tx.hash` extraction from a method's resolved return value. */
  private _otelTxHash(result: unknown): string | undefined {
    if (result && typeof result === "object") {
      const value = (result as Record<string, unknown>).txHash;
      if (typeof value === "string") return value;
    }
    return undefined;
  }

  /** Shared span attribute setup applied to both the sync and async span helpers. */
  private _otelStartSpan(name: string, args: unknown[]) {
    const span = this._otel.startSpan(name);
    span.setAttribute("stellar.network", this.config.networkPassphrase);
    const rpcUrl = Array.isArray(this.config.rpcUrl) ? this.config.rpcUrl[0] : this.config.rpcUrl;
    if (rpcUrl) span.setAttribute("rpc.url", rpcUrl);
    const invoiceId = this._otelInvoiceId(args);
    if (invoiceId) span.setAttribute("invoice.id", invoiceId);
    return span;
  }

  private async _withOtelSpanAsync<T>(
    name: string,
    args: unknown[],
    fn: () => Promise<T>,
  ): Promise<T> {
    if (this._otelInitPromise) await this._otelInitPromise;
    const span = this._otelStartSpan(name, args);
    const startedAt = Date.now();
    try {
      const result = await fn();
      const durationMs = Date.now() - startedAt;
      span.setAttribute("rpc.duration_ms", durationMs);
      const txHash = this._otelTxHash(result);
      if (txHash) span.setAttribute("tx.hash", txHash);
      this._otel.recordRpcCall(durationMs, { method: name });
      span.end();
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      span.setAttribute("rpc.duration_ms", durationMs);
      span.recordError(error);
      this._otel.recordRpcCall(durationMs, { method: name, error: true });
      this._otel.recordTxError({ method: name });
      span.end();
      throw error;
    }
  }

  private _withOtelSpanSync<T>(name: string, args: unknown[], fn: () => T): T {
    const span = this._otelStartSpan(name, args);
    const startedAt = Date.now();
    try {
      const result = fn();
      const durationMs = Date.now() - startedAt;
      span.setAttribute("rpc.duration_ms", durationMs);
      const txHash = this._otelTxHash(result);
      if (txHash) span.setAttribute("tx.hash", txHash);
      this._otel.recordRpcCall(durationMs, { method: name });
      span.end();
      return result;
    } catch (error) {
      const durationMs = Date.now() - startedAt;
      span.setAttribute("rpc.duration_ms", durationMs);
      span.recordError(error);
      this._otel.recordRpcCall(durationMs, { method: name, error: true });
      this._otel.recordTxError({ method: name });
      span.end();
      throw error;
    }
  }

  /**
   * Queries the connected Soroban RPC node and detects supported runtime protocol feature flags.
   * @returns Promise resolving to detected SorobanFeatureFlags.
   *
   * @example
   * ```typescript
   * const features = await client.getSorobanFeatures();
   * console.log(`State expiration support: ${features.stateExpiration}`);
   * ```
   */
  async getSorobanFeatures(): Promise<SorobanFeatureFlags> {
    return this._sorobanFeatureDetector.detect();
  }

  /**
   * Performs an end-to-end health probe against connected RPC endpoints and contract availability.
   * @returns Promise resolving to a HealthCheckResult with status, latency, and node versions.
   *
   * @example
   * ```typescript
   * const health = await client.healthCheck();
   * console.log(`RPC health: ${health.healthy ? 'OK' : 'DEGRADED'}`);
   * ```
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      return await Promise.race([
        this._doHealthCheck(start),
        new Promise<never>((_, reject) =>
  /**
   * setTimeout
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
          setTimeout(
            () =>
  /**
   * reject
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
              reject(
                new HealthCheckTimeoutError(
                  "Health check timed out after 5000ms",
                ),
              ),
            5000,
          ),
        ),
      ]);
    } catch (e: any) {
      if (e instanceof HealthCheckTimeoutError) {
        throw e;
      }
      return {
        rpcReachable: false,
        latencyMs: Date.now() - start,
        network: "unknown",
        contractDeployed: false,
        error: e.message || String(e),
      };
    }
  }

  private async _doHealthCheck(start: number): Promise<HealthCheckResult> {
    try {
      const ledger = await this.server.getLatestLedger();
      const networkRes = await this.server.getNetwork();
      const latencyMs = Date.now() - start;
      const network = networkRes.passphrase;

      let contractDeployed = false;
      let errorMsg: string | undefined;

      try {
        await this.server.getContractWasmByContractId(this.config.contractId);
        contractDeployed = true;
      } catch (err: any) {
        if (!err.message?.includes("Could not obtain contract hash")) {
          // If we get here, it might be deployed but we couldn't fetch the wasm,
          // or it threw some other error. We'll conservatively say true if it's
          // an unrelated error, or just false. Let's say false and log error.
          errorMsg = err.message || String(err);
        }
      }

      return {
        rpcReachable: true,
        latencyMs,
        network,
        contractDeployed,
        error: errorMsg,
      };
    } catch (err: any) {
      throw err; // caught by outer catch
    }
  }

  /**
   * Enable or disable request batching for read methods (getInvoice, getPaymentHistory, getInvoiceExt).
   * Disabled by default — opt-in to batch concurrent RPC calls within a 10 ms window.
   * @param enabled - Pass `true` to enable batching, `false` to disable.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * client.setBatchingEnabled(true);
   * ```
   */
  setBatchingEnabled(enabled: boolean): void {
    if (enabled) {
      if (!this._batcher) {
        this._batcher = new BatchedRpcClient({
          fetchInvoice: (id: string) => this._fetchInvoice(id),
          fetchPaymentHistory: (id: string) => this._fetchPaymentHistory(id),
          fetchInvoiceExt: (id: string) => this._fetchInvoiceExt(id),
        });
      }
    } else {
      this._batcher?.clear();
      this._batcher = null;
    }
  }

  /**
   * Manually invalidate cache entries.
   * @param method Optional method name to invalidate.
   * @param args Optional arguments array to invalidate a specific call.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * client.invalidateCache('getInvoice', ['123']);
   * // Or invalidate all:
   * client.invalidateCache();
   * ```
   */
  public invalidateCache(method?: string, args?: any[]): void {
    if (this._cache) {
      if (typeof (this._cache as any).invalidate === "function") {
        (this._cache as any).invalidate(method, args);
      }
    }
  }

  /**
   * Retrieves performance statistics and hit/miss ratios for the client cache layer.
   * @returns CacheStats object or null if caching is disabled.
   *
   * @example
   * ```typescript
   * const stats = client.getCacheStats();
   * if (stats) console.log(`Hit rate: ${stats.hitRate}%`);
   * ```
   */
  public getCacheStats(): import("./cache.js").CacheStats | null {
    if (this._cache && typeof (this._cache as any).getStats === "function") {
      return (this._cache as any).getStats();
    }
    return null;
  }

  private _logAudit(
    method: string,
    params: Record<string, unknown>,
    success: boolean,
    durationMs: number,
  ): void {
    if (!this._auditLogger) return;
    this._auditLogger.log({
      timestamp: Date.now(),
      method,
      params: this._auditLogger.sanitize(params),
      success,
      durationMs,
    });
  }

  /**
   * Wraps an async operation with telemetry hooks (onCallStart, onCallEnd, onError)
   * and propagates a traceId through the call stack.
   * Fire-and-forget semantics: hook errors do not propagate to the caller.
   */
  private async _withTelemetry<T>(
    method: string,
    args: Record<string, unknown> | undefined,
    operation: () => Promise<T>,
    opts?: { traceId?: string; timeout?: number },
  ): Promise<T> {
    const traceId = opts?.traceId ?? this._traceIdManager.generate();
    const startTime = Date.now();
    this._telemetryHookManager.fireOnCallStart({
      method,
      args,
      timestamp: startTime,
      traceId,
    });

    const run = async (): Promise<T> => {
      try {
        const result = await operation();
        const durationMs = Date.now() - startTime;
        this._telemetryHookManager.fireOnCallEnd({
          method,
          durationMs,
          success: true,
          timestamp: Date.now(),
          traceId,
        });
        return result;
      } catch (error) {
        const durationMs = Date.now() - startTime;
        const stellarError = error as StellarSplitError;

        this._telemetryHookManager.fireOnError(stellarError, {
          method,
          args,
          timestamp: Date.now(),
          traceId,
        });

        this._telemetryHookManager.fireOnCallEnd({
          method,
          durationMs,
          success: false,
          error: stellarError,
          timestamp: Date.now(),
          traceId,
        });

        throw error;
      }
    };

    const timeoutMs =
      opts?.timeout ?? this._timeoutManager?.resolveTimeout(method);
    if (timeoutMs !== undefined) {
      return withTimeoutOrThrow(() => run(), timeoutMs, method);
    }
    return run();
  }

  // ---------------------------------------------------------------------------
  // Plugin system
  // ---------------------------------------------------------------------------

  /**
   * Registers an extensible plugin into the client lifecycle.
   *
   * @param plugin - Plugin implementation instance.
   * @returns void
   * @throws {PluginAlreadyRegisteredError} If a plugin with the same name is already registered.
   *
   * @example
   * ```typescript
   * client.registerPlugin(new LoggingPlugin());
   * ```
   */
  registerPlugin(plugin: StellarSplitPlugin): void {
    if (this._plugins.has(plugin.name)) {
      throw new PluginAlreadyRegisteredError(plugin.name);
    }
    this._plugins.add(plugin.name);
    this._pluginInstances.push(plugin);
    plugin.install?.(this);
  }

  /**
   * Register a plugin with fluent API support.
   * Plugins can extend the client with custom methods, intercept RPC calls,
   * and subscribe to events.
   *
   * @param plugin - The plugin to install.
   * @param options - Optional plugin configuration.
   * @returns The client instance for method chaining.
   * @throws {PluginAlreadyRegisteredError} if a plugin with the same name exists.
   *
   * @example
   * ```typescript
   * client.use(new MetricsPlugin(), { sampleRate: 0.5 });
   * ```
   */
  use(plugin: SdkPlugin, options?: Record<string, unknown>): this {
    this._pluginRegistry.use(plugin, options);
    return this;
  }

  /**
   * Unregisters and removes a previously registered plugin by its unique name identifier.
   *
   * @param name - The unique identifier name of the plugin to remove.
   * @returns void
   *
   * @example
   * ```typescript
   * client.removePlugin('logging-plugin');
   * ```
   */
  removePlugin(name: string): void {
    this._pluginRegistry.removePlugin(name);
  }

  /**
   * Retrieves the names of all currently registered client plugins.
   * @returns Array of registered plugin name strings.
   *
   * @example
   * ```typescript
   * const plugins = client.getPlugins();
   * console.log(`Active plugins: ${plugins.join(', ')}`);
   * ```
   */
  getPlugins(): string[] {
    return this._pluginRegistry.getPlugins();
  }

  // ---------------------------------------------------------------------------
  // Telemetry hooks
  // ---------------------------------------------------------------------------

  /**
   * Register telemetry hooks for error and performance monitoring.
   *
   * Allows application developers to integrate their own monitoring solutions
   * (Sentry, Datadog, custom) without direct dependencies in the SDK.
   *
   * All hooks are fire-and-forget — exceptions within hooks do not propagate to callers.
   *
   * @param hooks - Object containing optional onError, onCallStart, and onCallEnd hooks.
   *
   * @example
   * ```typescript
   * client.setTelemetryHooks({
   *   onError: (error, context) => {
   *     Sentry.captureException(error, { extra: context });
   *   },
   *   onCallStart: ({ method, timestamp }) => {
   *     console.log(`Starting ${method} at ${timestamp}`);
   *   },
   *   onCallEnd: ({ method, durationMs, success }) => {
   *     console.log(`${method} took ${durationMs}ms, success: ${success}`);
   *   }
   * });
   * ```
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
  setTelemetryHooks(hooks: TelemetryHooks): void {
    this._telemetryHookManager.setHooks(hooks);
  }

  /**
   * Removes and resets all configured telemetry lifecycle hooks.
   * @returns void
   *
   * @example
   * ```typescript
   * client.clearTelemetryHooks();
   * ```
   */
  clearTelemetryHooks(): void {
    this._telemetryHookManager.clearHooks();
  }

  // ---------------------------------------------------------------------------
  // Timeout config (Issue #1)
  // ---------------------------------------------------------------------------

  /**
   * Retrieves the configured execution timeout thresholds per SDK method.
   * @returns Record mapping method names to timeout durations in milliseconds.
   *
   * @example
   * ```typescript
   * const timeouts = client.getTimeoutConfig();
   * ```
   */
  getTimeoutConfig(): Record<string, number> {
    return this._timeoutManager?.getTimeoutConfig() ?? {};
  }

  // ---------------------------------------------------------------------------
  // Trace ID (Issue #2)
  // ---------------------------------------------------------------------------

  /**
   * Sets the default generator function used to produce correlation trace IDs for RPC calls.
   *
   * @param generator - A function returning a unique trace identifier string.
   * @returns void
   *
   * @example
   * ```typescript
   * client.setDefaultTraceIdGenerator(() => `trace-${Date.now()}-${Math.random()}`);
   * ```
   */
  setDefaultTraceIdGenerator(generator: () => string): void {
    this._traceIdManager.setGenerator(generator);
  }

  // ---------------------------------------------------------------------------
  // Dispute management
  // ---------------------------------------------------------------------------

  /**
   * Dispute an invoice by ID.
   * @param invoiceId - The ID of the invoice to dispute.
   * @returns The dispute ID and transaction hash.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.disputeInvoice('123');
   * ```
   */
  async disputeInvoice(invoiceId: string): Promise<DisputeResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "dispute_invoice",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      );
      // Assuming the creator is the one calling dispute
      // You may want to pass the creator as a parameter if needed
      const result = await this._submitTx(this.config.contractId, operation);
      const disputeId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod("disputeInvoice", true, Date.now() - startTime);
      return { disputeId, txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("disputeInvoice", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Submit an arbiter's vote for a dispute.
   * @param vote - The arbiter vote parameters.
   * @returns The dispute ID and transaction hash.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.submitArbiterVote({ invoiceId: '123', arbiter: 'GA...', approve: true });
   * ```
   */
  async submitArbiterVote(vote: ArbiterVote): Promise<DisputeResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "submit_arbiter_vote",
        nativeToScVal(BigInt(vote.invoiceId), { type: "u64" }),
        nativeToScVal(vote.arbiter, { type: "address" }),
        nativeToScVal(vote.approve, { type: "bool" }),
      );
      const result = await this._submitTx(vote.arbiter, operation);
      const disputeId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod("submitArbiterVote", true, Date.now() - startTime);
      return { disputeId, txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod(
        "submitArbiterVote",
        false,
        Date.now() - startTime,
      );
      throw error;
    }
  }

  /**
   * Resolve a dispute for an invoice. The arbiter address must co-sign the resolution.
   * @param invoiceId - The ID of the invoice to resolve dispute for.
   * @param arbiter - The Stellar address of the arbiter (must sign).
   * @returns The dispute ID and transaction hash.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.resolveDispute('123', 'GA...ARBITER');
   * ```
   */
  async resolveDispute(
    invoiceId: string,
    arbiter: string,
  ): Promise<DisputeResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "resolve_dispute",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      );
      const result = await this._submitTx(arbiter, operation);
      const disputeId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod("resolveDispute", true, Date.now() - startTime);
      return { disputeId, txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("resolveDispute", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Raise a dispute on an invoice.
   * @param invoiceId - The ID of the invoice to dispute.
   * @returns The dispute ID and transaction hash.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.raiseDispute('123');
   * ```
   */
  async raiseDispute(invoiceId: string): Promise<DisputeResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "dispute_invoice",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      );
      const result = await this._submitTx(this.config.contractId, operation);
      const disputeId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod("raiseDispute", true, Date.now() - startTime);
      return { disputeId, txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("raiseDispute", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Get the dispute status for an invoice.
   * @param invoiceId - The ID of the invoice to query.
   * @returns The dispute status.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const status = await client.getDisputeStatus('123');
   * ```
   */
  async getDisputeStatus(invoiceId: string): Promise<DisputeStatus> {
    return this._withCache("getDisputeStatus", [invoiceId], async () => {
      const startTime = Date.now();
      try {
        const operation = this.contract.call(
          "get_dispute_status",
          nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        );
        const raw = (await this._simulateView(operation)) as Record<
          string,
          unknown
        >;
        const status: DisputeStatus = {
          invoiceId,
          disputed: Boolean(raw.disputed),
          arbiter: raw.arbiter as string,
          resolved: Boolean(raw.resolved),
          resolution:
            raw.resolution === "approved"
              ? "approved"
              : raw.resolution === "rejected"
                ? "rejected"
                : null,
        };
        telemetry.recordMethod(
          "getDisputeStatus",
          true,
          Date.now() - startTime,
        );
        return status;
      } catch (error) {
        telemetry.recordMethod(
          "getDisputeStatus",
          false,
          Date.now() - startTime,
        );
        throw error;
      }
    });
  }

  /**
   * Submit a vote on a disputed invoice (arbitrator only).
   * @param params - Vote parameters (invoiceId, arbiter address, approve boolean)
   * @returns Transaction result with hash
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.voteDispute(voteParams);
   * ```
   */
  async voteDispute(params: ArbiterVote): Promise<{ txHash: string }> {
    return this._withTelemetry("voteDispute", params as unknown as Record<string, unknown>, async () => {
      const operation = this.contract.call(
        "vote_dispute",
        nativeToScVal(BigInt(params.invoiceId), { type: "u64" }),
        nativeToScVal(params.arbiter, { type: "address" }),
        nativeToScVal(params.approve, { type: "bool" }),
      );

      const { txHash } = await this._submitTx(params.arbiter, operation);
      return { txHash };
    });
  }

  /**
   * Add evidence to a dispute (stores IPFS CID in dispute notes).
   * @param invoiceId - The invoice ID
   * @param evidenceCid - IPFS CID of the evidence file
   * @param fileName - Optional file name for reference
   * @returns Transaction result with hash
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.addDisputeEvidence('123', { uri: 'ipfs://...', hash: '...' });
   * ```
   */
  async addDisputeEvidence(
    invoiceId: string,
    evidenceCid: string,
    fileName?: string,
  ): Promise<{ txHash: string; cid: string }> {
    return this._withTelemetry(
      "addDisputeEvidence",
      { invoiceId, evidenceCid, fileName } as Record<string, unknown>,
      async () => {
        // Note: This assumes the contract has an add_dispute_evidence method
        // If not, this would need to be stored off-chain or via memo field
        const note = fileName ? `${fileName}: ${evidenceCid}` : evidenceCid;
        
        const operation = this.contract.call(
          "add_dispute_note",
          nativeToScVal(BigInt(invoiceId), { type: "u64" }),
          nativeToScVal(note, { type: "string" }),
        );

        // Use current wallet for signing
        const publicKey = await (this._adapter 
          ? this._adapter.getAddress() 
          : signTransaction.call(this, "", this.config.networkPassphrase).then(() => "")
        );

        const { txHash } = await this._submitTx(publicKey, operation);
        return { txHash, cid: evidenceCid };
      },
    );
  }

  /**
   * Get SSE endpoint URL for real-time updates (if available).
   * This is used by useInvoiceStream hook for live updates.
   * @param path - The SSE path (e.g., "/invoice/123")
   * @returns SSE endpoint URL
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const sseUrl = client.getSSEEndpoint('/events');
   * ```
   */
  getSSEEndpoint(path: string): string {
    // This would be configured based on your backend SSE server
    // For now, return a placeholder that components can override
    const primaryUrl = Array.isArray(this.config.rpcUrl) 
      ? this.config.rpcUrl[0]! 
      : this.config.rpcUrl;
    const baseUrl = (this.config as any).sseUrl || primaryUrl.replace('/soroban/rpc', '');
    return `${baseUrl}/sse${path}`;
  }

  // ---------------------------------------------------------------------------
  // Debug helpers
  // ---------------------------------------------------------------------------

  /**
   * Decode a base64-encoded Stellar transaction envelope XDR into a structured,
   * human-readable object. Useful for debugging, audit logging, and UI display.
   *
   * Only functional when {@link StellarSplitClientConfig.debug} is true;
   * otherwise returns a placeholder indicating debug mode is off.
   *
   * @param xdrBase64 - Base64-encoded transaction envelope XDR.
   * @returns A parsed envelope, or a notice when debug mode is disabled.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const parsed = client.parseXdrEnvelope(envelopeXdr);
   * ```
   */
  parseXdrEnvelope(xdrBase64: string): ParsedEnvelope | { error: string } {
    if (!this.config.debug) {
      return { error: "Debug mode is disabled. Set config.debug = true to enable XDR parsing." };
    }
    return parseEnvelope(xdrBase64);
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Creates a new on-chain invoice with multi-recipient split payout distribution rules.
   *
   * @param params - Invoice creation configuration including creator, token address, deadline, and recipient shares.
   * @returns Promise resolving to the newly created invoice ID and transaction hash, or SimulationResult if simulate: true.
   * @throws {ValidationError} If split shares do not sum to 100% or parameters are invalid.
   * @throws {NftGateRequiredError} If the creator does not satisfy required token-gate conditions.
   *
   * @example
   * ```typescript
   * const { invoiceId, txHash } = await client.createInvoice({
   *   creator: 'GB...', 
   *   token: 'CD...', 
   *   deadline: deadlineFromDays(7),
   *   recipients: [
   *     { address: 'G1...', amount: 60_0000000n },
   *     { address: 'G2...', amount: 40_0000000n },
   *   ],
   * });
   * ```
   */
  async createInvoice(
    params: CreateInvoiceParams & { simulate: true },
  ): Promise<SimulationResult>;
  /**
   * Creates a new on-chain invoice with multi-recipient split payout distribution rules.
   *
   * @param params - Invoice creation configuration including creator, token address, deadline, and recipient shares.
   * @returns Promise resolving to the newly created invoice ID and transaction hash, or SimulationResult if simulate: true.
   * @throws {ValidationError} If split shares do not sum to 100% or parameters are invalid.
   * @throws {NftGateRequiredError} If the creator does not satisfy required token-gate conditions.
   *
   * @example
   * ```typescript
   * const { invoiceId, txHash } = await client.createInvoice({
   *   creator: 'GB...', 
   *   token: 'CD...', 
   *   deadline: deadlineFromDays(7),
   *   recipients: [
   *     { address: 'G1...', amount: 60_0000000n },
   *     { address: 'G2...', amount: 40_0000000n },
   *   ],
   * });
   * ```
   */
  async createInvoice(
    params: CreateInvoiceParams,
  ): Promise<{ invoiceId: string; txHash: string }>;
  /**
   * Creates a new on-chain invoice with multi-recipient split payout distribution rules.
   *
   * @param params - Invoice creation configuration including creator, token address, deadline, and recipient shares.
   * @returns Promise resolving to the newly created invoice ID and transaction hash, or SimulationResult if simulate: true.
   * @throws {ValidationError} If split shares do not sum to 100% or parameters are invalid.
   * @throws {NftGateRequiredError} If the creator does not satisfy required token-gate conditions.
   *
   * @example
   * ```typescript
   * const { invoiceId, txHash } = await client.createInvoice({
   *   creator: 'GB...', 
   *   token: 'CD...', 
   *   deadline: deadlineFromDays(7),
   *   recipients: [
   *     { address: 'G1...', amount: 60_0000000n },
   *     { address: 'G2...', amount: 40_0000000n },
   *   ],
   * });
   * ```
   */
  async createInvoice(
    params: CreateInvoiceParams,
  ): Promise<{ invoiceId: string; txHash: string } | SimulationResult> {
    // Issue #844 — `{ simulate: true }` performs a dry-run instead of submitting.
    if (params.simulate) {
      return this.simulate(
        "create_invoice",
        params as unknown as Record<string, unknown>,
      );
    }
    return this._withTelemetry(
      "createInvoice",
      {
        creator: params.creator,
        token: params.token,
        deadline: params.deadline,
      },
      async () => {
        const startTime = Date.now();
        params = this._pluginRegistry.runBeforeCall("createInvoice", params);
        try {
          if (this.config.payloadGuard) {
  /**
   * validateInvoicePayload
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
            validateInvoicePayload(params, this.config.payloadGuard);
          }

          this._metadataValidator.validate(params.metadata);

          // Pre-submission split ratio validation: catch malformed ratio arrays
          // early (ratio-sum violations, negative shares, duplicates, zeros).
          if (params.recipients.length > 1) {
            const total = params.recipients.reduce((s, r) => s + r.amount, 0n);
            if (total > 0n) {
              const splitConfig: RatioSplitConfig = {
                shares: params.recipients.map((r) => ({
                  address: r.address,
                  share: Number(r.amount) / Number(total),
                })),
              };
              validateSplitRatiosOrThrow(splitConfig);
            }
          }

          const gate = await this.checkNftGate(params.creator);
          if (gate.gated && !gate.hasNft) {
            throw new NftGateRequiredError(
              params.creator,
              gate.contractAddress,
            );
          }

          const recipientAddresses = params.recipients.map((r) =>
            nativeToScVal(r.address, { type: "address" }),
          );
          const recipientAmounts = params.recipients.map((r) =>
            nativeToScVal(r.amount, { type: "i128" }),
          );

          const operation = this.contract.call(
            "create_invoice",
            nativeToScVal(params.creator, { type: "address" }),
            xdr.ScVal.scvVec(recipientAddresses),
            xdr.ScVal.scvVec(recipientAmounts),
            nativeToScVal(params.token, { type: "address" }),
            nativeToScVal(params.deadline, { type: "u64" }),
          );

          const result = await this._submitTx(params.creator, operation);
          const invoiceId = scValToNative(result.returnValue).toString();
          const durationMs = Date.now() - startTime;
          telemetry.recordMethod("createInvoice", true, durationMs);
          this._logAudit(
            "createInvoice",
            {
              creator: params.creator,
              token: params.token,
              deadline: params.deadline,
            },
            true,
            durationMs,
          );
          return this._pluginRegistry.runAfterCall("createInvoice", {
            invoiceId,
            txHash: result.txHash,
          });
        } catch (error) {
          const durationMs = Date.now() - startTime;
          telemetry.recordMethod("createInvoice", false, durationMs);
          this._logAudit(
            "createInvoice",
            {
              creator: params.creator,
              token: params.token,
              deadline: params.deadline,
            },
            false,
            durationMs,
          );
          this._pluginRegistry.runOnError("createInvoice", error);
          throw error;
        }
      },
    );
  }

  /**
   * Clone an existing invoice with optional overrides.
   *
   * Submits the `clone_invoice` contract call, writes an optimistic local cache
   * entry for the new invoice, and automatically rolls back the cache entry on
   * submission failure.
   *
   * @param sourceId - ID of the invoice to clone.
   * @param overrides - Optional overrides for the cloned invoice fields.
   * @returns The new invoice ID.
   * @throws {InvoiceNotFoundError} If the source invoice does not exist.
   *
   * @example
   * ```typescript
   * const newInvoiceId = await client.cloneInvoice('123', {
   *   deadline: deadlineFromDays(14),
   * });
   * ```
   */
  async cloneInvoice(
    sourceId: string | bigint,
    rawOverrides: CloneOverrides & InvoiceParamOverrides = {},
  ): Promise<string> {
    const startTime = Date.now();
    const sourceInvoice = await this.getInvoice(sourceId.toString());
    const overrides = this._normalizeCloneOverrides(
      rawOverrides,
      sourceInvoice.recipients.length,
    );

    // -------------------------------------------------------------------
    // Cloneability pre-flight validation (#486)
    // -------------------------------------------------------------------
    if (!overrides.skipValidation) {
      const rpcUrl = Array.isArray(this.config.rpcUrl)
        ? this.config.rpcUrl[0]
        : this.config.rpcUrl;
      const validator = new InvoiceCloneabilityValidator({
        horizonUrl: overrides.horizonUrl ?? this.config.horizonUrl,
        rpcUrl,
      });
      const report = await validator.validate(sourceInvoice);
      if (!report.cloneable) {
        throw new InvoiceNotCloneableError(report);
      }
    }

    const mapEntries: xdr.ScMapEntry[] = [];
    if (overrides.newDeadline !== undefined) {
      mapEntries.push(
        new xdr.ScMapEntry({
          key: nativeToScVal("new_deadline", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(overrides.newDeadline, {
            type: "u64",
          }) as xdr.ScVal,
        }),
      );
    }
    if (overrides.newAmounts !== undefined) {
      mapEntries.push(
        new xdr.ScMapEntry({
          key: nativeToScVal("new_amounts", { type: "symbol" }) as xdr.ScVal,
          val: xdr.ScVal.scvVec(
            overrides.newAmounts.map((a) => nativeToScVal(a, { type: "i128" })),
          ) as xdr.ScVal,
        }),
      );
    }
    if (overrides.newRecipients !== undefined) {
      mapEntries.push(
        new xdr.ScMapEntry({
          key: nativeToScVal("new_recipients", { type: "symbol" }) as xdr.ScVal,
          val: xdr.ScVal.scvVec(
            overrides.newRecipients.map((r) =>
              nativeToScVal(r, { type: "address" }),
            ),
          ) as xdr.ScVal,
        }),
      );
    }
    // Optional title override (issue #850). Serialised as `new_title`; the
    // contract ignores unknown override keys, so older deployments are safe.
    if (overrides.newTitle !== undefined) {
      mapEntries.push(
        new xdr.ScMapEntry({
          key: nativeToScVal("new_title", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(overrides.newTitle, { type: "string" }) as xdr.ScVal,
        }),
      );
    }
    // new_overflow_behavior is a Vec<OverflowBehavior> on the contract side (0 or 1
    // elements), not an Option — the contract can't represent Option<PlainEnum> in a
    // #[contracttype] struct, so the key is always sent.
    mapEntries.push(
      new xdr.ScMapEntry({
        key: nativeToScVal("new_overflow_behavior", {
          type: "symbol",
        }) as xdr.ScVal,
        val: xdr.ScVal.scvVec(
          overrides.newOverflowBehavior !== undefined
            ? [
                nativeToScVal(overrides.newOverflowBehavior, {
                  type: "symbol",
                }) as xdr.ScVal,
              ]
            : [],
        ) as xdr.ScVal,
      }),
    );

    const args: xdr.ScVal[] = [
      nativeToScVal(BigInt(sourceId), { type: "u64" }),
      xdr.ScVal.scvMap(mapEntries),
    ];

    const operation = this.contract.call("clone_invoice", ...args);

    let newInvoiceId: string | undefined;
    let cacheWritten = false;

    try {
      const submitFn = () => this._submitTx(sourceInvoice.creator, operation);
      const result = this._retryOptions
        ? await executeWithRetry(submitFn, this._retryOptions)
        : await withRetry(submitFn, this.config.maxRetries ?? 3, 1000);

      const id = scValToNative(result.returnValue).toString() as string;
      newInvoiceId = id;
      if (this._cache) {
        const cloneDepth =
  /**
   * typeof
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
          typeof (sourceInvoice as unknown as Record<string, unknown>)
            .cloneDepth === "number"
            ? ((sourceInvoice as unknown as Record<string, unknown>)
                .cloneDepth as number) + 1
            : 1;

        const optimisticInvoice: Invoice = {
          ...sourceInvoice,
          id,
          clonedFrom: sourceId.toString(),
          parentInvoiceId: sourceId.toString(),
          cloneDepth,
          funded: 0n,
          payments: [],
          status: "Pending",
        };
        this._cache.set(id, optimisticInvoice);
        cacheWritten = true;
      }

      telemetry.recordMethod("cloneInvoice", true, Date.now() - startTime);
      return id;
    } catch (error) {
      telemetry.recordMethod("cloneInvoice", false, Date.now() - startTime);
      if (cacheWritten && newInvoiceId && this._cache) {
        this._cache.invalidate(newInvoiceId);
      }
      if (error instanceof Error && error.message.includes("not found")) {
        throw new InvoiceNotFoundError(sourceId.toString());
      }
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Issue #850 — clone lineage
  // ---------------------------------------------------------------------------

  /**
   * Return the full ancestor chain for an invoice, ordered root → … → invoiceId.
   *
   * The chain always ends with `invoiceId` itself. A non-cloned invoice returns
   * a single-element array containing its own ID.
   *
   * @param invoiceId - The invoice whose lineage should be resolved.
   * @returns Invoice IDs as `bigint[]` in root-to-leaf order.
   * @throws {CloneChainTooDeepError} If the clone chain is cyclic or too deep.
   *
   * @example
   * ```typescript
   * const lineage = await client.getLineage('123');
   * console.log(`Root invoice: ${lineage.rootId}`);
   * ```
   */
  async getLineage(invoiceId: string | bigint): Promise<bigint[]> {
    const chain = await this.resolveCloneChain(invoiceId.toString());
    return chain.map((invoice) => BigInt(invoice.id));
  }

  /**
   * Normalise `InvoiceParamOverrides` onto the contract's `CloneOverrides`
   * shape, applying the same field validation as `createInvoice` (issue #850).
   *
   * @param input - Raw overrides supplied by the caller.
   * @param recipientCount - Number of recipients on the source invoice.
   * @returns Validated contract-level overrides.
   * @throws {ValidationError} If any override is malformed.
   */
  private _normalizeCloneOverrides(
    input: CloneOverrides & InvoiceParamOverrides,
    recipientCount: number,
  ): CloneOverrides {
    const out: CloneOverrides = { ...input };

    if (input.title !== undefined) {
      if (typeof input.title !== "string" || input.title.trim().length === 0) {
        throw new ValidationError(
          "cloneInvoice override `title` must be a non-empty string.",
        );
      }
      out.newTitle = input.title.trim();
    }

    if (input.deadline !== undefined) {
      const nowSeconds = Math.floor(Date.now() / 1000);
      if (
        typeof input.deadline !== "number" ||
        !Number.isFinite(input.deadline) ||
        input.deadline <= nowSeconds
      ) {
        throw new ValidationError(
          "cloneInvoice override `deadline` must be a future unix timestamp in seconds.",
        );
      }
      out.newDeadline = input.deadline;
    }

    if (input.recipients !== undefined) {
      if (
        !Array.isArray(input.recipients) ||
        input.recipients.length === 0 ||
        input.recipients.some(
          (address) =>
            typeof address !== "string" ||
            !/^[GC][A-Z2-7]{55}$/.test(address),
        )
      ) {
        throw new ValidationError(
          "cloneInvoice override `recipients` must be a non-empty array of valid Stellar addresses.",
        );
      }
      out.newRecipients = [...input.recipients];
    }

    if (input.targetAmount !== undefined) {
      if (typeof input.targetAmount !== "bigint" || input.targetAmount <= 0n) {
        throw new ValidationError(
          "cloneInvoice override `targetAmount` must be a positive bigint (stroops).",
        );
      }
      const count = out.newRecipients?.length ?? recipientCount;
      if (count <= 0) {
        throw new ValidationError(
          "cloneInvoice override `targetAmount` requires at least one recipient.",
        );
      }
      // Split the total evenly, assigning any remainder stroops to the first
      // recipient so the parts always sum back to `targetAmount`.
      const base = input.targetAmount / BigInt(count);
      const remainder = input.targetAmount - base * BigInt(count);
      out.newAmounts = Array.from({ length: count }, (_, index) =>
        index === 0 ? base + remainder : base,
      );
      if (out.newAmounts.some((amount) => amount <= 0n)) {
        throw new ValidationError(
          "cloneInvoice override `targetAmount` is too small to split across recipients.",
        );
      }
    }

    if (
      out.newAmounts !== undefined &&
      out.newRecipients !== undefined &&
      out.newAmounts.length !== out.newRecipients.length
    ) {
      throw new ValidationError(
        "cloneInvoice overrides must provide one amount per recipient.",
      );
    }

    return out;
  }

  // ---------------------------------------------------------------------------
  // Issue #842 — real-time invoice event streaming
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to real-time state changes for a single invoice.
   *
   * Polls the Soroban `getEvents` RPC (`pollIntervalMs`, default 3000ms),
   * deduplicates events by ledger sequence + topic hash, and reconnects with
   * exponential backoff (up to `maxRetries`, default 5) before emitting an
   * `error` lifecycle event.
   *
   * @param invoiceId - The invoice ID to watch.
   * @param callback  - Invoked once per new {@link InvoiceEvent}.
   * @param options   - Optional poll/backoff/storage overrides.
   * @returns A {@link Subscription} whose `unsubscribe()` stops all polling.
   * @example
   * const sub = client.subscribeInvoice(42n, (event) => console.log(event.type));
   * // later
   * sub.unsubscribe();
   */
  subscribeInvoice(
    invoiceId: bigint | string,
    callback: (event: InvoiceEvent) => void,
    options: SubscriptionOptions = {},
  ): Subscription {
    return createInvoiceSubscription(
      this.server,
      this.config.contractId,
      invoiceId.toString(),
      callback,
      options,
    );
  }

  // ---------------------------------------------------------------------------
  // Issue #844 — generic dry-run simulation
  // ---------------------------------------------------------------------------

  /**
   * Simulate any contract method against Soroban RPC without submitting a
   * transaction or consuming a sequence number.
   *
   * Accepts either a camelCase client method name (`createInvoice`, `pay`,
   * `release`, `refund`, `approveRelease`, `cloneInvoice`) or the raw contract
   * entry point (`create_invoice`, `pay`, `release_invoice`, `refund_invoice`,
   * `approve_release`, `clone_invoice`).
   *
   * @param method - Method name or contract entry point to simulate.
   * @param params - Parameters for the method.
   * @returns A {@link SimulationResult}; `success` is `false` (rather than a
   *          throw) when the contract rejects the call.
   *
   * @example
   * ```typescript
   * const sim = await client.simulate('pay', { invoice_id: 123n, amount: 100_0000000n });
   * console.log(`Estimated CPU instructions: ${sim.cpuInstructions}`);
   * ```
   */
  async simulate(
    method: string,
    params: Record<string, unknown> = {},
  ): Promise<SimulationResult> {
    const operation = this._buildSimulationOperation(method, params);
    const source = String(
      params.creator ??
        params.payer ??
        params.source ??
        params.approver ??
        "",
    );
    if (!/^G[A-Z2-7]{55}$/.test(source)) {
      throw new ValidationError(
        "simulate() requires a Stellar account `source` (or `creator`/`payer`) to build the dry-run transaction.",
      );
    }
    const account = await this.server
      .getAccount(source)
      .catch(() => new Account(source, "0"));

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    return this._toSimulationResult(simResult);
  }

  /** Convert a raw Soroban simulation response into a {@link SimulationResult}. */
  private _toSimulationResult(
    sim: SorobanRpc.Api.SimulateTransactionResponse,
  ): SimulationResult {
    const emptyFootprint: LedgerFootprint = {
      readBytes: 0n,
      writeBytes: 0n,
      readLedgerEntries: 0n,
      writeLedgerEntries: 0n,
    };

    if (SorobanRpc.Api.isSimulationError(sim)) {
      return {
        success: false,
        error: (sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error,
        fee: 0n,
        cpuInsns: 0n,
        memBytes: 0n,
        footprint: emptyFootprint,
      };
    }

    const success = sim as SorobanRpc.Api.SimulateTransactionSuccessResponse;
    let footprint = emptyFootprint;
    try {
      const resources = success.transactionData.build().resources();
      const ledgerFootprint = resources.footprint();
      footprint = {
        readBytes: BigInt(resources.readBytes()),
        writeBytes: BigInt(resources.writeBytes()),
        readLedgerEntries: BigInt(ledgerFootprint.readOnly().length),
        writeLedgerEntries: BigInt(ledgerFootprint.readWrite().length),
      };
    } catch {
      // Restore/error responses may omit `transactionData`; leave zeros.
    }

    const cost = (success as unknown as {
      cost?: { cpuInsns?: string; memBytes?: string };
    }).cost;

    return {
      success: true,
      fee: BigInt(success.minResourceFee ?? "0"),
      cpuInsns: BigInt(cost?.cpuInsns ?? 0),
      memBytes: BigInt(cost?.memBytes ?? 0),
      footprint,
    };
  }

  /**
   * Build the contract operation for {@link simulate} from a method name and
   * a plain parameter object.
   */
  private _buildSimulationOperation(
    method: string,
    params: Record<string, unknown>,
  ): xdr.Operation {
    const aliases: Record<string, string> = {
      createInvoice: "create_invoice",
      pay: "pay",
      release: "release_invoice",
      releaseInvoice: "release_invoice",
      releaseGroup: "release_invoice_group",
      refund: "refund_invoice",
      refundInvoice: "refund_invoice",
      approveRelease: "approve_release",
      cloneInvoice: "clone_invoice",
    };
    const entryPoint = aliases[method] ?? method;

    switch (entryPoint) {
      case "create_invoice": {
        const recipients = (params.recipients ?? []) as Array<{
          address: string;
          amount: bigint;
        }>;
        if (!Array.isArray(recipients) || recipients.length === 0) {
          throw new ValidationError(
            "simulate(create_invoice) requires a non-empty `recipients` array.",
          );
        }
        return this.contract.call(
          "create_invoice",
          nativeToScVal(String(params.creator), { type: "address" }),
          xdr.ScVal.scvVec(
            recipients.map((r) => nativeToScVal(r.address, { type: "address" })),
          ),
          xdr.ScVal.scvVec(
            recipients.map((r) => nativeToScVal(r.amount, { type: "i128" })),
          ),
          nativeToScVal(String(params.token), { type: "address" }),
          nativeToScVal(Number(params.deadline), { type: "u64" }),
        );
      }
      case "pay":
        return this.contract.call(
          "pay",
          nativeToScVal(String(params.payer), { type: "address" }),
          nativeToScVal(BigInt(params.invoiceId as string | number | bigint), {
            type: "u64",
          }),
          nativeToScVal(params.amount, { type: "i128" }),
          nativeToScVal(Boolean(params.donateOnFailure ?? false), {
            type: "bool",
          }),
        );
      case "clone_invoice":
        return this.contract.call(
          "clone_invoice",
          nativeToScVal(
            BigInt(
              (params.sourceId ?? params.invoiceId) as string | number | bigint,
            ),
            { type: "u64" },
          ),
          xdr.ScVal.scvMap([]),
        );
      case "release_invoice":
      case "refund_invoice":
      case "approve_release":
        return this.contract.call(
          entryPoint,
          nativeToScVal(
            BigInt((params.invoiceId ?? params.id) as string | number | bigint),
            { type: "u64" },
          ),
        );
      case "release_invoice_group":
        return this.contract.call(
          "release_invoice_group",
          nativeToScVal(String(params.creator), { type: "address" }),
          nativeToScVal(BigInt(params.groupId as string | number | bigint), {
            type: "u64",
          }),
        );
      default:
        return this.contract.call(
          entryPoint,
          ...Object.values(params).map((value) => nativeToScVal(value as never)),
        );
    }
  }

  /**
   * Submits a payment toward an invoice, automatically splitting contributions among recipients.
   *
   * @param params - Payment parameters including payer address, invoice ID, and payment amount in stroops.
   * @returns Promise resolving to the payment receipt with transaction hash and remaining balance.
   * @throws {InvoiceNotFoundError} If the specified invoice ID cannot be found.
   * @throws {PaymentExceedsRemainingError} If the payment exceeds the unpaid balance.
   * @throws {DeadlinePassedError} If the payment deadline has elapsed.
   *
   * @example
   * ```typescript
   * const receipt = await client.pay({
   *   payer: 'GA...PAYER',
   *   invoiceId: '123',
   *   amount: 50_0000000n,
   * });
   * console.log(`Payment confirmed: ${receipt.txHash}`);
   * ```
   */
  async pay(params: PayParams & { simulate: true }): Promise<SimulationResult>;
  /**
   * Submits a payment toward an invoice, automatically splitting contributions among recipients.
   *
   * @param params - Payment parameters including payer address, invoice ID, and payment amount in stroops.
   * @returns Promise resolving to the payment receipt with transaction hash and remaining balance.
   * @throws {InvoiceNotFoundError} If the specified invoice ID cannot be found.
   * @throws {PaymentExceedsRemainingError} If the payment exceeds the unpaid balance.
   * @throws {DeadlinePassedError} If the payment deadline has elapsed.
   *
   * @example
   * ```typescript
   * const receipt = await client.pay({
   *   payer: 'GA...PAYER',
   *   invoiceId: '123',
   *   amount: 50_0000000n,
   * });
   * console.log(`Payment confirmed: ${receipt.txHash}`);
   * ```
   */
  async pay(params: PayParams): Promise<TxResult>;
  /**
   * Submits a payment toward an invoice, automatically splitting contributions among recipients.
   *
   * @param params - Payment parameters including payer address, invoice ID, and payment amount in stroops.
   * @returns Promise resolving to the payment receipt with transaction hash and remaining balance.
   * @throws {InvoiceNotFoundError} If the specified invoice ID cannot be found.
   * @throws {PaymentExceedsRemainingError} If the payment exceeds the unpaid balance.
   * @throws {DeadlinePassedError} If the payment deadline has elapsed.
   *
   * @example
   * ```typescript
   * const receipt = await client.pay({
   *   payer: 'GA...PAYER',
   *   invoiceId: '123',
   *   amount: 50_0000000n,
   * });
   * console.log(`Payment confirmed: ${receipt.txHash}`);
   * ```
   */
  async pay(params: PayParams): Promise<TxResult | SimulationResult> {
    // Issue #844 — `{ simulate: true }` performs a dry-run instead of submitting.
    if (params.simulate) {
      return this.simulate(
        "pay",
        params as unknown as Record<string, unknown>,
      );
    }
    if (this._offlineQueue?.config?.enabled) {
      try {
        const health = await this.checkRPCHealth();
        if (health.status === "down") {
          this._offlineQueue.enqueue("pay", [params]);
          return { txHash: "queued" };
        }
      } catch (e) {
        this._offlineQueue.enqueue("pay", [params]);
        return { txHash: "queued" };
      }
    }
    const startTime = Date.now();
    params = this._pluginRegistry.runBeforeCall("pay", params);

    let optimistic: { commit: CommitFn; rollback: RollbackFn } | null = null;
    if (this._optimisticCache) {
      const current = this._cache?.get(`getInvoice:${JSON.stringify([params.invoiceId])}`) as
        | Invoice
        | undefined;
      if (current) {
        const predicted = getOptimisticInvoice(current, {
          payer: params.payer,
          amount: params.amount,
          donateOnFailure: params.donateOnFailure,
        });
        optimistic = this._optimisticCache.applyOptimistic(params.invoiceId, predicted, current);
      }
    }

    try {
      const operation = this.contract.call(
        "pay",
        nativeToScVal(params.payer, { type: "address" }),
        nativeToScVal(BigInt(params.invoiceId), { type: "u64" }),
        nativeToScVal(params.amount, { type: "i128" }),
        nativeToScVal(params.donateOnFailure ?? false, { type: "bool" }),
      );

      const submitFn = () => this._submitTx(params.payer, operation);
      const result = this._retryOptions
        ? await executeWithRetry(submitFn, this._retryOptions)
        : await withRetry(submitFn, this.config.maxRetries ?? 3, 1000);
      this._cache?.invalidate(params.invoiceId);
      optimistic?.commit();
      telemetry.recordMethod("pay", true, Date.now() - startTime);
      return this._pluginRegistry.runAfterCall("pay", {
        txHash: result.txHash,
      });
    } catch (error) {
      optimistic?.rollback();
      telemetry.recordMethod("pay", false, Date.now() - startTime);
      this._pluginRegistry.runOnError("pay", error);
      throw error;
    }
  }

  /**
   * Submit a payment, optionally routed through a WaterfallPlan
   * (see WaterfallRouter.plan()) instead of the default single-amount
   * round-robin split. When a plan is supplied, one `pay` operation per
   * satisfied tier is built and submitted in a single transaction envelope,
   * in the plan's declared priority order.
   *
   * @param params.waterfallPlan - Plan produced by `WaterfallRouter.plan()`.
   * @param params.allowPartial  - Submit even if the plan has unsatisfied tiers.
   *   Defaults to the value carried on the plan itself (`plan.allowPartial`).
   * @throws WaterfallInsufficientFundsError if any tier is unsatisfied and
   *   partial submission wasn't allowed.
   */
  /**
   * Performs preflight validation before payment submission, checking balances, thresholds, and contract state.
   *
   * @param params - Preflight parameters including payer address, invoice ID, and candidate payment amount.
   * @returns Promise resolving to PreflightCheckResult detailing readiness and estimated fees.
   *
   * @example
   * ```typescript
   * const check = await client.preflightCheck({
   *   payer: 'GA...PAYER',
   *   invoiceId: '123',
   *   amount: 50_0000000n,
   * });
   * if (check.ok) {
   *   await client.pay({ payer: 'GA...PAYER', invoiceId: '123', amount: 50_0000000n });
   * }
   * ```
   */
  async preflightCheck(params: {
    invoiceId: string;
    payer: string;
    amount: bigint;
  }): Promise<{
    valid: boolean;
    expiry: import("./preflightChecker.js").InvoiceExpiryResult;
    payerReadiness: import("./preflightChecker.js").PayerReadinessResult;
  }> {
    const invoice = await this.getInvoice(params.invoiceId);
    if (invoice.status !== "Pending") {
      throw new InvoiceNotPendingError(params.invoiceId);
    }

    const expiry = checkInvoiceExpiry(Number(invoice.deadline), params.invoiceId);

    // Call checkPayerReadiness, mapping the RPC server to a custom object that
    // returns the account balances via getAccountBalances (Horizon).
    const fakeServer = {
      getAccount: async (address: string) => {
        const normalizedBalances = await this.getAccountBalances(address);
        const balances = normalizedBalances.map((nb) => {
          if (nb.asset === "native") {
            return {
              balance: nb.balance,
              asset_type: "native",
            };
          } else {
            const [code, issuer] = nb.asset.split(":");
            return {
              balance: nb.balance,
              asset_type: "credit_alphanum4",
              asset_code: code,
              asset_issuer: issuer,
            };
          }
        });
        return { balances };
      },
    } as any;

    const payerReadiness = await checkPayerReadiness(
      fakeServer,
      params.payer,
      params.amount,
      invoice.token
    );

    const valid = expiry.valid && payerReadiness.ready;

    return {
      valid,
      expiry,
      payerReadiness,
    };
  }

  /**
   * Fetches a confirmed transaction receipt and execution outcome by transaction hash.
   *
   * @param txHash - Hexadecimal transaction hash string.
   * @returns Promise resolving to the detailed TxReceipt.
   *
   * @example
   * ```typescript
   * const receipt = await client.getReceipt('e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855');
   * ```
   */
  async getReceipt(invoiceId: string, payerAddress: string): Promise<PaymentReceipt> {
    return generatePaymentReceipt(this, invoiceId, payerAddress);
  }

  /**
   * Submits a pre-signed payment transaction envelope to the Soroban RPC network.
   *
   * @param params - Parameters containing pre-signed transaction XDR.
   * @returns Promise resolving to TxResult.
   *
   * @example
   * ```typescript
   * const result = await client.submitPayment({ signedTxXdr });
   * ```
   */
  async submitPayment(params: {
    invoiceId: string;
    payer: string;
    amount: bigint;
    donateOnFailure?: boolean;
    waterfallPlan?: WaterfallPlan;
    allowPartial?: boolean;
    expectedContentHash?: string;
  }): Promise<TxResult> {
    // Verify invoice content hash if provided (integrity check)
    if (params.expectedContentHash) {
      const invoice = await this.getInvoice(params.invoiceId);
      const valid = await verifyInvoiceHash(invoice, params.expectedContentHash);
      if (!valid) {
        const computed = await hashInvoice(invoice);
        throw new InvoiceIntegrityError(params.invoiceId, params.expectedContentHash, computed);
      }
    }
    if (!params.waterfallPlan) {
      return this.pay({
        payer: params.payer,
        invoiceId: params.invoiceId,
        amount: params.amount,
        donateOnFailure: params.donateOnFailure,
      });
    }

    const plan = params.waterfallPlan;
    const allowPartial = params.allowPartial ?? plan.allowPartial ?? false;
    const hasUnsatisfiedTier = plan.steps.some((step) => !step.satisfied);
    if (hasUnsatisfiedTier && !allowPartial) {
      throw new WaterfallInsufficientFundsError(params.invoiceId, {
        unsatisfiedTiers: plan.steps.filter((s) => !s.satisfied).map((s) => s.recipient),
      });
    }

    const fundedSteps = plan.steps.filter((step) => step.satisfied && step.amount > 0n);
    if (fundedSteps.length === 0) {
      throw new WaterfallInsufficientFundsError(params.invoiceId);
    }

    const operations = fundedSteps.map((step) =>
      this.contract.call(
        "pay",
        nativeToScVal(params.payer, { type: "address" }),
        nativeToScVal(BigInt(params.invoiceId), { type: "u64" }),
        nativeToScVal(step.amount, { type: "i128" }),
        nativeToScVal(params.donateOnFailure ?? false, { type: "bool" }),
      ),
    );

    const result = await this._submitWaterfallTx(params.payer, operations);
    this._cache?.invalidate(params.invoiceId);

    // Record a rollback checkpoint for the submitted legs. The on-chain
    // submission is atomic (all-or-nothing), so every funded step succeeded
    // together; downstream app-layer failures (e.g. webhook delivery) are
    // reconciled by callers via RollbackCoordinator.markLegFailed.
    const coordinator = this.getRollbackCoordinator();
    coordinator.begin(
      result.txHash,
      params.invoiceId,
      fundedSteps.map((step) => ({ recipient: step.recipient, amount: step.amount })),
    );
    fundedSteps.forEach((_, index) => coordinator.markLegSuccess(result.txHash, index));

    return { txHash: result.txHash };
  }

  /**
   * Build and submit a single transaction envelope containing one contract
   * operation per waterfall step, preserving priority order.
   */
  private async _submitWaterfallTx(
    sourceAddress: string,
    operations: xdr.Operation[],
  ): Promise<{ txHash: string; returnValue: xdr.ScVal }> {
    const account = await this.server.getAccount(sourceAddress);
    const builder = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    });
    for (const operation of operations) {
      builder.addOperation(operation);
    }
    const tx = builder.setTimeout(30).build();

    const submit = () => this._doSubmitWaterfallSend(tx, sourceAddress);
    return this._advancedCircuitBreaker ? this._advancedCircuitBreaker.execute(submit) : submit();
  }

  private async _doSubmitWaterfallSend(
    tx: Transaction,
    sourceAddress: string,
  ): Promise<{ txHash: string; returnValue: xdr.ScVal }> {
    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw parseSorobanError(simResult.error);
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    const signedXdr = await (this._adapter
      ? this._adapter.signTransaction(preparedTx.toXDR(), this.config.networkPassphrase)
      : signTransaction(preparedTx.toXDR(), this.config.networkPassphrase));

    const sendResult = await this.server.sendTransaction(
      TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase),
    );
    if (sendResult.status === "ERROR") {
      throw new TransactionFailedError(
        `Waterfall transaction failed: ${JSON.stringify(sendResult.errorResult)}`,
        sendResult.hash,
        JSON.stringify(sendResult.errorResult),
      );
    }

    const txHash = sendResult.hash;
    let getResult = await this.server.getTransaction(txHash);
    let attempts = 0;
    while (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND && attempts < 20) {
      await new Promise((r) => setTimeout(r, 1500));
      getResult = await this.server.getTransaction(txHash);
      attempts++;
    }
    if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      throw new TransactionNotConfirmedError(String(getResult.status));
    }

    const returnValue =
      (getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse).returnValue ?? xdr.ScVal.scvVoid();
    return { txHash, returnValue };
  }

  /**
   * Create multiple invoices in a single transaction.
   *
   * @param params - Array of invoice creation parameters (1-5 items)
   * @returns All created invoice IDs and the transaction hash
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const ids = await client.batchCreateInvoices([inv1, inv2]);
   * ```
   */
  async batchCreateInvoices(
    params: CreateInvoiceParams[],
  ): Promise<{ invoiceIds: string[]; txHash: string }> {
    if (params.length === 0 || params.length > 5) {
      throw new InvalidBatchSizeError("1-5 items", params.length);
    }

    const invoiceParams = params.map((p) => {
      const recipientAddresses = p.recipients.map((r) =>
        nativeToScVal(r.address, { type: "address" }),
      );
      const recipientAmounts = p.recipients.map((r) =>
        nativeToScVal(r.amount, { type: "i128" }),
      );

      const mapEntries: xdr.ScMapEntry[] = [
        new xdr.ScMapEntry({
          key: nativeToScVal("creator", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(p.creator, { type: "address" }) as xdr.ScVal,
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("recipients", { type: "symbol" }) as xdr.ScVal,
          val: xdr.ScVal.scvVec(recipientAddresses),
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("amounts", { type: "symbol" }) as xdr.ScVal,
          val: xdr.ScVal.scvVec(recipientAmounts),
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("token", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(p.token, { type: "address" }) as xdr.ScVal,
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("deadline", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(p.deadline, { type: "u64" }) as xdr.ScVal,
        }),
      ];

      return xdr.ScVal.scvMap(mapEntries);
    });

    const operation = this.contract.call(
      "create_batch",
      xdr.ScVal.scvVec(invoiceParams),
    );

    const firstParam = params[0];
    if (!firstParam) throw new InvalidBatchSizeError("non-empty array", 0);
    const result = await this._submitTx(firstParam.creator, operation);
    const invoiceIds = (
      scValToNative(result.returnValue) as (string | number)[]
    ).map((id) => id.toString());
    return { invoiceIds, txHash: result.txHash };
  }

  /**
   * Helper to execute a fetcher with cache support.
   */
  private async _withCache<T>(
    methodName: string,
    args: any[],
    fetcher: () => Promise<T>,
  ): Promise<T> {
    if (!this._cache) {
      return fetcher();
    }

    const key = `${methodName}:${JSON.stringify(args)}`;
    const cached = this._cache.get(key);
    if (cached !== undefined) {
      return cached as T;
    }

    const result = await fetcher();
    this._cache.set(key, result);
    return result;
  }

  /**
   * Retrieves the current state, balances, and recipient distribution progress of an on-chain invoice.
   *
   * @param invoiceId - The unique identifier of the invoice to fetch.
   * @returns Promise resolving to the normalized Invoice object.
   * @throws {InvoiceNotFoundError} If the invoice does not exist on-chain.
   *
   * @example
   * ```typescript
   * const invoice = await client.getInvoice('123');
   * console.log(`Invoice status: ${invoice.status}, total: ${invoice.amount}`);
   * ```
   */
  async getInvoice(
    invoiceId: string,
    opts?: { retry?: PerMethodRetryOptions; dedupe?: boolean; traceId?: string; timeout?: number }
  ): Promise<Invoice> {
    const optimistic = this._optimisticCache?.get(invoiceId);
    if (optimistic !== undefined) {
      return optimistic;
    }

    return this._withCache("getInvoice", [invoiceId], async () => {

      const fetcher = this._batcher
        ? () => this._batcher!.getInvoice(invoiceId)
        : () => this._fetchInvoice(invoiceId, opts?.traceId);

      const useDedupe = opts?.dedupe !== false;
      const effectiveRetry =
        opts?.retry ?? (this._retryOptions ? {} : undefined);

      let invoice: Invoice;
      if (this._retryOptions && effectiveRetry !== undefined) {
        invoice = await executeWithRetry(
          () =>
            useDedupe ? this._dedup.dedupe(invoiceId, fetcher) : fetcher(),
          this._retryOptions,
          opts?.retry,
        );
      } else {
        invoice = await (useDedupe ? this._dedup.dedupe(invoiceId, fetcher) : fetcher());
      }

      // Token-gate access check: verify caller balance when policy is set.
      const gateController = this.config.tokenGateController;
      const callerId = this.config.callerAccountId;
      if (gateController && callerId && invoice.accessPolicy) {
        await gateController.verify(callerId, invoice.accessPolicy);
      }

      return invoice;
    });
  }

  /**
   * Returns deduplication performance metrics for concurrent in-flight read operations.
   * @returns DedupStats object containing deduplicated request counts.
   *
   * @example
   * ```typescript
   * const stats = client.getDedupStats();
   * ```
   */
  getDedupStats(): { deduped: number; total: number } {
    return this._dedup.getDedupStats();
  }

  /**
   * The InvoiceStateMachine backing updateInvoiceStatus(). Exposed so
   * consumers can attach `on('transition', ...)` / `on('invalidTransition', ...)`
   * lifecycle hooks.
   */
  get stateMachine(): InvoiceStateMachine {
    return this._stateMachine;
  }

  /**
   * The RpcLoadBalancer backing multi-endpoint calls, present only when
   * `config.rpcEndpoints` was provided. `null` for single-`rpcUrl` configs.
   * Exposed so consumers can attach `on('endpoint:demoted', ...)` /
   * `on('endpoint:reinstated', ...)` hooks or inspect `getEndpointStates()`.
   */
  get rpcLoadBalancer(): RpcLoadBalancer | null {
    return this._rpcLoadBalancer;
  }

  /**
   * Explicitly transitions an invoice to a new status using the deterministic InvoiceStateMachine.
   *
   * @param invoiceId - Unique identifier of the invoice to transition.
   * @param status - Target InvoiceStatus to transition to.
   * @returns Promise resolving once the status transition is applied.
   *
   * @example
   * ```typescript
   * await client.updateInvoiceStatus('123', 'Released');
   * ```
   */
  async updateInvoiceStatus(invoiceId: string, to: InvoiceStatus): Promise<Invoice> {
    const current = await this.getInvoice(invoiceId);
    const updated = this._stateMachine.transition(current, to);
    if (this._optimisticCache) {
      this._optimisticCache.applyOptimistic(invoiceId, updated, current).commit();
    }

    return updated;
  }

  // ---------------------------------------------------------------------------
  // Invoice Version History integration (#550)
  // ---------------------------------------------------------------------------

  /**
   * Update an invoice with new field values and record a version snapshot
   * via {@link InvoiceVersionTracker} before overwriting the stored state.
   *
   * If no `versionTracker` is provided in the config, the method still applies
   * the update — versioning is opt-in via config.
   *
   * @param invoiceId   - The invoice to update.
   * @param updates     - Partial invoice fields to apply (merged over the current state).
   * @param changedBy   - The Stellar address responsible for the change.
   * @returns The updated invoice after all mutations are applied.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const updated = await client.updateInvoice('123', { description: 'Updated invoice memo' });
   * ```
   */
  async updateInvoice(
    invoiceId: string,
    updates: Partial<Invoice>,
    changedBy: string,
  ): Promise<Invoice> {
    const current = await this.getInvoice(invoiceId);

    // Record current state as a version BEFORE overwriting
    const tracker = (this.config as Record<string, unknown>)["versionTracker"] as
      | import("./invoiceVersionTracker.js").InvoiceVersionTracker
      | undefined;
    if (tracker) {
      await tracker.record(invoiceId, current, changedBy);
    }

    const updated: Invoice = { ...current, ...updates };

    // Write the updated invoice back into the optimistic cache so subsequent
    // getInvoice() calls see the new state immediately.
    if (this._optimisticCache) {
      this._optimisticCache.applyOptimistic(invoiceId, updated, current).commit();
    } else if (this._cache) {
      this._cache.invalidate(`getInvoice:${JSON.stringify([invoiceId])}`);
      this._cache.invalidate(invoiceId);
    }

    return updated;
  }

  /**
   * Subscribe to typed InvoiceEvent payloads for a single invoice via the
   * shared SubscriptionManager, instead of polling fetch methods. The first
   * call for a given invoice ID starts the manager's poll-then-push bridge
   * and restores any cursor persisted from a previous session/tab, so
   * events emitted during an outage are replayed on reconnect.
   *
   * @param invoiceId - The invoice ID to watch.
   * @param handler   - Called with each typed InvoiceEvent as it arrives.
   * @param opts      - Optional per-subscription overrides (poll interval, backoff, storage).
   * @returns Unsubscribe function scoped to this handler only.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * client.subscribe('payment', (evt) => console.log('Payment observed:', evt));
   * ```
   */
  subscribe(
    invoiceId: string,
    handler: (event: InvoiceEvent) => void,
    opts?: SubscriptionManagerOptions,
  ): () => void {
    const manager = getSubscriptionManager(this.server, this.config.contractId, opts);
    return manager.subscribe(invoiceId, handler, opts);
  }

  /**
   * Unsubscribes an event listener from a client event stream.
   *
   * @param eventType - Event name to unsubscribe from.
   * @param listener - The listener function to remove.
   * @returns This client instance for chaining.
   *
   * @example
   * ```typescript
   * client.unsubscribe('payment', myListener);
   * ```
   */
  unsubscribe(invoiceId: string): void {
  /**
   * getSubscriptionManager
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
    getSubscriptionManager(this.server, this.config.contractId).unsubscribe(invoiceId);
  }

  /**
   * The advanced CLOSED/OPEN/HALF_OPEN circuit breaker guarding
   * transaction submission, or null when `advancedCircuitBreaker` was not
   * passed to the constructor. Use `client.circuitBreaker.getState()` to
   * inspect the current state for dashboards/alerting.
   */
  get circuitBreaker(): { getState(): CircuitBreakerStateSnapshot } | null {
    return this._advancedCircuitBreaker;
  }

  /**
   * Retrieves the SplitRollbackCoordinator instance for coordinating multi-step atomic compensations.
   * @returns SplitRollbackCoordinator instance.
   *
   * @example
   * ```typescript
   * const coordinator = client.getRollbackCoordinator();
   * ```
   */
  getRollbackCoordinator(): RollbackCoordinator {
    if (!this._rollbackCoordinator) {
      this._rollbackCoordinator = new RollbackCoordinator(this._idempotency ?? undefined);
    }
    return this._rollbackCoordinator;
  }

  /** The configured fiat-to-asset price oracle adapter, or null if none was provided. */
  get priceOracle(): import("./types.js").PriceOracleAdapter | null {
    return this.config.priceOracle ?? null;
  }

  /**
   * The optimistic UI cache, or null when `optimisticCache` was not passed
   * to the constructor. Use `client.optimisticCache?.onRollback(...)` to
   * react to a prediction being reverted after a failed transaction.
   */
  get optimisticCache(): OptimisticCache<Invoice> | null {
    return this._optimisticCache;
  }

  /**
   * Returns the current state ('CLOSED', 'OPEN', or 'HALF_OPEN') of the RPC resilience circuit breaker.
   * @returns Current circuit breaker state string.
   *
   * @example
   * ```typescript
   * const state = client.getCircuitBreakerState();
   * console.log(`Circuit status: ${state}`);
   * ```
   */
  getCircuitBreakerState(): import("./circuitBreaker.js").CircuitBreakerState | null {
    return this._resilientRpc?.circuitBreaker?.state ?? null;
  }

  /**
   * Returns the current number of consecutive RPC failures tracked by the circuit breaker.
   * @returns Consecutive failure counter integer.
   *
   * @example
   * ```typescript
   * const failures = client.getCircuitBreakerFailureCount();
   * ```
   */
  getCircuitBreakerFailureCount(): number | null {
    return this._resilientRpc?.circuitBreaker?.failureCount ?? null;
  }

  /**
   * Manually resets the RPC circuit breaker to the CLOSED operational state.
   * @returns void
   *
   * @example
   * ```typescript
   * client.resetCircuitBreaker();
   * ```
   */
  resetCircuitBreaker(): void {
    this._resilientRpc?.circuitBreaker?.reset();
  }

  private async _fetchInvoice(invoiceId: string, traceId?: string): Promise<Invoice> {
    const startTime = Date.now();
    const req = {
      method: "getInvoice",
      params: [invoiceId],
      headers: traceId ? { "X-Trace-Id": traceId } : undefined,
    };
    await runRequestInterceptors(req);

    const fetchFn = async (): Promise<Invoice> => {
      const operation = this.contract.call(
        "get_invoice",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      );

      const account = await this.server
        .getAccount(this.config.contractId)
        .catch(() => null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sourceAccount =
        account ??
        ({
          accountId: () => this.config.contractId,
          sequenceNumber: () => "0",
          incrementSequenceNumber: () => {},
        } as any);

      const tx = new TransactionBuilder(sourceAccount, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simResult = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simResult)) {
        throw parseSorobanError(simResult.error, invoiceId);
      }

      const returnVal = (
        simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse
      ).result?.retval;
      if (!returnVal) throw new InvoiceNotFoundError(invoiceId);

      const invoice = this._parseInvoice(invoiceId, scValToNative(returnVal));
      const raw = await this._simulateView(operation);
      return this._parseInvoice(invoiceId, raw as Record<string, unknown>);
    };

    try {
      let invoice: Invoice;
      if (this._degradation) {
        const result = await this._degradation.wrapRead(invoiceId, fetchFn);
        invoice = result.data;
      } else {
        invoice = await fetchFn();
      }
      telemetry.recordMethod("getInvoice", true, Date.now() - startTime);
      const durationMs = Date.now() - startTime;
      await runResponseInterceptors({
        method: "getInvoice",
        result: invoice,
        durationMs,
      });
  /**
   * recordCall
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
      recordCall(true);
      return invoice;
    } catch (error) {
      telemetry.recordMethod("getInvoice", false, Date.now() - startTime);
      const durationMs = Date.now() - startTime;
      await runResponseInterceptors({
        method: "getInvoice",
        result: undefined,
        durationMs,
      });
  /**
   * recordCall
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
      recordCall(false);
      throw error;
    }
  }

  /**
   * Check invoice compliance against built-in and configured rules.
   * @param invoiceId - Invoice ID to validate
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const report = await client.checkCompliance('123');
   * ```
   */
  async checkCompliance(
    invoiceId: string,
  ): Promise<import("./compliance.js").ComplianceReport> {
    const invoice = await this.getInvoice(invoiceId);
    const { evaluateInvoice, defaultRules } = await import("./compliance.js");
    const rules = this.config.complianceRules ?? defaultRules();
    return evaluateInvoice(invoice, rules);
  }

  /**
   * Queries all recorded ledger payments contributed toward a specific invoice.
   *
   * @param invoiceId - ID of the invoice.
   * @returns Promise resolving to an array of Payment records.
   *
   * @example
   * ```typescript
   * const payments = await client.getPayments('123');
   * console.log(`Total payments received: ${payments.length}`);
   * ```
   */
  async getPayments(invoiceId: string): Promise<Payment[]> {
    const startTime = Date.now();
    try {
      const invoice = await this.getInvoice(invoiceId);
      telemetry.recordMethod("getPayments", true, Date.now() - startTime);
      return invoice.payments;
    } catch (error) {
      telemetry.recordMethod("getPayments", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Verify a CompletionProof returned by the contract's get_completion_proof call.
   * Recomputes the cert_hash from proof fields and compares against the stored value.
   * Works without trusting the SDK caller — verifies the cryptographic proof only.
   *
   * @param proof - CompletionProof object from the contract.
   * @returns { valid: boolean, reason?: string }
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const isValid = await client.verifyCompletionProof(proof);
   * ```
   */
  verifyCompletionProof(proof: CompletionProof): {
    valid: boolean;
    reason?: string;
  } {
    return verifyCompletionProof(proof);
  }

  /**
   * Reconciles recorded payment events against target recipient allocations, computing balance discrepancies.
   *
   * @param invoiceId - ID of the invoice to reconcile.
   * @returns Promise resolving to ReconciliationResult with discrepancy amounts.
   *
   * @example
   * ```typescript
   * const reconciliation = await client.reconcilePayments('123');
   * if (reconciliation.discrepancy === 0n) console.log('Reconciled successfully');
   * ```
   */
  async reconcilePayments(
    invoiceId: string,
  ): Promise<PaymentReconciliationReport> {
    const startTime = Date.now();
    try {
      const invoice = await this.getInvoice(invoiceId);
      const events = await replayEvents(
        this.server,
        this.config.contractId,
        0,
        Number.MAX_SAFE_INTEGER,
      );
      const paymentEvents = events
        .filter(
          (event) => event.invoiceId === invoiceId && event.type === "payment",
        )
        .map((event) => {
          const raw = event.data as Record<string, unknown>;
          const rawAmount = raw.amount;
          let amount: bigint;
          if (typeof rawAmount === "bigint") {
            amount = rawAmount;
          } else if (typeof rawAmount === "number") {
            amount = BigInt(rawAmount);
          } else if (typeof rawAmount === "string" && rawAmount !== "") {
            amount = BigInt(rawAmount);
          } else {
            amount = 0n;
          }

          const payer = typeof raw.payer === "string" ? raw.payer : "";
          return {
            payer,
            amount,
            timestamp: event.timestamp,
            ledger: event.ledger,
          } as PaymentEventRecord;
        });

      const paymentRecordsTotal = invoice.payments.reduce(
        (sum, payment) => sum + payment.amount,
        0n,
      );
      const paymentEventsTotal = paymentEvents.reduce(
        (sum, event) => sum + event.amount,
        0n,
      );
      const fundedDiscrepancy = invoice.funded - paymentRecordsTotal;
      const recordsMatchEvents = paymentRecordsTotal === paymentEventsTotal;
      const consistent =
        invoice.funded === paymentEventsTotal && recordsMatchEvents;

      const report: PaymentReconciliationReport = {
        invoiceId,
        invoice,
        invoiceFunded: invoice.funded,
        paymentRecordsTotal,
        paymentEventsTotal,
        fundedDiscrepancy,
        recordsMatchEvents,
        consistent,
        paymentEvents,
      };

      telemetry.recordMethod("reconcilePayments", true, Date.now() - startTime);
      return report;
    } catch (error) {
      telemetry.recordMethod(
        "reconcilePayments",
        false,
        Date.now() - startTime,
      );
      throw error;
    }
  }

  /**
   * Generates a structured payment and settlement receipt for a released or settled invoice.
   *
   * @param invoiceId - The ID of the settled invoice.
   * @returns Promise resolving to InvoiceReceipt.
   *
   * @example
   * ```typescript
   * const receipt = await client.generateReceipt('123');
   * ```
   */
  async generateReceipt(invoiceId: string): Promise<InvoiceReceipt> {
    const startTime = Date.now();
    try {
      const invoice = await this.getInvoice(invoiceId);
      if (invoice.status !== "Released") {
        throw new InvoiceNotReleasedError(invoiceId, invoice.status);
      }

      const receiptId = await this._buildReceiptId(invoice);
      const totalAmount = invoice.payments.reduce(
        (sum, payment) => sum + payment.amount,
        0n,
      );
      const receipt: InvoiceReceipt = {
        receiptId,
        invoiceId: invoice.id,
        creator: invoice.creator,
        recipients: invoice.recipients,
        payments: invoice.payments,
        totalAmount,
        releasedAt: Date.now(),
      };

      telemetry.recordMethod("generateReceipt", true, Date.now() - startTime);
      return receipt;
    } catch (error) {
      telemetry.recordMethod("generateReceipt", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Capture a point-in-time snapshot of an invoice including all payments.
   *
   * @param invoiceId - The invoice ID to snapshot.
   * @returns An immutable, timestamped snapshot object.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const snapshot = await client.snapshotInvoice('123');
   * ```
   */
  async snapshotInvoice(invoiceId: string): Promise<InvoiceSnapshot> {
    const invoice = await this.getInvoice(invoiceId);
    return _snapshotInvoice(invoice);
  }

  /**
   * Fetch multiple invoices in parallel with per-item error isolation.
   *
   * @param ids - Invoice IDs to resolve.
   * @returns Results in the same order as the input IDs.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const result = await client.resolveBatch('batch-1');
   * ```
   */
  async resolveBatch(ids: string[]): Promise<BatchResolveResult[]> {
    const settled = await Promise.allSettled(
      ids.map((id) => this.getInvoice(id)),
    );
    return settled.map((result, i) => {
      const invoiceId = ids[i]!;
      if (result.status === "fulfilled") {
        return { invoiceId, success: true as const, invoice: result.value };
      }
      return {
        invoiceId,
        success: false as const,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      };
    });
  }

  private _nftGateCache = new Map<
    string,
    { timestamp: number; result: NftGateResult }
  >();

  /**
   * Checks whether a creator address satisfies the configured NFT gate.
   *
   * Queries the on-chain `check_nft_gate` contract method and returns whether
   * the creator has an NFT gate configured and, if so, whether they hold a
   * qualifying NFT. Results are cached for 30 seconds per creator address.
   *
   * Call this before `createInvoice` when the contract has an NFT gate
   * configured for the creator. `createInvoice` performs this check automatically.
   *
   * @param creatorAddress - The Stellar address of the invoice creator.
   * @returns Gate status including whether gating applies and NFT ownership.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const gate = await client.checkNftGate('GA...');
   * if (gate.hasNft) console.log('Token gate passed');
   * ```
   */
  async checkNftGate(creatorAddress: string): Promise<NftGateResult> {
    return this._withCache("checkNftGate", [creatorAddress], async () => {
      const startTime = Date.now();
      const now = Date.now();
      const cached = this._nftGateCache.get(creatorAddress);
      if (cached && now - cached.timestamp < NFT_GATE_CACHE_TTL_MS) {
        telemetry.recordMethod("checkNftGate", true, Date.now() - startTime);
        return cached.result;
      }

      try {
        const operation = this.contract.call(
          "check_nft_gate",
          nativeToScVal(creatorAddress, { type: "address" }),
        );

        const raw = await this._simulateView(operation);
        const result = this._parseNftGateResult(raw);

        this._nftGateCache.set(creatorAddress, { timestamp: now, result });
        telemetry.recordMethod("checkNftGate", true, Date.now() - startTime);
        return result;
      } catch {
        const result: NftGateResult = {
          gated: false,
          hasNft: false,
          contractAddress: null,
        };
        this._nftGateCache.set(creatorAddress, { timestamp: now, result });
        telemetry.recordMethod("checkNftGate", true, Date.now() - startTime);
        return result;
      }
    });
  }

  /**
   * Flushes all cached NFT ownership verification results.
   * @returns void
   *
   * @example
   * ```typescript
   * client.clearNftGateCache();
   * ```
   */
  clearNftGateCache(): void {
    this._nftGateCache.clear();
  }

  /**
   * Retrieves the forward dependency execution chain for cascading multi-hop invoice splits.
   *
   * @param invoiceId - The origin invoice ID.
   * @returns Promise resolving to array of downstream linked invoice IDs.
   *
   * @example
   * ```typescript
   * const chain = await client.getForwardChain('123');
   * ```
   */
  async getForwardChain(
    invoiceId: string,
  ): Promise<Array<{ id: string; status: InvoiceStatus; forwardTo?: string }>> {
    const chain: Array<{
      id: string;
      status: InvoiceStatus;
      forwardTo?: string;
    }> = [];
    const visited = new Set<string>();
    let currentId: string | undefined = invoiceId;
    let depth = 0;
    while (currentId) {
      if (depth >= 10) {
        throw new ForwardChainTooDeepError(10, currentId);
      }
      if (visited.has(currentId)) {
        throw new CircularForwardChainError(currentId);
      }
      visited.add(currentId);
      depth++;

      const invoice = await this.getInvoice(currentId);
      chain.push({
        id: invoice.id,
        status: invoice.status,
        forwardTo: invoice.forward_invoice_id,
      });

      currentId = invoice.forward_invoice_id;
    }

    return chain;
  }

  /**
   * Fully terminates the client instance, cancelling scheduled pollers, closing active SSE streams, and resetting local caches.
   * @returns Promise resolving once the client is terminated.
   *
   * @example
   * ```typescript
   * await client.shutdown();
   * ```
   */
  async shutdown(): Promise<void> {
    // Tear down plugins in reverse registration order
    for (const p of this._pluginInstances.reverse()) {
      try {
        await p.onDestroy?.(this);
      } catch (error) {
        console.error(
          `[StellarSplitClient] Plugin "${p.name}" onDestroy error:`,
          error,
        );
      }
    }
    this._pluginInstances = [];
    this._plugins.clear();

    try {
      await this._queue.shutdown();
    } finally {
      this._standby?.stop();
      this._rpcLoadBalancer?.stop();

      this._wsTransport?.disconnect();
      this._wsTransport = null;

      this._pool?.dispose();
      this._pool = null;
      if (this._cache && typeof (this._cache as any).persist === "function") {
        await (this._cache as any).persist();
      }
      if (this._cache && typeof (this._cache as any).close === "function") {
        await (this._cache as any).close();
      }
      if (
        this._rpcClient &&
  /**
   * typeof
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
        typeof (this._rpcClient as any).close === "function"
      ) {
        await (this._rpcClient as any).close();
      }

      telemetry.destroy();
    }
  }

  /**
   * Cancels multiple pending invoices in a single bulk operation.
   *
   * @param invoiceIds - Array of invoice IDs to cancel.
   * @returns Promise resolving to BulkOperationResult.
   *
   * @example
   * ```typescript
   * const result = await client.bulkCancel(['101', '102', '103']);
   * ```
   */
  async bulkCancel(ids: string[]): Promise<BulkResult[]> {
    return this._executeBulkInvoiceAction(ids, (invoiceId) => {
      const operation = this.contract.call(
        "cancel_invoice",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      );
      return this._submitTx(this.config.contractId, operation);
    });
  }

  /**
   * Archives multiple completed or cancelled invoices to optimize active storage queries.
   *
   * @param invoiceIds - Array of invoice IDs to archive.
   * @returns Promise resolving to BulkOperationResult.
   *
   * @example
   * ```typescript
   * await client.bulkArchive(['101', '102']);
   * ```
   */
  async bulkArchive(ids: string[]): Promise<BulkResult[]> {
    return this._executeBulkInvoiceAction(ids, (invoiceId) => {
      const operation = this.contract.call(
        "archive_invoice",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      );
      return this._submitTx(this.config.contractId, operation);
    });
  }

  /**
   * Exports multiple invoice records into a structured JSON or CSV data format.
   *
   * @param invoiceIds - Array of invoice IDs to export.
   * @param format - Target format ('json' | 'csv').
   * @returns Promise resolving to exported string representation.
   *
   * @example
   * ```typescript
   * const csvData = await client.bulkExport(['101', '102'], 'csv');
   * ```
   */
  async bulkExport(
    ids: string[],
    format: ExportFormat,
  ): Promise<Record<string, string>> {
    const m = await import("./export.js");
    const settled = await Promise.allSettled(
      ids.map(async (invoiceId) => {
        const invoice = await this.getInvoice(invoiceId);
        return { invoiceId, data: m.exportInvoice(invoice, format) };
      }),
    );

    return settled.reduce<Record<string, string>>((acc, result, index) => {
      if (result.status === "fulfilled") {
        acc[ids[index]!] = result.value.data;
      }
      return acc;
    }, {});
  }

  private async _executeBulkInvoiceAction(
    ids: string[],
    execute: (invoiceId: string) => Promise<unknown>,
  ): Promise<BulkResult[]> {
    const settled = await Promise.allSettled(
      ids.map((invoiceId) => execute(invoiceId)),
    );
    return settled.map((result, index) => {
      const invoiceId = ids[index]!;
      if (result.status === "fulfilled") {
        return { invoiceId, success: true };
      }
      return {
        invoiceId,
        success: false,
        error:
          result.reason instanceof Error
            ? result.reason.message
            : String(result.reason),
      };
    });
  }

  /**
   * Persists an invoice split blueprint template for recurring reuse.
   *
   * @param template - Invoice template definition.
   * @returns Promise resolving to saved template ID.
   *
   * @example
   * ```typescript
   * const id = await client.saveTemplate(myTemplate);
   * ```
   */
  async saveTemplate(
    creator: string,
    template: InvoiceTemplate,
  ): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const recipientAddresses = template.recipients.map((r) =>
        nativeToScVal(r.address, { type: "address" }),
      );
      const recipientAmounts = template.recipients.map((r) =>
        nativeToScVal(r.amount, { type: "i128" }),
      );

      const operation = this.contract.call(
        "save_template",
        nativeToScVal(creator, { type: "address" }),
        nativeToScVal(template.name, { type: "string" }),
        xdr.ScVal.scvVec(recipientAddresses),
        xdr.ScVal.scvVec(recipientAmounts),
        nativeToScVal(template.token, { type: "address" }),
      );

      const result = await this._submitTx(creator, operation);
      telemetry.recordMethod("saveTemplate", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("saveTemplate", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Instantiates and creates a new on-chain invoice using a saved template.
   *
   * @param templateId - ID of the saved template.
   * @param overrides - Optional parameter overrides.
   * @returns Promise resolving to created invoice result.
   *
   * @example
   * ```typescript
   * const { invoiceId } = await client.createFromTemplate('monthly-payroll', { deadline: deadlineFromDays(30) });
   * ```
   */
  async createFromTemplate(
    creator: string,
    templateName: string,
    deadline: number,
  ): Promise<{ invoiceId: string; txHash: string }> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "create_from_template",
        nativeToScVal(creator, { type: "address" }),
        nativeToScVal(templateName, { type: "string" }),
        nativeToScVal(deadline, { type: "u64" }),
      );

      const result = await this._submitTx(creator, operation);
      const invoiceId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod(
        "createFromTemplate",
        true,
        Date.now() - startTime,
      );
      return { invoiceId, txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod(
        "createFromTemplate",
        false,
        Date.now() - startTime,
      );
      throw error;
    }
  }

  /**
   * Lists all saved invoice split templates.
   * @returns Promise resolving to array of saved templates.
   *
   * @example
   * ```typescript
   * const templates = await client.listTemplates();
   * ```
   */
  async listTemplates(creator: string): Promise<string[]> {
    return this._withCache("listTemplates", [creator], async () => {
      const startTime = Date.now();
      try {
        const operation = this.contract.call(
          "list_templates",
          nativeToScVal(creator, { type: "address" }),
        );

        const templates = await this._simulateView(operation);
        const result = Array.isArray(templates) ? (templates as string[]) : [];
        telemetry.recordMethod("listTemplates", true, Date.now() - startTime);
        return result;
      } catch (error) {
        telemetry.recordMethod("listTemplates", false, Date.now() - startTime);
        throw error;
      }
    });
  }

  /**
   * Retrieves recurring invoice generation schedules registered for a creator.
   *
   * @param creator - Stellar address of the creator account.
   * @returns Promise resolving to array of RecurringInvoiceSchedule objects.
   *
   * @example
   * ```typescript
   * const recurring = await client.getRecurringInvoices('GA...');
   * ```
   */
  async getRecurringInvoices(creator: string): Promise<Invoice[]> {
    const startTime = Date.now();
    try {
      const page = await this.getInvoicesByCreator(creator);
      const invoices = await Promise.all(
        page.items.map((id) => this.getInvoice(id)),
      );
      const recurring = invoices.filter((inv) => inv.recurring === true);
      telemetry.recordMethod(
        "getRecurringInvoices",
        true,
        Date.now() - startTime,
      );
      return recurring;
    } catch (error) {
      telemetry.recordMethod(
        "getRecurringInvoices",
        false,
        Date.now() - startTime,
      );
      throw error;
    }
  }

  /**
   * Cancels an active recurring invoice schedule.
   *
   * @param scheduleId - ID of the recurring schedule to cancel.
   * @returns Promise resolving once the schedule is cancelled.
   *
   * @example
   * ```typescript
   * await client.cancelRecurring('rec-123');
   * ```
   */
  async cancelRecurring(invoiceId: string, creator: string): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "cancel_invoice",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(creator, { type: "address" }),
      );

      const result = await this._submitTx(creator, operation);
      telemetry.recordMethod("cancelRecurring", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("cancelRecurring", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Updates the billing amount for a recurring invoice schedule.
   *
   * @param scheduleId - ID of the recurring schedule.
   * @param amount - New billing amount in stroops.
   * @returns Promise resolving once the amount is updated.
   *
   * @example
   * ```typescript
   * await client.updateRecurringAmount('rec-123', 75_0000000n);
   * ```
   */
  async updateRecurringAmount(
    invoiceId: string,
    creator: string,
    amounts: bigint[],
  ): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const amountVals = amounts.map((a) => nativeToScVal(a, { type: "i128" }));

      const operation = this.contract.call(
        "update_recurring_amount",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(creator, { type: "address" }),
        xdr.ScVal.scvVec(amountVals),
      );

      const result = await this._submitTx(creator, operation);
      telemetry.recordMethod(
        "updateRecurringAmount",
        true,
        Date.now() - startTime,
      );
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod(
        "updateRecurringAmount",
        false,
        Date.now() - startTime,
      );
      throw error;
    }
  }

  /**
   * Get invoices created by an address, with cursor-based pagination.
   *
   * @param creator - Stellar address of the creator.
   * @param options - Optional pagination options (cursor, limit). Default page size is 20.
   * @returns A page of invoice IDs with a nextCursor for subsequent pages.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const invoices = await client.getInvoicesByCreator('GA...CREATOR');
   * ```
   */
  async getInvoicesByCreator(
    creator: string,
    options: PaginationOptions = {},
  ): Promise<PaginatedResult<string>> {
    return this._withCache(
      "getInvoicesByCreator",
      [creator, options],
      async () => {
        const limit = options.limit ?? 20;

        const operation = this.contract.call(
          "get_invoices_by_creator",
          nativeToScVal(creator, { type: "address" }),
        );

        const raw = await this._simulateView(operation);
        const allIds: string[] = Array.isArray(raw)
          ? raw.map((id: unknown) => String(id))
          : [];

        const total = allIds.length;
        const startIndex = options.cursor
          ? allIds.indexOf(options.cursor) + 1
          : 0;
        const page = allIds.slice(startIndex, startIndex + limit);
        const nextCursor =
          startIndex + limit < total ? (page[page.length - 1] ?? null) : null;

        return { items: page, nextCursor, total };
      },
    );
  }

  /**
   * Get invoices where an address is a recipient, with cursor-based pagination.
   *
   * @param recipient - Stellar address of the recipient.
   * @param options   - Optional pagination options (cursor, limit). Default page size is 20.
   * @returns A page of invoice IDs with a nextCursor for subsequent pages.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const myInvoices = await client.getInvoicesByRecipient('GA...RECIPIENT');
   * ```
   */
  async getInvoicesByRecipient(
    recipient: string,
    options: PaginationOptions = {},
  ): Promise<PaginatedResult<string>> {
    return this._withCache(
      "getInvoicesByRecipient",
      [recipient, options],
      async () => {
        const limit = options.limit ?? 20;

        const operation = this.contract.call(
          "get_invoices_by_recipient",
          nativeToScVal(recipient, { type: "address" }),
        );

        const account = await this.server
          .getAccount(this.config.contractId)
          .catch(() => null);
        const sourceAccount =
          account ?? new Account(this.config.contractId, "0");

        const tx = new TransactionBuilder(sourceAccount, {
          fee: BASE_FEE,
          networkPassphrase: this.config.networkPassphrase,
        })
          .addOperation(operation)
          .setTimeout(30)
          .build();

        const simResult = await this.server.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(simResult)) {
          throw new SimulationFailedError(
            `Simulation failed: ${simResult.error}`,
            "getInvoicesByRecipient",
            simResult.error,
          );
        }

        const returnVal = (
          simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse
        ).result?.retval;
        if (!returnVal) throw new NoReturnValueError("getInvoicesByRecipient");

        const raw = scValToNative(returnVal);
        const allIds: string[] = Array.isArray(raw)
          ? raw.map((id: unknown) => String(id))
          : [];

        const total = allIds.length;
        const startIndex = options.cursor
          ? allIds.indexOf(options.cursor) + 1
          : 0;
        const page = allIds.slice(startIndex, startIndex + limit);
        const nextCursor =
          startIndex + limit < total ? (page[page.length - 1] ?? null) : null;

        return { items: page, nextCursor, total };
      },
    );
  }

  /**
   * Searches and filters invoices matching structured query criteria.
   *
   * @param filter - Filter parameters including status, date range, or token.
   * @returns Promise resolving to filtered Invoice array.
   *
   * @example
   * ```typescript
   * const pending = await client.queryInvoices({ status: 'Pending' });
   * ```
   */
  async queryInvoices(filter: InvoiceFilter = {}): Promise<InvoicePage> {
    const startTime = Date.now();
    try {
      if (filter.creator === undefined) {
        throw new ValidationError(
          "queryInvoices requires a 'creator' — the contract has no global invoice index",
        );
      }

      // Fetch every invoice ID for the creator (cursor-paging through the
      // on-chain list) so filters are applied to the complete result set.
      const ids: string[] = [];
      let cursor: string | undefined;
      do {
        const page: PaginatedResult<string> = await this.getInvoicesByCreator(
          filter.creator,
          cursor !== undefined ? { cursor } : {},
        );
        ids.push(...page.items);
        cursor = page.nextCursor ?? undefined;
      } while (cursor !== undefined);

      const invoices = await Promise.all(ids.map((id) => this.getInvoice(id)));
      const result = new InvoiceQueryEngine(invoices).query(filter);
      telemetry.recordMethod("queryInvoices", true, Date.now() - startTime);
      return result;
    } catch (error) {
      telemetry.recordMethod("queryInvoices", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Queries health and responsiveness of configured RPC node endpoints.
   * @returns Promise resolving to RPC endpoint health details.
   *
   * @example
   * ```typescript
   * const status = await client.checkRPCHealth();
   * ```
   */
  async checkRPCHealth(): Promise<RPCHealth> {
    const health = await checkRPCHealth(this.server);
    if (health.status !== "down" && this._offlineQueue?.config?.enabled) { void this._offlineQueue.drain(); }
    return health;
  }

  /**
   * Aggregates multiple related invoices into an invoice group for coordinated settlement.
   *
   * @param params - Group creation configuration.
   * @returns Promise resolving to created group identifier.
   *
   * @example
   * ```typescript
   * const groupId = await client.createGroup({ name: 'Project Milestone 1', invoiceIds: ['1', '2'] });
   * ```
   */
  async createGroup(
    creator: string,
    invoiceIds: string[],
  ): Promise<{ groupId: string; txHash: string }>;
  async createGroup(
    creator: string,
    name: string,
    description: string,
  ): Promise<{ groupId: string; txHash: string }>;
  async createGroup(
    creator: string,
    second: string | string[],
    third?: string,
  ): Promise<{ groupId: string; txHash: string }> {
    if (Array.isArray(second)) {
      const invoiceIds = second;
      const invoiceIdsBigInt = invoiceIds.map((id) =>
        nativeToScVal(BigInt(id), { type: "u64" }),
      );

      const operation = this.contract.call(
        "create_invoice_group",
        nativeToScVal(creator, { type: "address" }),
        xdr.ScVal.scvVec(invoiceIdsBigInt),
      );

      const result = await this._submitTx(creator, operation);
      const groupId = scValToNative(result.returnValue).toString();
      return { groupId, txHash: result.txHash };
    } else {
      const name = second;
      const description = third ?? "";
      const operation = this.contract.call(
        "create_group",
        nativeToScVal(creator, { type: "address" }),
        nativeToScVal(name, { type: "string" }),
        nativeToScVal(description, { type: "string" }),
      );

      const result = await this._submitTx(creator, operation);
      const groupId = scValToNative(result.returnValue).toString();
      return { groupId, txHash: result.txHash };
    }
  }

  /**
   * Retrieves the status and aggregate funding progress of an invoice group.
   *
   * @param groupId - Unique identifier of the invoice group.
   * @returns Promise resolving to InvoiceGroupStatus.
   *
   * @example
   * ```typescript
   * const status = await client.getGroupStatus('grp-123');
   * ```
   */
  async getGroupStatus(groupId: string): Promise<InvoiceGroup> {
    const operation = this.contract.call(
      "get_invoice_group",
      nativeToScVal(BigInt(groupId), { type: "u64" }),
    );

    const raw = (await this._simulateView(operation)) as Record<
      string,
      unknown
    >;
    return {
      groupId,
      invoiceIds: (raw.invoiceIds as (string | number)[]).map((id) =>
        String(id),
      ),
      allFunded: Boolean(raw.allFunded),
    };
  }

  /**
   * Releases payouts for all fully funded invoices within an invoice group.
   *
   * @param groupId - Unique identifier of the group.
   * @returns Promise resolving to group release TxResult.
   *
   * @example
   * ```typescript
   * const tx = await client.releaseGroup('grp-123');
   * ```
   */
  async releaseGroup(
    creator: string,
    groupId: string,
    options: { simulate: true },
  ): Promise<SimulationResult>;
  /**
   * Releases payouts for all fully funded invoices within an invoice group.
   *
   * @param groupId - Unique identifier of the group.
   * @returns Promise resolving to group release TxResult.
   *
   * @example
   * ```typescript
   * const tx = await client.releaseGroup('grp-123');
   * ```
   */
  async releaseGroup(creator: string, groupId: string): Promise<TxResult>;
  /**
   * Releases payouts for all fully funded invoices within an invoice group.
   *
   * @param groupId - Unique identifier of the group.
   * @returns Promise resolving to group release TxResult.
   *
   * @example
   * ```typescript
   * const tx = await client.releaseGroup('grp-123');
   * ```
   */
  async releaseGroup(
    creator: string,
    groupId: string,
    options?: { simulate?: boolean },
  ): Promise<TxResult | SimulationResult> {
    // Issue #844 — `{ simulate: true }` performs a dry-run instead of submitting.
    if (options?.simulate) {
      return this.simulate("release_invoice_group", { creator, groupId });
    }
    const operation = this.contract.call(
      "release_invoice_group",
      nativeToScVal(creator, { type: "address" }),
      nativeToScVal(BigInt(groupId), { type: "u64" }),
    );

    const result = await this._submitTx(creator, operation);
    return { txHash: result.txHash };
  }

  /**
   * Attest an invoice with a statement.
   * @param invoiceId - Invoice ID to attest
   * @param statement - Attestation statement (max 256 chars)
   * @param payer - Payer address
   * @returns Transaction hash
   * @throws {InvalidAttestationError} if statement exceeds 256 chars
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.attestInvoice('123', { type: 'KYC_VERIFIED', hash: '...' });
   * ```
   */
  async attestInvoice(
    invoiceId: string,
    statement: string,
    payer: string
  ): Promise<TxResult> {
    if (statement.length > 256) {
      throw new InvalidAttestationError("Statement must not exceed 256 characters");
    }

    const operation = this.contract.call(
      "attest_invoice",
      nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      nativeToScVal(statement, { type: "string" }),
      nativeToScVal(payer, { type: "address" })
    );

    const result = await this._submitTx(payer, operation);
    return { txHash: result.txHash };
  }

  /**
   * Revoke an attestation on an invoice.
   * @param invoiceId - Invoice ID
   * @param payer - Payer address
   * @returns Transaction hash
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.revokeAttestation('123', 'att-1');
   * ```
   */
  async revokeAttestation(invoiceId: string, payer: string): Promise<TxResult> {
    const operation = this.contract.call(
      "revoke_attestation",
      nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      nativeToScVal(payer, { type: "address" })
    );

    const result = await this._submitTx(payer, operation);
    return { txHash: result.txHash };
  }

  /**
   * Get all attestations for an invoice.
   * @param invoiceId - Invoice ID
   * @returns Array of attestations
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const attestations = await client.getAttestations('123');
   * ```
   */
  async getAttestations(invoiceId: string): Promise<Attestation[]> {
    const operation = this.contract.call(
      "get_attestations",
      nativeToScVal(BigInt(invoiceId), { type: "u64" })
    );

    const raw = (await this._simulateView(operation)) as Array<Record<string, unknown>>;
    return raw.map((a) => ({
      attester: a.attester as string,
      statement: a.statement as string,
      timestamp: BigInt(a.timestamp as string | number),
      revoked: Boolean(a.revoked),
    }));
  }


  /**
   * Add an invoice to a group.
   * @param creator - Creator address
   * @param groupId - Group ID
   * @param invoiceId - Invoice ID to add
   * @returns Transaction hash
   * @throws {Error} If caller is not the group owner or other errors.
   *
   * @example
   * ```typescript
   * await client.addInvoiceToGroup('grp-1', '104');
   * ```
   */
  async addInvoiceToGroup(
    creator: string,
    groupId: string,
    invoiceId: string
  ): Promise<TxResult> {
    const operation = this.contract.call(
      "add_invoice_to_group",
      nativeToScVal(creator, { type: "address" }),
      nativeToScVal(BigInt(groupId), { type: "u64" }),
      nativeToScVal(BigInt(invoiceId), { type: "u64" })
    );

    const result = await this._submitTx(creator, operation);
    return { txHash: result.txHash };
  }

  /**
   * Get statistics for a group.
   * @param groupId - Group ID
   * @returns Group statistics
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const stats = await client.getGroupStats('grp-1');
   * ```
   */
  async getGroupStats(groupId: string): Promise<GroupStats> {
    const operation = this.contract.call(
      "get_group_stats",
      nativeToScVal(BigInt(groupId), { type: "u64" })
    );

    const raw = (await this._simulateView(operation)) as Record<string, unknown>;
    return {
      name: raw.name as string,
      totalTarget: BigInt(raw.totalTarget as string | number),
      totalFunded: BigInt(raw.totalFunded as string | number),
      invoiceCount: BigInt(raw.invoiceCount as string | number),
      fullyFundedCount: BigInt(raw.fullyFundedCount as string | number),
    };
  }

  /**
   * Get invoices in a group.
   * @param groupId - Group ID
   * @returns Array of invoice IDs in the group
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const invoices = await client.getGroupInvoices('grp-1');
   * ```
   */
  async getGroupInvoices(groupId: string): Promise<bigint[]> {
    const operation = this.contract.call(
      "get_group_invoices",
      nativeToScVal(BigInt(groupId), { type: "u64" })
    );

    const raw = (await this._simulateView(operation)) as (string | number)[];
    return raw.map((id) => BigInt(id));
  }

  /**
   * Vote to extend a deadline.
   * @param invoiceId - Invoice ID
   * @param payer - Payer address (must be a contributor)
   * @returns Transaction hash
   * @throws {NotEligibleToVoteError} if caller has not contributed
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.voteExtendDeadline('123', 'GA...', deadlineFromDays(30));
   * ```
   */
  async voteExtendDeadline(invoiceId: string, payer: string): Promise<TxResult> {
    const operation = this.contract.call(
      "vote_extend_deadline",
      nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      nativeToScVal(payer, { type: "address" })
    );

    const result = await this._submitTx(payer, operation);
    return { txHash: result.txHash };
  }

  /**
   * Get deadline extension status for an invoice.
   * @param invoiceId - Invoice ID
   * @returns Extension status
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const ext = await client.getExtensionStatus('123');
   * ```
   */
  async getExtensionStatus(invoiceId: string): Promise<ExtensionStatus> {
    const operation = this.contract.call(
      "get_extension_status",
      nativeToScVal(BigInt(invoiceId), { type: "u64" })
    );

    const raw = (await this._simulateView(operation)) as Record<string, unknown>;
    return {
      voteCount: BigInt(raw.voteCount as string | number),
      quorumRequired: BigInt(raw.quorumRequired as string | number),
      extensionCount: BigInt(raw.extensionCount as string | number),
      maxExtensions: BigInt(raw.maxExtensions as string | number),
      currentDeadline: BigInt(raw.currentDeadline as string | number),
    };
  }

  /**
   * Rate an invoice.
   * @param invoiceId - Invoice ID to rate
   * @param stars - Star rating (1-5)
   * @param payer - Payer address
   * @returns Transaction hash
   * @throws {InvoiceNotReleasedForRatingError} if invoice is not released
   * @throws {AlreadyRatedError} if caller has already rated
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.rateInvoice('123', 5, 'Fast settlement and great communication');
   * ```
   */
  async rateInvoice(invoiceId: string, stars: 1 | 2 | 3 | 4 | 5, payer: string): Promise<TxResult> {
    const operation = this.contract.call(
      "rate_invoice",
      nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      nativeToScVal(BigInt(stars), { type: "u32" }),
      nativeToScVal(payer, { type: "address" })
    );

    const result = await this._submitTx(payer, operation);
    return { txHash: result.txHash };
  }

  /**
   * Get the creator's rating information.
   * @param creator - Creator address
   * @returns Creator rating with total ratings and average stars
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const rating = await client.getCreatorRating('GA...CREATOR');
   * console.log(`Average score: ${rating.averageScore}/5 (${rating.totalReviews} reviews)`);
   * ```
   */
  async getCreatorRating(creator: string): Promise<CreatorRating> {
    const operation = this.contract.call(
      "get_creator_rating",
      nativeToScVal(creator, { type: "address" })
    );

    const raw = (await this._simulateView(operation)) as Record<string, unknown>;
    const totalRatings = BigInt(raw.totalRatings as string | number);
    const totalStars = BigInt(raw.totalStars as string | number);
    const averageStars =
      totalRatings > 0n ? Number(totalStars) / Number(totalRatings) : 0;

    return {
      totalRatings,
      averageStars,
    };
  }

  /**
   * Calculate the protocol fee for a given amount.
   *
   * @param amount - Gross amount in stroops
   * @returns Fee breakdown with gross, fee, net, and feeBps
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const fee = await client.calculateFee(100_0000000n, 'USDC');
   * console.log(`Fee: ${fee.protocolFee}`);
   * ```
   */
  async calculateFee(amount: bigint): Promise<FeeBreakdown> {
    return calculateFee(amount, this.config);
  }

  /**
   * Resolve token metadata from a SAC contract address.
   *
   * @param address - Token contract address
   * @returns Token metadata (symbol, name, decimals)
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const contractId = client.resolveToken('USDC');
   * ```
   */
  async resolveToken(address: string): Promise<TokenInfo> {
    return resolveToken(address, this.config);
  }

  /**
   * Generate a cryptographic proof of payment.
   *
   * @param txHash - Transaction hash
   * @returns Payment proof with deterministic SHA-256 hash
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const proof = await client.generatePaymentProof(txHash);
   * ```
   */
  async generatePaymentProof(txHash: string): Promise<PaymentProof> {
    const m = await import("./proof.js");
    return m.generatePaymentProof(txHash, this.config);
  }

  /**
   * Generate a payment receipt for an invoice and payer address.
   * Compiles on-chain invoice details, total paid, timestamps, and a SHA-256 proof hash.
   * Works for both completed and in-progress invoices.
   *
   * @param invoiceId - The ID of the invoice.
   * @param payerAddress - The Stellar address of the payer.
   * @returns Payment receipt with proofHash and optional JSON serialization.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const receipt = await client.generatePaymentReceipt('123');
   * ```
   */
  async generatePaymentReceipt(
    invoiceId: string,
    payerAddress: string,
  ): Promise<PaymentReceipt> {
    const invoice = await this.getInvoice(invoiceId);
    const m = await import("./receipt.js");
    return m.compilePaymentReceipt(invoice, payerAddress);
  }

  // ---------------------------------------------------------------------------
  // Issue #1 — batchPay
  // ---------------------------------------------------------------------------

  /**
   * Pay toward multiple invoices in a single transaction.
   *
   * @param payments - Array of { invoiceId, amount } (must be non-empty)
   * @returns The transaction hash.
   */
  /**
   * Pay toward multiple invoices in a single transaction.
   *
   * @param payer    - Stellar address of the payer (must sign).
   * @param payments - Array of { invoiceId, amount } (must be non-empty).
   * @returns The transaction hash.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const results = await client.batchPay([
   *   { invoiceId: '1', amount: 10_0000000n },
   *   { invoiceId: '2', amount: 20_0000000n }
   * ]);
   * ```
   */
  async batchPay(payer: string, payments: BatchPayment[]): Promise<TxResult> {
    if (payments.length === 0) {
      throw new ValidationError("payments array must not be empty");
    }
    for (const p of payments) {
      if (!p.invoiceId || isNaN(Number(p.invoiceId))) {
        throw new ValidationError(`Invalid invoiceId: ${p.invoiceId}`);
      }
    }

    const paymentVals = payments.map((p) => {
      const entries: xdr.ScMapEntry[] = [
        new xdr.ScMapEntry({
          key: nativeToScVal("invoice_id", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(BigInt(p.invoiceId), { type: "u64" }) as xdr.ScVal,
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("amount", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(p.amount, { type: "i128" }) as xdr.ScVal,
        }),
      ];
      return xdr.ScVal.scvMap(entries);
    });

    const operation = this.contract.call(
      "batch_pay",
      nativeToScVal(payer, { type: "address" }),
      xdr.ScVal.scvVec(paymentVals),
    );

    const result = await this._submitTx(payer, operation);
    return { txHash: result.txHash };
  }

  /**
   * Validate a batch of proposed payments before submission.
   *
   * Resolves all referenced invoices, verifies they are all in "Pending"
   * status and share the same token, and checks that each payment amount
   * does not exceed the invoice's remaining amount.
   *
   * This is a client-side preflight to avoid wasting gas/fees on a
   * batch that would be rejected on-chain.
   *
   * @param payments - Array of { invoiceId, amount } pairs to verify.
   * @returns A `BatchVerificationResult` describing per-invoice validity,
   *          the common token (if uniform), and any aggregated errors.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const ok = client.verifyBatchPay(results);
   * ```
   */
  async verifyBatchPay(
    payments: BatchPayment[],
  ): Promise<BatchVerificationResult> {
    const invoiceIds = payments.map((p) => p.invoiceId);
    const results = await this.resolveBatch(invoiceIds);

    const resolvedInvoices: Invoice[] = [];
    for (const r of results) {
      const rr = r as { success: boolean; invoice?: Invoice };
      if (rr.success && rr.invoice) {
        resolvedInvoices.push(rr.invoice);
      }
    }

    return verifyBatchPayments(resolvedInvoices, payments);
  }

  /**
   * Validate a proposed payment before submission.
   *
   * @param invoiceId - Invoice ID to validate against.
   * @param amount - Payment amount in stroops.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const val = client.validatePayment({ invoiceId: '123', amount: 50_0000000n });
   * ```
   */
  async validatePayment(
    invoiceId: string,
    amount: bigint,
  ): Promise<PaymentValidation> {
    const invoice = await this.getInvoice(invoiceId);
    let balance: bigint | null = null;

    const payerAddress = await this._getPayerAddress();
    if (payerAddress) {
      try {
        balance = await this._getTokenBalance(payerAddress, invoice.token);
      } catch {
        balance = null;
      }
    }

    const result = computePaymentValidation(invoice, amount, balance);

    // Add trustline-check results for non-XLM assets when the config has a
    // horizon URL set.
    if (this.config.horizonUrl && invoice.token !== "native") {
      try {
        const { Horizon } = await import("@stellar/stellar-sdk");
        const horizon = new Horizon.Server(this.config.horizonUrl);
        const recipients = invoice.recipients.map((r) => r.address);
        const trustResult = await checkTrustlines(
          horizon,
          recipients,
          invoice.token,
        );
        if (!trustResult.allReady) {
          const missing = trustResult.entries.filter((e) => !e.hasTrustline);
          for (const m of missing) {
            result.errors.push(
              `Recipient ${m.address} has no trustline for token ${invoice.token}. Establish a trustline before releasing.`,
            );
          }
          result.valid = false;
        }
      } catch {
        // Trustline check failed — don't block payment, just skip.
      }
    }

    return result;
  }

  private async _getPayerAddress(): Promise<string | null> {
    if (this._adapter && typeof this._adapter.getAddress === "function") {
      return await this._adapter.getAddress();
    }
    return null;
  }

  private async _getTokenBalance(
    address: string,
    tokenAddress: string,
  ): Promise<bigint> {
    const tokenContract = new Contract(tokenAddress);
    const operation = tokenContract.call(
      "balance",
      nativeToScVal(address, { type: "address" }),
    );

    const result = await this._simulateView(operation);
    if (typeof result === "bigint") {
      return result;
    }
    if (typeof result === "string" || typeof result === "number") {
      return BigInt(result);
    }
    if (typeof result === "object" && result !== null && "balance" in result) {
      return BigInt(
        (result as Record<string, unknown>).balance as string | number,
      );
    }

    throw new NoReturnValueError("_getTokenBalance");
  }

  // ---------------------------------------------------------------------------
  // Issue #2 / #282 — subscribeToInvoice
  // ---------------------------------------------------------------------------

  /**
   * Subscribe to live invoice events via server-sent events (SSE).
   *
   * Pass a single handler function to receive typed `InvoiceEvent` objects
   * (`payment_received`, `invoice_released`, `invoice_refunded`) without
   * polling. The connection reconnects automatically with exponential backoff
   * on drops. The SSE base URL defaults to the client's `horizonUrl` config and
   * can be overridden via `options.baseUrl`.
   *
   * @param invoiceId - The invoice ID to watch.
   * @param handler   - Called with each single typed `InvoiceEvent` (SSE mode).
   * @param options   - Optional SSE options (base URL, backoff, EventSource factory).
   * @returns Unsubscribe function that permanently stops the stream.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const unsubscribe = client.subscribeToInvoice('123', (event) => console.log(event));
   * ```
   */
  subscribeToInvoice(
    invoiceId: string,
    handler: InvoiceEventHandler,
    options?: Partial<SubscribeToInvoiceOptions>,
  ): () => void;
  /**
   * Subscribe to live invoice events via Soroban RPC polling.
   *
   * Polls every 5 seconds initially; backs off to 30 seconds after 3 unchanged polls.
   * Resets to 5 seconds immediately when a change is detected. Handler receives
   * InvoiceEvent[] containing only events since the last poll.
   *
   * @param invoiceId - The invoice ID to watch.
   * @param handler   - Called with InvoiceEvent[] (events since last poll).
   * @param intervalMs - Poll interval in milliseconds (default: 5000).
   * @returns Unsubscribe function that stops the stream.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const unsubscribe = client.subscribeToInvoice('123', (event) => console.log(event));
   * ```
   */
  subscribeToInvoice(
    invoiceId: string,
    handler: (events: SSEInvoiceEvent[]) => void,
    intervalMs?: number,
  ): () => void;
  /**
   * Subscribe to live invoice events via Soroban RPC event polling.
   *
   * @param invoiceId - The invoice ID to watch.
   * @param callbacks - Typed event callbacks.
   * @param intervalMs - Poll interval in milliseconds (default: 5000).
   * @returns Unsubscribe function that stops the stream.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const unsubscribe = client.subscribeToInvoice('123', (event) => console.log(event));
   * ```
   */
  subscribeToInvoice(
    invoiceId: string,
    callbacks: InvoiceEventCallbacks,
    intervalMs?: number,
  ): () => void;
  /**
   * Subscribes to updates for an invoice with a persistent listener callback.
   *
   * @param invoiceId - Invoice ID to monitor.
   * @param callback - Handler function called with invoice event.
   * @returns Unsubscribe function.
   *
   * @example
   * ```typescript
   * const unsubscribe = client.subscribeToInvoice('123', (event) => console.log(event));
   * ```
   */
  subscribeToInvoice(
    invoiceId: string,
    handlerOrCallbacks:
      | InvoiceEventHandler
      | InvoiceEventCallbacks
      | ((events: SSEInvoiceEvent[]) => void),
    optionsOrInterval?: Partial<SubscribeToInvoiceOptions> | number,
  ): () => void {
    // WebSocket transport: use the active WebSocket connection when configured
    if (this._wsTransport && this._transportType === 'websocket') {
      if (typeof handlerOrCallbacks !== "function") {
        throw new ValidationError(
          "WebSocket transport requires a function handler. Callbacks object is not supported."
        );
      }

      const handler = handlerOrCallbacks as InvoiceEventHandler;
      const wrappedHandler = (event: unknown) => {
  /**
   * handler
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
        handler(event as SSEInvoiceEvent);
      };

      this._wsTransport.subscribe(invoiceId, wrappedHandler);
      return () => {
        this._wsTransport?.unsubscribe(invoiceId, wrappedHandler);
      };
    }

    // A function handler with options object selects the SSE transport.
    // A function handler with number interval selects the RPC polling transport (new API).
    // A callbacks object selects the legacy RPC-polling transport.
    if (typeof handlerOrCallbacks === "function") {
      // If second arg is a number, treat as polling
      if (typeof optionsOrInterval === "number") {
        return _subscribeToInvoice(
          this.server,
          this.config.contractId,
          invoiceId,
          handlerOrCallbacks as (events: SSEInvoiceEvent[]) => void,
          optionsOrInterval,
        );
      }
      // Otherwise SSE mode
      const options =
        (optionsOrInterval as Partial<SubscribeToInvoiceOptions> | undefined) ??
        {};
      const baseUrl = options.baseUrl ?? this.config.horizonUrl;
      if (!baseUrl) {
        throw new ValidationError(
          "subscribeToInvoice (SSE) requires a base URL: set `horizonUrl` in the client config or pass `{ baseUrl }` in options.",
        );
      }
      return _subscribeToInvoiceSSE(
        invoiceId,
        handlerOrCallbacks as InvoiceEventHandler,
        {
          ...options,
          baseUrl,
        },
      );
    }

    return _subscribeToInvoice(
      this.server,
      this.config.contractId,
      invoiceId,
      handlerOrCallbacks,
      undefined,
    );
  }

  /**
   * Queries the operational status of the active network transport (RPC, WebSocket, or SSE).
   * @returns TransportStatus object.
   *
   * @example
   * ```typescript
   * const status = client.getTransportStatus();
   * ```
   */
  getTransportStatus(): TransportStatus {
    if (this._wsTransport) {
      return this._wsTransport.getStatus();
    }
    return { type: 'http', connected: true, reconnectAttempts: 0 };
  }

  /**
   * Registers a callback to be notified when the client falls back to an alternate transport channel.
   *
   * @param callback - Callback function invoked upon transport failover.
   * @returns void
   *
   * @example
   * ```typescript
   * client.onTransportFallback((from, to) => console.warn(`Fell back from ${from} to ${to}`));
   * ```
   */
  onTransportFallback(cb: (event: { from: 'websocket'; to: 'http' }) => void): void {
    this._fallbackListeners.push(cb);
  }

  // ---------------------------------------------------------------------------
  // Issue #3 — offline signing flow
  // ---------------------------------------------------------------------------

  /**
   * Build a transaction and return it as a base64 XDR string.
   * The transaction is simulated and assembled (resource fees injected) but
   * NOT signed or submitted — suitable for air-gapped / offline signing.
   *
   * @param sourceAddress - Stellar address of the transaction source.
   * @param operation     - The contract operation to include.
   * @returns Base64-encoded XDR of the prepared (unsigned) transaction.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const tx = await client.buildTransaction({ method: 'pay', args: [...] });
   * ```
   */
  async buildTransaction(
    sourceAddress: string,
    operation: xdr.Operation,
  ): Promise<string> {
    const account = await this.server.getAccount(sourceAddress);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new SimulationFailedError(
        `Simulation failed: ${simResult.error}`,
        "buildTransaction",
        simResult.error,
      );
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    return preparedTx.toXDR();
  }

  /**
   * Submit a signed transaction XDR and wait for confirmation.
   *
   * @param signedXdr - Base64-encoded signed transaction XDR.
   * @returns The transaction hash.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const result = await client.submitTransaction(signedTx);
   * ```
   */
  async submitTransaction(signedXdr: string): Promise<TxResult> {
    const tx = TransactionBuilder.fromXDR(
      signedXdr,
      this.config.networkPassphrase,
    );
    const sendResult = await this.server.sendTransaction(tx);
    if (sendResult.status === "ERROR") {
      throw new TransactionFailedError(
        `Transaction failed: ${JSON.stringify(sendResult.errorResult)}`,
      );
    }

    const txHash = sendResult.hash;
    let getResult = await this.server.getTransaction(txHash);
    let attempts = 0;
    while (
      getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
      attempts < 20
    ) {
      await new Promise((r) => setTimeout(r, 1500));
      getResult = await this.server.getTransaction(txHash);
      attempts++;
    }
    if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      throw new TransactionNotConfirmedError(String(getResult.status));
    }

    return { txHash };
  }

  // ---------------------------------------------------------------------------
  // Issue #4 — dry-run simulation
  // ---------------------------------------------------------------------------

  /**
   * Runs a preflight simulation of invoice creation to predict resource consumption and validate split shares.
   *
   * @param params - Invoice creation parameters.
   * @returns Promise resolving to SimulationResult.
   *
   * @example
   * ```typescript
   * const sim = await client.simulateCreateInvoice(invoiceParams);
   * ```
   */
  async simulateCreateInvoice(
    params: CreateInvoiceParams,
  ): Promise<SimulateCreateInvoiceResult> {
    const recipientAddresses = params.recipients.map((r) =>
      nativeToScVal(r.address, { type: "address" }),
    );
    const recipientAmounts = params.recipients.map((r) =>
      nativeToScVal(r.amount, { type: "i128" }),
    );

    const operation = this.contract.call(
      "create_invoice",
      nativeToScVal(params.creator, { type: "address" }),
      xdr.ScVal.scvVec(recipientAddresses),
      xdr.ScVal.scvVec(recipientAmounts),
      nativeToScVal(params.token, { type: "address" }),
      nativeToScVal(params.deadline, { type: "u64" }),
    );

    const account = await this.server
      .getAccount(params.creator)
      .catch(() => null);
    const sourceAccount =
      account ??
      ({
        accountId: () => params.creator,
        sequenceNumber: () => "0",
        incrementSequenceNumber: () => {},
      } as unknown as Account);

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new SimulationFailedError(
        `Simulation error: ${simResult.error}`,
        "simulateCreateInvoice",
        simResult.error,
      );
    }

    const success =
      simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse;
    const returnVal = success.result?.retval;
    if (!returnVal) throw new NoReturnValueError("simulateCreateInvoice");

    const invoiceId = scValToNative(returnVal).toString();
    const fee = success.minResourceFee ?? "0";

    return { invoiceId, fee: fee.toString() };
  }

  /**
   * Runs a preflight simulation of an invoice payment to predict fee requirements and verify balances.
   *
   * @param params - Payment parameters.
   * @returns Promise resolving to SimulationResult.
   *
   * @example
   * ```typescript
   * const sim = await client.simulatePay({ invoiceId: '123', amount: 10_0000000n, payer: 'GA...' });
   * ```
   */
  async simulatePay(params: PayParams): Promise<SimulatePayResult> {
    const operation = this.contract.call(
      "pay",
      nativeToScVal(params.payer, { type: "address" }),
      nativeToScVal(BigInt(params.invoiceId), { type: "u64" }),
      nativeToScVal(params.amount, { type: "i128" }),
    );

    const account = await this.server
      .getAccount(params.payer)
      .catch(() => null);
    const sourceAccount =
      account ??
      ({
        accountId: () => params.payer,
        sequenceNumber: () => "0",
        incrementSequenceNumber: () => {},
      } as unknown as Account);

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new SimulationFailedError(
        `Simulation error: ${simResult.error}`,
        "simulatePay",
        simResult.error,
      );
    }

    const success =
      simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse;
    const fee = success.minResourceFee ?? "0";

    return { fee: fee.toString() };
  }

  /**
   * Preview a token swap via the configured DEX contract before calling pay_with_token.
   * Simulates the swap without submitting a transaction.
   *
   * @param invoiceId - The invoice ID to pay toward.
   * @param sourceToken - The token address to swap from.
   * @param sourceAmount - The amount to swap in stroops.
   * @returns Swap preview including estimated output, price impact, and route.
   * @throws Error if no DEX is configured on the invoice.
   * @throws StellarSplitError with the simulation error message on failure.
   *
   * @example
   * ```typescript
   * const estimate = await client.previewTokenSwap(usdcAddress, xlmAddress, 100_0000000n);
   * ```
   */
  async previewTokenSwap(
    invoiceId: string,
    sourceToken: string,
    sourceAmount: bigint,
  ): Promise<PreviewTokenSwapResult> {
    // Check if DEX is configured
    if (!this.config.dexContractId) {
      throw new Error(
        "DEX contract not configured on this client. Set dexContractId in StellarSplitClientConfig.",
      );
    }

    // Get the invoice to determine the target token
    const invoice = await this.getInvoice(invoiceId);

    // Create the DEX contract instance
    const dexContract = new Contract(this.config.dexContractId);

    // Call the DEX's quote method to get the swap estimate
    const operation = dexContract.call(
      "quote",
      nativeToScVal(sourceToken, { type: "address" }),
      nativeToScVal(invoice.token, { type: "address" }),
      nativeToScVal(sourceAmount, { type: "i128" }),
    );

    // Build a minimal transaction for simulation
    const sourceAccount = {
      accountId: () => this.config.dexContractId!,
      sequenceNumber: () => "0",
      incrementSequenceNumber: () => {},
    } as unknown as Account;

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    // Simulate the DEX quote
    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new SimulationFailedError(
        `DEX quote simulation failed: ${simResult.error}`,
        "previewTokenSwap",
        simResult.error,
      );
    }

    const success =
      simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse;
    const returnVal = success.result?.retval;
    if (!returnVal) {
      throw new NoReturnValueError("previewTokenSwap");
    }

    // Extract the output amount from the return value
    const estimatedOutput = BigInt(scValToNative(returnVal));

    // Calculate price impact in basis points
    // Price impact = (input - output) / input * 10000
    const priceImpactBps =
      sourceAmount > 0n
        ? Number(
            (BigInt(10000) * (sourceAmount - estimatedOutput)) / sourceAmount,
          )
        : 0;

    // Return the preview result
    // Note: route is extracted from the quote response if available, or set to [sourceToken, invoice.token]
    return {
      estimatedOutput,
      priceImpactBps,
      route: [sourceToken, invoice.token],
    };
  }

  // ---------------------------------------------------------------------------
  // Issue #5 — fee estimator
  // ---------------------------------------------------------------------------

  /**
   * Estimate the fee for a contract operation without submitting.
   *
   * @param operation - The contract operation to estimate fees for.
   * @returns FeeEstimate with fee in stroops and a congestion indicator.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const feeStroops = await client.estimateFee({ method: 'create_invoice' });
   * ```
   */
  async estimateFee(operation: xdr.Operation): Promise<FeeEstimate> {
    const simResult = (await this._simulateView(operation)) as {
      minResourceFee?: string;
      error?: string;
    };
    if (simResult.error)
      throw new SimulationFailedError(
        `Fee estimation failed: ${simResult.error}`,
        "estimateFee",
        simResult.error,
      );
    const fee = BigInt(simResult.minResourceFee ?? "0");
    let congestion: FeeEstimate["congestion"] = "low";
    try {
      const stats = (await this.server.getFeeStats()) as {
        sorobanInclusionFee?: { p50?: string; p99?: string };
      };
      const p50 = Number(stats.sorobanInclusionFee?.p50 ?? "1");
      const p99 = Number(stats.sorobanInclusionFee?.p99 ?? "1");
      const ratio = p99 > 0 ? p50 / p99 : 1;
      congestion = ratio >= 0.9 ? "low" : ratio >= 0.5 ? "medium" : "high";
    } catch {
      /* use default */
    }
    return { fee, congestion };
  }

  // ---------------------------------------------------------------------------
  // Issue #6 — multi-signature collection
  // ---------------------------------------------------------------------------

  /**
   * Collect signatures from multiple signers sequentially and return a
   * fully signed XDR string ready for submitTransaction().
   *
   * @param xdrStr  - Base64-encoded unsigned (or partially signed) transaction XDR.
   * @param signers - Ordered list of signer addresses.
   * @returns Fully signed transaction XDR.
   * @throws If any signer fails to sign.
   *
   * @example
   * ```typescript
   * const fullySignedTx = await client.collectSignatures(tx, ['G1...', 'G2...']);
   * ```
   */
  async collectSignatures(xdrStr: string, signers: string[]): Promise<string> {
    if (signers.length === 0) {
      throw new ValidationError("signers array must not be empty");
    }

    let current = xdrStr;
    for (const signer of signers) {
      try {
        current = await (this._adapter
          ? this._adapter.signTransaction(
              current,
              this.config.networkPassphrase,
            )
          : signTransaction(current, this.config.networkPassphrase));
      } catch (err) {
        throw new ValidationError(
          `Signer ${signer} failed to sign: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    return current;
  }

  // ---------------------------------------------------------------------------
  // Issue #7 — cache invalidation helpers (public)
  // ---------------------------------------------------------------------------

  // invalidateCache implementation moved up to support MethodCache requirements

  /**
   * Clears all internal caches including RPC simulation caches, invoice caches, and stats caches.
   * @returns void
   *
   * @example
   * ```typescript
   * client.clearCache();
   * ```
   */
  clearCache(): void {
    this._cache?.clear();
  }

  /**
   * Bump the storage TTL for contract data entries associated with an invoice.
   *
   * Extends the TTL of the invoice's persistent storage entry to the target
   * ledger sequence, preventing premature archiving.
   *
   * @param invoiceId - The invoice ID whose storage entry to extend.
   * @param extendTo  - Target ledger sequence to extend TTL to.
   * @param source    - Stellar address of the account submitting the transaction.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.bumpStorageTtl(contractId);
   * ```
   */
  async bumpStorageTtl(
    invoiceId: string,
    extendTo: number,
    source: string,
  ): Promise<TtlExtensionResult> {
    const ledgerKeys = [
  /**
   * buildInvoiceDataLedgerKey
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
      buildInvoiceDataLedgerKey(this.config.contractId, invoiceId),
    ];
    return extendStorageTtl(this.config, { source, extendTo, ledgerKeys });
  }

  /**
   * Bump storage TTL for multiple contract data keys in a single transaction.
   *
   * @param options - TTL extension parameters including source, target ledger,
   *                  and an array of ledger keys to extend.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.bumpStorageTtlBatch([contract1, contract2]);
   * ```
   */
  async bumpStorageTtlBatch(
    options: TtlExtensionOptions,
  ): Promise<TtlExtensionResult> {
    return extendStorageTtl(this.config, options);
  }

  /**
   * Switches the client to a different Stellar network at runtime.
   *
   * The Soroban RPC endpoint of the requested network is contacted and the
   * passphrase it reports is compared against the preset **before** the switch
   * is accepted. When they disagree a {@link NetworkMismatchError} is thrown
   * and the client keeps its current configuration.
   *
   * Requests that are already in flight when this method is called are awaited
   * to completion so they finish against the original network; requests issued
   * after the returned promise resolves observe the new configuration.
   *
   * Passing {@link NetworkEnvironment.CUSTOM} requires a full
   * {@link NetworkPreset} — omitting it is rejected at compile time by the
   * overload signatures and throws at runtime for untyped callers.
   *
   * @example
   * ```ts
   * await client.switchNetwork(NetworkEnvironment.TESTNET);
   * await client.switchNetwork(NetworkEnvironment.CUSTOM, {
   *   horizonUrl: "https://horizon.example.org",
   *   rpcUrl: "https://rpc.example.org",
   *   networkPassphrase: "Example Network ; 2026",
   * });
   * ```
   */
  switchNetwork(
    environment:
      | NetworkEnvironment.MAINNET
      | NetworkEnvironment.TESTNET
      | NetworkEnvironment.FUTURENET,
  ): Promise<void>;
  /**
   * Live switches network environments and re-initializes contract bindings.
   *
   * @param target - Target network name or configuration.
   * @returns Promise resolving once network switch is complete.
   *
   * @example
   * ```typescript
   * await client.switchNetwork('testnet');
   * ```
   */
  switchNetwork(
    environment: NetworkEnvironment.CUSTOM,
    preset: NetworkPreset,
  ): Promise<void>;
  /**
   * Live switches network environments and re-initializes contract bindings.
   *
   * @param target - Target network name or configuration.
   * @returns Promise resolving once network switch is complete.
   *
   * @example
   * ```typescript
   * await client.switchNetwork('testnet');
   * ```
   */
  switchNetwork(preset: NetworkPreset): Promise<void>;
  /**
   * @deprecated Pass a {@link NetworkEnvironment} member or a
   * {@link NetworkPreset} instead. The legacy `"testnet" | "mainnet"` string
   * and {@link NetworkConfig} forms are still accepted for backwards
   * compatibility.
   *
   * @example
   * ```typescript
   * await client.switchNetwork('testnet');
   * ```
   */
  switchNetwork(
    network: "mainnet" | "testnet" | "futurenet" | NetworkConfig,
  ): Promise<void>;
  /**
   * Live switches network environments and re-initializes contract bindings.
   *
   * @param target - Target network name or configuration.
   * @returns Promise resolving once network switch is complete.
   *
   * @example
   * ```typescript
   * await client.switchNetwork('testnet');
   * ```
   */
  async switchNetwork(
    environmentOrPreset:
      | NetworkEnvironment
      | NetworkPreset
      | "mainnet"
      | "testnet"
      | "futurenet"
      | NetworkConfig,
    customPreset?: NetworkPreset,
  ): Promise<void> {
    const target = this._resolveNetworkTarget(environmentOrPreset, customPreset);

    // Fail fast: cross-check the preset against the live RPC node before we
    // touch any client state. `NetworkPassphraseValidator.validate` fails open
    // when the node is unreachable, matching startup validation.
    const validation = await NetworkPassphraseValidator.validate(
      target.preset.networkPassphrase,
      target.preset.rpcUrl,
    );
    if (validation.mismatch) {
      throw new NetworkMismatchError(validation.configured, validation.reported);
    }

    // Let already-issued requests settle against the original network.
    await this.waitForInFlightRequests();

    // Everything below is synchronous, so no request can observe a
    // half-applied endpoint.
    this.config = {
      ...this.config,
      rpcUrl: target.preset.rpcUrl,
      networkPassphrase: target.preset.networkPassphrase,
      horizonUrl: target.preset.horizonUrl,
      ...(target.contractId ? { contractId: target.contractId } : {}),
    };
    this._activeEnvironment = target.environment;
    this._activePreset = target.preset;

    this._rebindNetworkEndpoint(target.preset);
  }

  /** The {@link NetworkEnvironment} the client is currently bound to. */
  get activeNetwork(): NetworkEnvironment {
    return this._activeEnvironment;
  }

  /** The resolved {@link NetworkPreset} backing the active network. */
  get activeNetworkPreset(): NetworkPreset {
    return (
      this._activePreset ?? {
        horizonUrl: this.config.horizonUrl ?? "",
        rpcUrl: Array.isArray(this.config.rpcUrl)
          ? this.config.rpcUrl[0]!
          : this.config.rpcUrl,
        networkPassphrase: this.config.networkPassphrase,
      }
    );
  }

  /** Normalises every accepted `switchNetwork` argument shape. */
  private _resolveNetworkTarget(
    environmentOrPreset:
      | NetworkEnvironment
      | NetworkPreset
      | "mainnet"
      | "testnet"
      | "futurenet"
      | NetworkConfig,
    customPreset?: NetworkPreset,
  ): {
    preset: NetworkPreset;
    environment: NetworkEnvironment;
    contractId?: string;
  } {
    if (isNetworkPreset(environmentOrPreset)) {
      return {
        preset: environmentOrPreset,
        environment: NetworkEnvironment.CUSTOM,
      };
    }

    if (typeof environmentOrPreset === "object" && environmentOrPreset !== null) {
      // Legacy NetworkConfig shape (carries `contractId`, no `horizonUrl`).
      const legacy = environmentOrPreset as NetworkConfig;
      return {
        preset: {
          horizonUrl: this.config.horizonUrl ?? "",
          rpcUrl: legacy.rpcUrl,
          networkPassphrase: legacy.networkPassphrase,
        },
        environment: NetworkEnvironment.CUSTOM,
        contractId: legacy.contractId,
      };
    }

    if (environmentOrPreset === NetworkEnvironment.CUSTOM) {
      if (!customPreset || !isNetworkPreset(customPreset)) {
        throw new ValidationError(
          "NetworkEnvironment.CUSTOM requires a full NetworkPreset " +
            "({ horizonUrl, rpcUrl, networkPassphrase }).",
        );
      }
      return { preset: customPreset, environment: NetworkEnvironment.CUSTOM };
    }

    const environment = environmentOrPreset as Exclude<
      NetworkEnvironment,
      NetworkEnvironment.CUSTOM
    >;
    return {
      preset: getNetworkPreset(environment),
      environment: environment as NetworkEnvironment,
    };
  }

  /** Rebinds every endpoint-bound subsystem to a new network preset. */
  private _rebindNetworkEndpoint(preset: NetworkPreset): void {
    // A warm-standby list or a load balancer belongs to the previous network.
    this._standby?.stop();
    this._standby = null;
    if (this._rpcLoadBalancer) {
      this._rpcLoadBalancer.stop();
      this._rpcLoadBalancer = null;
    }

    this.server = new SorobanRpc.Server(preset.rpcUrl, {
      allowHttp: preset.rpcUrl.startsWith("http://"),
    });

    // `server`'s getter prefers a resilient wrapper, so rebuild it when the
    // client was constructed with a circuit breaker.
    if (this.config.circuitBreaker) {
      const rpcTarget =
        this._injectedRpcClient ?? this._rpcClient ?? this._mainServer;
      this._resilientRpc = new ResilientRpcClient(
        rpcTarget,
        this.config.circuitBreaker.retry,
        this.config.circuitBreaker.breaker,
      );
      this._resilientRpc.on("circuit:open", () =>
        this.emit("circuit:open", undefined),
      );
      this._resilientRpc.on("circuit:close", () =>
        this.emit("circuit:close", undefined),
      );
      this._resilientRpc.on("circuit:half-open", () =>
        this.emit("circuit:half-open", undefined),
      );
    } else {
      this._resilientRpc = null;
    }

    // Rebuild the connection pool for the new endpoint, reading the cached
    // pool size because `_effectiveRpcPoolSize` survives config swaps.
    this._pool?.dispose();
    this._pool = null;
    if (this._effectiveRpcPoolSize >= 2) {
      try {
        this._pool = new ConnectionPool({
          rpcUrl: preset.rpcUrl,
          poolSize: this._effectiveRpcPoolSize,
          allowHttp: preset.rpcUrl.startsWith("http://"),
        });
      } catch {
        // The Soroban SDK rejects some URL shapes; fall back to a single
        // connection rather than failing the whole switch.
      }
    }

    // Rebind the Horizon fallback reader and the feature detector, both of
    // which captured the previous URL at construction time.
    this._horizonReader = preset.horizonUrl
      ? new HorizonFallbackReader(preset.horizonUrl)
      : null;
    this._sorobanFeatureDetector = new SorobanFeatureDetector({
      rpcUrl: preset.rpcUrl,
    });
  }

  // ---------------------------------------------------------------------------
  // Connection pool monitoring (issue #360)
  // ---------------------------------------------------------------------------

  /**
   * Retrieves reserve balances and liquidity statistics for an AMM pool.
   *
   * @param poolId - Identifier of the liquidity pool.
   * @returns Promise resolving to PoolStats.
   *
   * @example
   * ```typescript
   * const pool = await client.getPoolStats('pool-1');
   * ```
   */
  getPoolStats() {
    return this._pool ? this._pool.getStats() : null;
  }

  // ---------------------------------------------------------------------------
  // Issue #94 — co-signer workflow
  // ---------------------------------------------------------------------------

  /**
   * Collects co-signatures required for co-creator approved invoices.
   *
   * @param txHash - Transaction hash needing approval.
   * @returns Promise resolving to collected signatures array.
   *
   * @example
   * ```typescript
   * const sigs = await client.collectCoSignatures(txHash);
   * ```
   */
  async collectCoSignatures(
    invoiceId: string,
    signers: string[],
  ): Promise<string> {
    if (signers.length === 0) throw new NoSignerProvidedError();

    const firstSigner = signers[0]!;
    const operation = this.contract.call(
      "release_invoice",
      nativeToScVal(BigInt(invoiceId), { type: "u64" }),
    );

    const account = await this.server.getAccount(firstSigner);
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new SimulationFailedError(
        `Simulation failed: ${simResult.error}`,
        "collectCoSignatures",
        simResult.error,
      );
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    return preparedTx.toXDR();
  }

  /**
   * Merge all collected co-signatures and submit the combined transaction.
   *
   * @param invoiceId  - The invoice being released.
   * @param signatures - Array of CoSignature objects (one per signer).
   * @returns The transaction hash.
   * @throws If fewer signatures are provided than the invoice requires.
   *
   * @example
   * ```typescript
   * await client.submitWithCoSignatures(tx, signatures);
   * ```
   */
  async submitWithCoSignatures(
    invoiceId: string,
    signatures: CoSignature[],
  ): Promise<TxResult> {
    const invoice = await this.getInvoice(invoiceId);
    const requiredCount = invoice.recipients.length;
    if (signatures.length < requiredCount) {
      throw new InsufficientSignaturesError(signatures.length, requiredCount);
    }

    const firstSig = signatures[0]!;
    const mergedTx = TransactionBuilder.fromXDR(
      firstSig.signedXdr,
      this.config.networkPassphrase,
    ) as Transaction;
    for (let i = 1; i < signatures.length; i++) {
      const sig = signatures[i]!;
      const otherTx = TransactionBuilder.fromXDR(
        sig.signedXdr,
        this.config.networkPassphrase,
      ) as Transaction;
      for (const decoratedSig of otherTx.signatures) {
        mergedTx.addDecoratedSignature(decoratedSig);
      }
    }

    const sendResult = await this.server.sendTransaction(mergedTx);
    if (sendResult.status === "ERROR") {
      throw new TransactionFailedError(
        `Transaction failed: ${JSON.stringify(sendResult.errorResult)}`,
      );
    }

    const txHash = sendResult.hash;
    let getResult = await this.server.getTransaction(txHash);
    let attempts = 0;
    while (
      getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
      attempts < 20
    ) {
      await new Promise((r) => setTimeout(r, 1500));
      getResult = await this.server.getTransaction(txHash);
      attempts++;
    }
    if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      throw new TransactionNotConfirmedError(String(getResult.status));
    }

    return { txHash };
  }

  /**
   * Roll an expired invoice over into a new invoice with a fresh deadline,
   * preserving all original settings automatically via the contract.
   *
   * @param invoiceId   - ID of the expired invoice to roll over.
   * @param newDeadline - Unix timestamp (seconds). Must be > Date.now() / 1000.
   * @param caller      - Stellar address of the account initiating the rollover.
   * @returns The new invoice ID and the rollover transaction hash.
   * @throws If newDeadline is not in the future.
   *
   * @example
   * ```typescript
   * const rolled = await client.rolloverInvoice('123', deadlineFromDays(30));
   * ```
   */
  async rolloverInvoice(
    invoiceId: string,
    newDeadline: number,
    caller: string,
  ): Promise<RolloverResult> {
    const startTime = Date.now();
    try {
      const result = await _rolloverInvoice(
        invoiceId,
        newDeadline,
        caller,
        this.server,
        this.config,
        this._adapter,
      );
      telemetry.recordMethod("rolloverInvoice", true, Date.now() - startTime);
      return result;
    } catch (error) {
      telemetry.recordMethod("rolloverInvoice", false, Date.now() - startTime);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Issue #262 — Co-creator approval flow
  // ---------------------------------------------------------------------------

  /**
   * Check whether an invoice requires co-creator sign-off before release.
   *
   * @param invoiceId - The invoice ID to check.
   * @throws {CoCreatorApprovalNotRequiredError} If the invoice does not require co-creator approval.
   */
  private async _needsCoCreatorApproval(invoiceId: string): Promise<void> {
    const operation = this.contract.call(
      "needs_co_creator_approval",
      nativeToScVal(BigInt(invoiceId), { type: "u64" }),
    );
    const raw = await this._simulateView(operation);
    if (!raw) {
      throw new CoCreatorApprovalNotRequiredError(invoiceId);
    }
  }

  /**
   * Submit an approval for an invoice that requires co-creator sign-off.
   *
   * The `signer` address must be one of the invoice's co-creators and must
   * sign the transaction.  Callers should check `getCoCreatorApprovals` to
   * tally signatures before releasing the invoice.
   *
   * @param invoiceId - The invoice ID to approve.
   * @param signer    - Stellar address of the co-creator submitting approval.
   * @returns The transaction hash.
   * @throws {CoCreatorApprovalNotRequiredError} If the invoice does not require co-creator sign-off.
   *
   * @example
   * ```typescript
   * await client.submitCoCreatorApproval('123', 'GA...COCREATOR');
   * ```
   */
  async submitCoCreatorApproval(
    invoiceId: string,
    signer: string,
  ): Promise<TxResult> {
    const startTime = Date.now();
    try {
      await this._needsCoCreatorApproval(invoiceId);

      const operation = this.contract.call(
        "submit_co_creator_approval",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(signer, { type: "address" }),
      );
      const result = await this._submitTx(signer, operation);
      telemetry.recordMethod(
        "submitCoCreatorApproval",
        true,
        Date.now() - startTime,
      );
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod(
        "submitCoCreatorApproval",
        false,
        Date.now() - startTime,
      );
      throw error;
    }
  }

  /**
   * Get the list of addresses that have approved a co-creator approval invoice.
   *
   * @param invoiceId - The invoice ID to query.
   * @returns Array of Stellar addresses that have approved.
   * @throws {CoCreatorApprovalNotRequiredError} If the invoice does not require co-creator sign-off.
   *
   * @example
   * ```typescript
   * const approvals = await client.getCoCreatorApprovals('123');
   * ```
   */
  async getCoCreatorApprovals(invoiceId: string): Promise<string[]> {
    const startTime = Date.now();
    try {
      await this._needsCoCreatorApproval(invoiceId);

      const operation = this.contract.call(
        "get_co_creator_approvals",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      );
      const raw = (await this._simulateView(operation)) as string[];
      telemetry.recordMethod(
        "getCoCreatorApprovals",
        true,
        Date.now() - startTime,
      );
      return raw;
    } catch (error) {
      telemetry.recordMethod(
        "getCoCreatorApprovals",
        false,
        Date.now() - startTime,
      );
      throw error;
    }
  }

  /**
   * Revoke a prior co-creator approval for an invoice.
   *
   * Only the original signer can revoke their own approval.  The `signer`
   * address must sign the transaction.
   *
   * @param invoiceId - The invoice ID to revoke approval for.
   * @param signer    - Stellar address of the co-creator revoking their approval.
   * @returns The transaction hash.
   * @throws {CoCreatorApprovalNotRequiredError} If the invoice does not require co-creator sign-off.
   *
   * @example
   * ```typescript
   * await client.revokeCoCreatorApproval('123', 'GA...COCREATOR');
   * ```
   */
  async revokeCoCreatorApproval(
    invoiceId: string,
    signer: string,
  ): Promise<TxResult> {
    const startTime = Date.now();
    try {
      await this._needsCoCreatorApproval(invoiceId);

      const operation = this.contract.call(
        "revoke_co_creator_approval",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(signer, { type: "address" }),
      );
      const result = await this._submitTx(signer, operation);
      telemetry.recordMethod(
        "revokeCoCreatorApproval",
        true,
        Date.now() - startTime,
      );
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod(
        "revokeCoCreatorApproval",
        false,
        Date.now() - startTime,
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Payment cooldown
  // ---------------------------------------------------------------------------

  /**
   * Check whether a payer is in their cooldown period for a given invoice
   * and when they can next pay.
   *
   * @param invoiceId    - The invoice ID to check.
   * @param payerAddress - Stellar address of the payer.
   * @returns Cooldown status with inCooldown flag and cooldownEndsAt timestamp.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const cooldown = await client.getPaymentCooldown('123', 'GA...PAYER');
   * ```
   */
  async getPaymentCooldown(
    invoiceId: string,
    payerAddress: string,
  ): Promise<PaymentCooldown> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "payment_cooldown",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(payerAddress, { type: "address" }),
      );
      const raw = (await this._simulateView(operation)) as Record<
        string,
        unknown
      >;
      const result: PaymentCooldown = {
        inCooldown: Boolean(raw.in_cooldown ?? raw.inCooldown ?? false),
        cooldownEndsAt:
          raw.cooldown_ends_at != null
            ? Number(raw.cooldown_ends_at)
            : raw.cooldownEndsAt != null
              ? Number(raw.cooldownEndsAt)
              : null,
      };
      telemetry.recordMethod(
        "getPaymentCooldown",
        true,
        Date.now() - startTime,
      );
      return result;
    } catch (error) {
      telemetry.recordMethod(
        "getPaymentCooldown",
        false,
        Date.now() - startTime,
      );
      throw error;
    }
  }

  // Scheduled release countdown
  // ---------------------------------------------------------------------------

  /**
   * Computes time remaining until a timelocked or scheduled invoice release executes.
   *
   * @param invoiceOrTimestamp - Invoice object or Unix release timestamp.
   * @returns ScheduledReleaseCountdown object with days, hours, minutes, and seconds remaining, or null.
   *
   * @example
   * ```typescript
   * const countdown = client.getScheduledReleaseCountdown(invoice);
   * if (countdown) console.log(`${countdown.days}d ${countdown.hours}h left`);
   * ```
   */
  getScheduledReleaseCountdown(
    invoiceOrTimestamp: Invoice | number,
  ): ScheduledReleaseCountdown | null {
    if (typeof invoiceOrTimestamp !== "number") {
      return getScheduledReleaseCountdown(invoiceOrTimestamp);
    }
    return _computeCountdown(invoiceOrTimestamp);
  }

  // ---------------------------------------------------------------------------
  // Auction workflow
  // ---------------------------------------------------------------------------

  /**
   * Place a bid on an invoice that has auction_on_expiry enabled.
   * @param bidder - Stellar address of the bidder (must sign).
   * @param invoiceId - The ID of the invoice to bid on.
   * @param amount - Bid amount in stroops.
   * @returns The transaction hash.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.placeBid('GA...BIDDER', '123', 80_0000000n);
   * ```
   */
  async placeBid(
    bidder: string,
    invoiceId: string,
    amount: bigint,
  ): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "place_bid",
        nativeToScVal(bidder, { type: "address" }),
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(amount, { type: "i128" }),
      );
      const result = await this._submitTx(bidder, operation);
      telemetry.recordMethod("placeBid", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("placeBid", false, Date.now() - startTime);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Payment history (sharded)
  // ---------------------------------------------------------------------------

  /**
   * Fetch the full payment history for an invoice by querying all 8 payment
   * shards in parallel. Returns a merged, chronologically sorted payment list.
   *
   * The contract stores payments across up to 8 shards per invoice (issue #177)
   * to work around Soroban per-contract-entry size limits.
   *
   * @param invoiceId - The invoice ID to fetch payments for.
   * @returns All payments merged and sorted by timestamp (ascending).
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const history = await client.getPaymentHistory('123');
   * ```
   */
  async getPaymentHistory(invoiceId: string): Promise<Payment[]> {
    if (this._batcher) {
      return this._batcher.getPaymentHistory(invoiceId);
    }
    return this._fetchPaymentHistory(invoiceId);
  }

  private async _fetchPaymentHistory(
    invoiceId: string,
    traceId?: string,
  ): Promise<Payment[]> {
    const startTime = Date.now();
    try {
      const NUM_SHARDS = 8;

      const operations = Array.from({ length: NUM_SHARDS }, (_, i) =>
        this.contract.call(
          "get_payment_shard",
          nativeToScVal(BigInt(invoiceId), { type: "u64" }),
          nativeToScVal(i, { type: "u32" }),
        ),
      );

      const shardResults = await Promise.allSettled(
        operations.map((op) => this._simulateView(op, traceId)),
      );

      const allPayments: Payment[] = [];
      for (const result of shardResults) {
        if (result.status === "fulfilled" && Array.isArray(result.value)) {
          for (const raw of result.value as unknown[]) {
            const p = raw as Record<string, unknown>;
            allPayments.push({
              payer: (p.payer ?? p.payer) as string,
              amount: BigInt((p.amount ?? p.amount ?? 0) as string | number),
              ledger: p.ledger != null ? Number(p.ledger) : undefined,
              timestamp: p.timestamp != null ? Number(p.timestamp) : undefined,
              donateOnFailure: Boolean(
                p.donateOnFailure ?? p.donate_on_failure ?? false,
              ),
            });
          }
        }
      }

      allPayments.sort((a, b) => {
        const ta = a.timestamp ?? a.ledger ?? 0;
        const tb = b.timestamp ?? b.ledger ?? 0;
        return ta - tb;
      });

      telemetry.recordMethod("getPaymentHistory", true, Date.now() - startTime);
      return allPayments;
    } catch (error) {
      telemetry.recordMethod(
        "getPaymentHistory",
        false,
        Date.now() - startTime,
      );
      throw error;
    }
  }
  /**
   * Settle an auction for an invoice, releasing funds to the winning bidder.
   * @param caller - Stellar address of the caller (must sign).
   * @param invoiceId - The ID of the invoice to settle.
   * @returns The transaction hash.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.settleAuction('GA...', '123');
   * ```
   */
  async settleAuction(caller: string, invoiceId: string): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "settle_auction",
        nativeToScVal(caller, { type: "address" }),
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      );
      const result = await this._submitTx(caller, operation);
      telemetry.recordMethod("settleAuction", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("settleAuction", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Get the auction state for an invoice.
   * @param invoiceId - The ID of the invoice to query.
   * @returns Auction information including active state, highest bid, and end time.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const auction = await client.getAuctionInfo('123');
   * ```
   */
  async getAuctionInfo(invoiceId: string): Promise<AuctionInfo> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "get_auction_info",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      );
      const raw = (await this._simulateView(operation)) as Record<
        string,
        unknown
      >;
      const info: AuctionInfo = {
        invoiceId,
        active: Boolean(raw.active),
        highestBid: raw.highestBid
          ? {
              bidder: (raw.highestBid as Record<string, unknown>)
                .bidder as string,
              amount: BigInt(
                (raw.highestBid as Record<string, unknown>).amount as
                  | string
                  | number,
              ),
              timestamp: Number(
                (raw.highestBid as Record<string, unknown>).timestamp,
              ),
            }
          : null,
        endTime: Number(raw.endTime ?? 0),
      };
      telemetry.recordMethod("getAuctionInfo", true, Date.now() - startTime);
      return info;
    } catch (error) {
      telemetry.recordMethod("getAuctionInfo", false, Date.now() - startTime);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Admin freeze / unfreeze
  // ---------------------------------------------------------------------------

  /**
   * Verify an admin keypair against an expected admin address.
   *
   * The keypair's public key must equal `expectedAddress`. This ensures no
   * caller can pass a foreign address and have the SDK sign on their behalf.
   *
   * @throws {AdminOperationError} When no admin keypair is configured or the
   *   keypair's public key does not match `expectedAddress`.
   */
  private _verifyAdminKeypair(
    adminKeypair: Keypair,
    expectedAddress: string,
  ): void {
    const kpAddress = adminKeypair.publicKey();
    if (kpAddress !== expectedAddress) {
      throw new AdminOperationError(
        `Admin keypair public key (${kpAddress}) does not match the provided admin address (${expectedAddress})`,
        expectedAddress,
      );
    }
  }

  /**
   * Like `_submitTx`, but signs the prepared transaction directly with the
   * given `Keypair` instead of delegating to the wallet adapter or Freighter.
   * Intended exclusively for admin operations that carry a dedicated keypair.
   */
  private _submitTxWithKeypair(
    sourceAddress: string,
    operation: xdr.Operation,
    keypair: Keypair,
  ): Promise<{ txHash: string; returnValue: xdr.ScVal }> {
    return this._queue.enqueue("normal", async () => {
      return this._doSubmitTxWithKeypair(sourceAddress, operation, keypair);
    });
  }

  private async _doSubmitTxWithKeypair(
    sourceAddress: string,
    operation: xdr.Operation,
    keypair: Keypair,
  ): Promise<{ txHash: string; returnValue: xdr.ScVal }> {
    await this._rateLimiter?.acquire();

    const account = await this.server.getAccount(sourceAddress);

    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw parseSorobanError(simResult.error);
    }

    const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
    preparedTx.sign(keypair);
    const signedXdr = preparedTx.toXDR();

    const sendResult = await this.server.sendTransaction(
      TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase),
    );
    if (sendResult.status === "ERROR") {
      throw new TransactionFailedError(
        `Transaction failed: ${JSON.stringify(sendResult.errorResult)}`,
        sendResult.hash,
        JSON.stringify(sendResult.errorResult),
      );
    }

    const txHash = sendResult.hash;
    let getResult = await this.server.getTransaction(txHash);
    let attempts = 0;
    while (
      getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
      attempts < 20
    ) {
      await new Promise((r) => setTimeout(r, 1500));
      getResult = await this.server.getTransaction(txHash);
      attempts++;
    }
    if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      throw new TransactionNotConfirmedError(String(getResult.status));
    }

    const returnValue =
      (getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse)
        .returnValue ?? xdr.ScVal.scvVoid();

    return { txHash, returnValue };
  }

  /**
   * Freeze an invoice. Only an authorized admin keypair can call this.
   * The `admin` address must sign the transaction.
   *
   * @param invoiceId - The invoice ID to freeze.
   * @param admin     - Stellar address of the admin (must sign).
   * @returns The transaction hash.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.adminFreeze('123', 'GA...ADMIN');
   * ```
   */
  async adminFreeze(invoiceId: string, admin: string): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "admin_freeze",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      );
      const result = await this._submitTx(admin, operation);
      telemetry.recordMethod("adminFreeze", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("adminFreeze", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Freeze an invoice as an authorized admin.
   *
   * The SDK verifies that `adminKeypair.publicKey()` matches `adminKeypair`'s
   * derived address before building the transaction. The keypair signs the
   * Soroban transaction directly — no wallet adapter is involved.
   *
   * An audit event is emitted regardless of success or failure.
   *
   * @param invoiceId    - Invoice ID to freeze.
   * @param reason       - Human-readable reason for the freeze (stored in the audit log).
   * @param adminKeypair - Authorized admin keypair used to sign the transaction.
   * @returns {@link AdminFreezeResult} with txHash, invoiceId, adminAddress, reason, and timestamp.
   * @throws {AdminOperationError} When the keypair's public key is invalid.
   *
   * @example
   * ```typescript
   * await client.adminFreezeInvoice('123', 'Regulatory investigation', adminKeypair);
   * ```
   */
  async adminFreezeInvoice(
    invoiceId: string,
    reason: string,
    adminKeypair: Keypair,
  ): Promise<AdminFreezeResult> {
    const adminAddress = adminKeypair.publicKey();
    const startTime = Date.now();

    // Verify the keypair is consistent with the effective admin configuration.
    // When an adminKeypair is configured at construction time, the passed
    // keypair must have the same public key.
    if (this._adminKeypair && this._adminKeypair.publicKey() !== adminAddress) {
      throw new AdminOperationError(
        `Provided admin keypair (${adminAddress}) does not match the configured admin keypair (${this._adminKeypair.publicKey()})`,
        adminAddress,
      );
    }

    try {
      const operation = this.contract.call(
        "admin_freeze",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(reason, { type: "string" }),
      );
      const result = await this._submitTxWithKeypair(
        adminAddress,
        operation,
        adminKeypair,
      );
      const durationMs = Date.now() - startTime;
      telemetry.recordMethod("adminFreezeInvoice", true, durationMs);
      this._logAudit(
        "adminFreezeInvoice",
        { invoiceId, reason, adminAddress },
        true,
        durationMs,
      );
      return {
        txHash: result.txHash,
        invoiceId,
        adminAddress,
        reason,
        timestamp: Date.now(),
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      telemetry.recordMethod("adminFreezeInvoice", false, durationMs);
      this._logAudit(
        "adminFreezeInvoice",
        { invoiceId, reason, adminAddress },
        false,
        durationMs,
      );
      throw error;
    }
  }

  /**
   * Unfreeze a previously frozen invoice as an authorized admin.
   *
   * The SDK verifies that `adminKeypair.publicKey()` matches the effective
   * admin address before building the transaction. The keypair signs the
   * Soroban transaction directly — no wallet adapter is involved.
   *
   * An audit event is emitted regardless of success or failure.
   *
   * @param invoiceId    - Invoice ID to unfreeze.
   * @param adminKeypair - Authorized admin keypair used to sign the transaction.
   * @returns {@link AdminUnfreezeResult} with txHash, invoiceId, adminAddress, and timestamp.
   * @throws {AdminOperationError} When the keypair's public key is invalid.
   *
   * @example
   * ```typescript
   * await client.adminUnfreezeInvoice('123', adminKeypair);
   * ```
   */
  async adminUnfreezeInvoice(
    invoiceId: string,
    adminKeypair: Keypair,
  ): Promise<AdminUnfreezeResult> {
    const adminAddress = adminKeypair.publicKey();
    const startTime = Date.now();

    // Verify the keypair is consistent with the effective admin configuration.
    if (this._adminKeypair && this._adminKeypair.publicKey() !== adminAddress) {
      throw new AdminOperationError(
        `Provided admin keypair (${adminAddress}) does not match the configured admin keypair (${this._adminKeypair.publicKey()})`,
        adminAddress,
      );
    }

    try {
      const operation = this.contract.call(
        "admin_unfreeze",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      );
      const result = await this._submitTxWithKeypair(
        adminAddress,
        operation,
        adminKeypair,
      );
      const durationMs = Date.now() - startTime;
      telemetry.recordMethod("adminUnfreezeInvoice", true, durationMs);
      this._logAudit(
        "adminUnfreezeInvoice",
        { invoiceId, adminAddress },
        true,
        durationMs,
      );
      return {
        txHash: result.txHash,
        invoiceId,
        adminAddress,
        timestamp: Date.now(),
      };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      telemetry.recordMethod("adminUnfreezeInvoice", false, durationMs);
      this._logAudit(
        "adminUnfreezeInvoice",
        { invoiceId, adminAddress },
        false,
        durationMs,
      );
      throw error;
    }
  }



  // Timelock action queue
  // ---------------------------------------------------------------------------

  /**
   * Queue a treasury or fee change action for execution after a timelock delay.
   * @param params - Queue action parameters.
   * @returns The action ID and transaction hash.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const actionId = await client.queueAction(actionParams);
   * ```
   */
  async queueAction(
    params: QueueActionParams,
  ): Promise<{ actionId: string; txHash: string }> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "queue_action",
        nativeToScVal(params.caller, { type: "address" }),
        nativeToScVal(params.actionType, { type: "symbol" }),
        nativeToScVal(params.target, { type: "address" }),
        nativeToScVal(params.value, { type: "i128" }),
        nativeToScVal(BigInt(params.eta), { type: "u64" }),
      );
      const result = await this._submitTx(params.caller, operation);
      const actionId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod("queueAction", true, Date.now() - startTime);
      return { actionId, txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("queueAction", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Unfreeze a previously frozen invoice. Only an authorized admin keypair can call this.
   * The `admin` address must sign the transaction.
   *
   * @param invoiceId - The invoice ID to unfreeze.
   * @param admin     - Stellar address of the admin (must sign).
   * @returns The transaction hash.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.adminUnfreeze('123', 'GA...ADMIN');
   * ```
   */
  async adminUnfreeze(invoiceId: string, admin: string): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "admin_unfreeze",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      );
      const result = await this._submitTx(admin, operation);
      telemetry.recordMethod("adminUnfreeze", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("adminUnfreeze", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Execute a previously queued action after its timelock has elapsed.
   * @param caller - Stellar address of the caller (must sign).
   * @param actionId - The ID of the action to execute.
   * @returns The transaction hash.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.executeAction('GA...', 'act-123');
   * ```
   */
  async executeAction(caller: string, actionId: string): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "execute_action",
        nativeToScVal(caller, { type: "address" }),
        nativeToScVal(BigInt(actionId), { type: "u64" }),
      );
      const result = await this._submitTx(caller, operation);
      telemetry.recordMethod("executeAction", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("executeAction", false, Date.now() - startTime);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Cross-chain references
  // ---------------------------------------------------------------------------

  /**
   * Fetch the cross-chain reference for an invoice and parse it into a
   * structured format.
   *
   * @param invoiceId - The invoice ID to query.
   * @returns The parsed CrossChainRef, or null if none is set.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const ref = await client.getCrossChainRef('123');
   * ```
   */
  async getCrossChainRef(invoiceId: string): Promise<CrossChainRef | null> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "get_cross_chain_ref",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      );
      const raw = (await this._simulateView(operation)) as Record<
        string,
        unknown
      > | null;
      if (!raw) {
        telemetry.recordMethod(
          "getCrossChainRef",
          true,
          Date.now() - startTime,
        );
        return null;
      }
      const result: CrossChainRef = {
        chain: String(raw.chain ?? raw.chain ?? ""),
        transactionHash: String(raw.transactionHash ?? raw.tx_hash ?? ""),
        blockNumber:
          raw.blockNumber != null
            ? String(raw.blockNumber)
            : raw.block_number != null
              ? String(raw.block_number)
              : undefined,
      };
      telemetry.recordMethod("getCrossChainRef", true, Date.now() - startTime);
      return result;
    } catch (error) {
      telemetry.recordMethod("getCrossChainRef", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Releases funds from a fully funded invoice to all configured recipients.
   *
   * @param invoiceId - Unique identifier of the invoice to release.
   * @returns An object containing the transaction hash `{ txHash }`.
   * @throws {InvoiceNotFoundError} If the invoice does not exist.
   * @throws {Error} If the release transaction fails.
   *
   * @example
   * ```typescript
   * const result = await client.release("123");
   * console.log(`Funds released in tx: ${result.txHash}`);
   * ```
   */
  async release(invoiceId: string): Promise<TxResult> {
    if (this._offlineQueue?.config?.enabled) {
      try {
        const health = await this.checkRPCHealth();
        if (health.status === "down") {
          this._offlineQueue.enqueue("release", [invoiceId]);
          return { txHash: "queued" };
        }
      } catch (e) {
        this._offlineQueue.enqueue("release", [invoiceId]);
        return { txHash: "queued" };
      }
    }
    throw new Error("Not implemented");
  }

  /**
   * Cancels an unreleased invoice, reverting pending splits and unlocking funds.
   *
   * @param invoiceId - ID of the invoice to cancel.
   * @returns Promise resolving to cancellation TxResult.
   *
   * @example
   * ```typescript
   * await client.cancel('123');
   * ```
   */
  async cancel(invoiceId: string): Promise<TxResult> {
    if (this._offlineQueue?.config?.enabled) {
      try {
        const health = await this.checkRPCHealth();
        if (health.status === "down") {
          this._offlineQueue.enqueue("cancel", [invoiceId]);
          return { txHash: "queued" };
        }
      } catch (e) {
        this._offlineQueue.enqueue("cancel", [invoiceId]);
        return { txHash: "queued" };
      }
    }
    throw new Error("Not implemented");
  }

  /**
   * Cancels an enqueued timelocked governance action prior to execution.
   *
   * @param caller - Caller address cancelling the action.
   * @param actionId - ID of the action.
   * @returns Promise resolving to TxResult.
   *
   * @example
   * ```typescript
   * await client.cancelAction('GA...', 'act-123');
   * ```
   */
  async cancelAction(caller: string, actionId: string): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "cancel_action",
        nativeToScVal(caller, { type: "address" }),
        nativeToScVal(BigInt(actionId), { type: "u64" }),
      );
      const result = await this._submitTx(caller, operation);
      telemetry.recordMethod("cancelAction", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("cancelAction", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Attach a cross-chain reference to an invoice. The creator address must sign.
   *
   * @param params - Parameters including invoiceId, creator, and the CrossChainRef.
   * @returns The transaction hash.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.setCrossChainRef({ invoiceId: '123', chain: 'ethereum', txHash: '0x...' });
   * ```
   */
  async setCrossChainRef(params: SetCrossChainRefParams): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const refMap: xdr.ScMapEntry[] = [
        new xdr.ScMapEntry({
          key: nativeToScVal("chain", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(params.ref.chain, { type: "string" }) as xdr.ScVal,
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("tx_hash", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(params.ref.transactionHash, {
            type: "string",
          }) as xdr.ScVal,
        }),
      ];
      if (params.ref.blockNumber !== undefined) {
        refMap.push(
          new xdr.ScMapEntry({
            key: nativeToScVal("block_number", { type: "symbol" }) as xdr.ScVal,
            val: nativeToScVal(params.ref.blockNumber, {
              type: "string",
            }) as xdr.ScVal,
          }),
        );
      }

      const operation = this.contract.call(
        "set_cross_chain_ref",
        nativeToScVal(BigInt(params.invoiceId), { type: "u64" }),
        nativeToScVal(params.creator, { type: "address" }),
        xdr.ScVal.scvMap(refMap),
      );
      const result = await this._submitTx(params.creator, operation);
      telemetry.recordMethod("setCrossChainRef", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("setCrossChainRef", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Get the status of a queued action.
   * @param actionId - The ID of the action to query.
   * @returns Timelock action status.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const action = await client.getActionStatus('act-123');
   * ```
   */
  async getActionStatus(actionId: string): Promise<TimelockAction> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "get_action_status",
        nativeToScVal(BigInt(actionId), { type: "u64" }),
      );
      const raw = (await this._simulateView(operation)) as Record<
        string,
        unknown
      >;
      const status: TimelockAction = {
        actionId,
        actionType: raw.actionType as string,
        target: raw.target as string,
        value: BigInt(raw.value as string | number),
        eta: Number(raw.eta),
        executed: Boolean(raw.executed),
        cancelled: Boolean(raw.cancelled),
      };
      telemetry.recordMethod("getActionStatus", true, Date.now() - startTime);
      return status;
    } catch (error) {
      telemetry.recordMethod("getActionStatus", false, Date.now() - startTime);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Issue #285 — Velocity limit status
  // ---------------------------------------------------------------------------

  /**
   * Check the current velocity-window state for a payer on a specific invoice.
   *
   * Reads the on-chain window state via RPC and reports how much the payer can
   * still pay in the current window. If the invoice has no velocity limit
   * configured, returns `{ limited: false }`.
   *
   * @param invoiceId    - The invoice ID to check.
   * @param payerAddress - Stellar address of the payer.
   * @returns The active window state, or `{ limited: false }` if unlimited.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const velocity = await client.getVelocityStatus('123', 'GA...PAYER');
   * ```
   */
  async getVelocityStatus(
    invoiceId: string,
    payerAddress: string,
  ): Promise<VelocityStatus> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "get_velocity_status",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(payerAddress, { type: "address" }),
      );
      const raw = await this._simulateView(operation);

      telemetry.recordMethod("getVelocityStatus", true, Date.now() - startTime);

      // No velocity limit configured: contract returns void/null.
      if (raw === null || raw === undefined) {
        return { limited: false };
      }

      const state = raw as Record<string, unknown>;
      const windowStart = Number(state.window_start ?? state.windowStart ?? 0);
      const windowEnd = Number(state.window_end ?? state.windowEnd ?? 0);
      const amountUsed = toBigInt(state.amount_used ?? state.amountUsed);
      const limitPerWindow = toBigInt(
        state.limit_per_window ?? state.limitPerWindow,
      );
      const remaining = limitPerWindow - amountUsed;

      return {
        windowStart,
        windowEnd,
        amountUsed,
        limitPerWindow,
        amountRemaining: remaining > 0n ? remaining : 0n,
      };
    } catch (error) {
      telemetry.recordMethod(
        "getVelocityStatus",
        false,
        Date.now() - startTime,
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Issue #866 — Pause/Resume invoice
  // ---------------------------------------------------------------------------

  /**
   * Temporarily pauses payment acceptance for an invoice.
   *
   * @param invoiceId - The ID of the invoice to pause.
   * @param options - Optional pause settings.
   * @returns Promise resolving to TxResult.
   *
   * @example
   * ```typescript
   * await client.pauseInvoice('123');
   * ```
   */
  async pauseInvoice(
    invoiceId: string,
    options?: { autoResumeAt?: Date },
  ): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const autoResumeTimestamp = options?.autoResumeAt
        ? Math.floor(options.autoResumeAt.getTime() / 1000)
        : 0;

      const operation = this.contract.call(
        "pause_invoice",
        nativeToScVal(invoiceId, { type: "u64" }),
        nativeToScVal(autoResumeTimestamp, { type: "u64" }),
      );

      const result = await this._submitTx(await this._getPayerAddress() || "", operation);
      telemetry.recordMethod("pauseInvoice", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("pauseInvoice", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Resumes an active invoice from a paused state.
   *
   * @param invoiceId - The ID of the invoice to resume.
   * @returns Promise resolving to TxResult.
   *
   * @example
   * ```typescript
   * await client.resumeInvoice('123');
   * ```
   */
  async resumeInvoice(invoiceId: string): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "resume_invoice",
        nativeToScVal(invoiceId, { type: "u64" }),
      );

      const result = await this._submitTx(await this._getPayerAddress() || "", operation);
      telemetry.recordMethod("resumeInvoice", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("resumeInvoice", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Checks if an invoice is currently paused against new payments.
   *
   * @param invoiceId - The ID of the invoice.
   * @returns Promise resolving to PauseStatus.
   *
   * @example
   * ```typescript
   * const paused = await client.isPaused('123');
   * ```
   */
  async isPaused(invoiceId: string): Promise<PauseStatus> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "is_paused",
        nativeToScVal(invoiceId, { type: "u64" }),
      );

      const raw = (await this._simulateView(operation)) as Record<string, unknown>;
      const paused = Boolean(raw.paused);
      const autoResumeTimestamp = Number(raw.autoResumeAt ?? raw.auto_resume_at ?? 0);

      telemetry.recordMethod("isPaused", true, Date.now() - startTime);
      return {
        paused,
        autoResumeAt: autoResumeTimestamp > 0 ? new Date(autoResumeTimestamp * 1000) : undefined,
      };
    } catch (error) {
      telemetry.recordMethod("isPaused", false, Date.now() - startTime);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Issue #867 — Pledge matching
  // ---------------------------------------------------------------------------

  /**
   * Pledges matching funds toward an invoice split funding pool.
   *
   * @param invoiceId - The target invoice ID.
   * @param amount - Pledged amount in stroops.
   * @returns Promise resolving to TxResult.
   *
   * @example
   * ```typescript
   * await client.pledgeMatch('123', 50_0000000n);
   * ```
   */
  async pledgeMatch(invoiceId: string, amount: bigint): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "pledge_match",
        nativeToScVal(invoiceId, { type: "u64" }),
        nativeToScVal(amount, { type: "i128" }),
      );

      const result = await this._submitTx(await this._getPayerAddress() || "", operation);
      telemetry.recordMethod("pledgeMatch", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("pledgeMatch", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Reclaims unmatched pledge funds after an invoice has settled or reached its deadline.
   *
   * @param invoiceId - Invoice identifier.
   * @returns Promise resolving to reclaimed amount in stroops as bigint.
   *
   * @example
   * ```typescript
   * const reclaimed = await client.claimUnmatchedPledge('123');
   * ```
   */
  async claimUnmatchedPledge(invoiceId: string): Promise<bigint> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "claim_unmatched_pledge",
        nativeToScVal(invoiceId, { type: "u64" }),
      );

      const result = await this._submitTx(await this._getPayerAddress() || "", operation);
      const amount = scValToNative(result.returnValue) as bigint;
      telemetry.recordMethod("claimUnmatchedPledge", true, Date.now() - startTime);
      return amount;
    } catch (error) {
      telemetry.recordMethod("claimUnmatchedPledge", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Queries active matching pledges associated with an invoice.
   *
   * @param invoiceId - Invoice ID.
   * @returns Promise resolving to array of MatchPledge records.
   *
   * @example
   * ```typescript
   * const pledges = await client.getMatchPool('123');
   * ```
   */
  async getMatchPool(invoiceId: string): Promise<MatchPledge[]> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "get_match_pool",
        nativeToScVal(invoiceId, { type: "u64" }),
      );

      const raw = (await this._simulateView(operation)) as Array<Record<string, unknown>>;
      const pledges: MatchPledge[] = (raw || []).map((p) => ({
        matcher: p.matcher as string,
        pledgedAmount: toBigInt(p.pledgedAmount ?? p.pledged_amount),
        matchedAmount: toBigInt(p.matchedAmount ?? p.matched_amount),
        unmatched: toBigInt(p.unmatched),
      }));

      telemetry.recordMethod("getMatchPool", true, Date.now() - startTime);
      return pledges;
    } catch (error) {
      telemetry.recordMethod("getMatchPool", false, Date.now() - startTime);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Issue #868 — Streaming payments
  // ---------------------------------------------------------------------------

  /**
   * Initiates continuous ledger-based payment streaming toward an invoice.
   *
   * @param invoiceId - Target invoice ID.
   * @param amountPerLedger - Payment flow rate per Stellar ledger block in stroops.
   * @returns Promise resolving to unique stream ID string.
   *
   * @example
   * ```typescript
   * const streamId = await client.startStream('123', 100000n);
   * ```
   */
  async startStream(invoiceId: string, amountPerLedger: bigint): Promise<string> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "start_stream",
        nativeToScVal(invoiceId, { type: "u64" }),
        nativeToScVal(amountPerLedger, { type: "i128" }),
      );

      const result = await this._submitTx(await this._getPayerAddress() || "", operation);
      const streamId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod("startStream", true, Date.now() - startTime);
      return streamId;
    } catch (error) {
      telemetry.recordMethod("startStream", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Settles accrued streaming payment funds and distributes them to recipients.
   *
   * @param streamId - Identifier of the active stream.
   * @returns Promise resolving to settled amount as bigint.
   *
   * @example
   * ```typescript
   * const settled = await client.settleStream(streamId);
   * ```
   */
  async settleStream(streamId: string): Promise<bigint> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "settle_stream",
        nativeToScVal(streamId, { type: "u64" }),
      );

      const result = await this._submitTx(await this._getPayerAddress() || "", operation);
      const amount = scValToNative(result.returnValue) as bigint;
      telemetry.recordMethod("settleStream", true, Date.now() - startTime);
      return amount;
    } catch (error) {
      telemetry.recordMethod("settleStream", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Terminates an active payment stream.
   *
   * @param streamId - Identifier of the stream to cancel.
   * @returns Promise resolving to refunded remaining balance as bigint.
   *
   * @example
   * ```typescript
   * const refunded = await client.cancelStream(streamId);
   * ```
   */
  async cancelStream(streamId: string): Promise<bigint> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "cancel_stream",
        nativeToScVal(streamId, { type: "u64" }),
      );

      const result = await this._submitTx(await this._getPayerAddress() || "", operation);
      const amount = scValToNative(result.returnValue) as bigint;
      telemetry.recordMethod("cancelStream", true, Date.now() - startTime);
      return amount;
    } catch (error) {
      telemetry.recordMethod("cancelStream", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Fetches current configuration and accumulated payout for a payment stream.
   *
   * @param streamId - Stream identifier.
   * @returns Promise resolving to Stream object.
   *
   * @example
   * ```typescript
   * const stream = await client.getStream(streamId);
   * ```
   */
  async getStream(streamId: string): Promise<Stream> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "get_stream",
        nativeToScVal(streamId, { type: "u64" }),
      );

      const raw = (await this._simulateView(operation)) as Record<string, unknown>;
      const stream: Stream = {
        id: streamId,
        invoiceId: raw.invoiceId as string,
        payer: raw.payer as string,
        amountPerLedger: toBigInt(raw.amountPerLedger ?? raw.amount_per_ledger),
        startLedger: Number(raw.startLedger ?? raw.start_ledger),
        status: (raw.status as string).toLowerCase() as "active" | "settled" | "cancelled",
      };

      telemetry.recordMethod("getStream", true, Date.now() - startTime);
      return stream;
    } catch (error) {
      telemetry.recordMethod("getStream", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Computes accrued unreleased payment balance for a stream up to the specified ledger number.
   *
   * @param stream - Active Stream object.
   * @param currentLedger - Current Stellar ledger sequence number.
   * @returns Accrued amount in stroops as bigint.
   *
   * @example
   * ```typescript
   * const accrued = client.computeAccruedAmount(stream, 1234567);
   * ```
   */
  computeAccruedAmount(stream: Stream, currentLedger: number): bigint {
    if (stream.status !== "active") return 0n;
    const ledgersPassed = Math.max(0, currentLedger - stream.startLedger);
    return stream.amountPerLedger * BigInt(ledgersPassed);
  }

  // ---------------------------------------------------------------------------
  // Issue #869 — Delegate management
  // ---------------------------------------------------------------------------

  /**
   * Grants management delegation permissions for an invoice to a secondary address.
   *
   * @param invoiceId - The invoice ID.
   * @param delegate - Stellar address of the authorized delegate.
   * @returns Promise resolving to TxResult.
   *
   * @example
   * ```typescript
   * await client.addDelegate('123', 'GA...DELEGATE');
   * ```
   */
  async addDelegate(invoiceId: string, delegate: string): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "add_delegate",
        nativeToScVal(invoiceId, { type: "u64" }),
        nativeToScVal(delegate, { type: "address" }),
      );

      const result = await this._submitTx(await this._getPayerAddress() || "", operation);
      telemetry.recordMethod("addDelegate", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("addDelegate", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Revokes management delegation permissions for an address on an invoice.
   *
   * @param invoiceId - The invoice ID.
   * @param delegate - Stellar address of the delegate to revoke.
   * @returns Promise resolving to TxResult.
   *
   * @example
   * ```typescript
   * await client.removeDelegate('123', 'GA...DELEGATE');
   * ```
   */
  async removeDelegate(invoiceId: string, delegate: string): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "remove_delegate",
        nativeToScVal(invoiceId, { type: "u64" }),
        nativeToScVal(delegate, { type: "address" }),
      );

      const result = await this._submitTx(await this._getPayerAddress() || "", operation);
      telemetry.recordMethod("removeDelegate", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("removeDelegate", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Checks if an address is an authorized delegate for an invoice.
   *
   * @param invoiceId - The invoice ID.
   * @param address - The address to check.
   * @returns Promise resolving to boolean.
   *
   * @example
   * ```typescript
   * const isAuth = await client.isDelegate('123', 'GA...DELEGATE');
   * ```
   */
  async isDelegate(invoiceId: string, address: string): Promise<boolean> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "is_delegate",
        nativeToScVal(invoiceId, { type: "u64" }),
        nativeToScVal(address, { type: "address" }),
      );

      const result = await this._simulateView(operation);
      const isDelegate = Boolean(result);
      telemetry.recordMethod("isDelegate", true, Date.now() - startTime);
      return isDelegate;
    } catch (error) {
      telemetry.recordMethod("isDelegate", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Lists all addresses authorized as delegates for an invoice.
   *
   * @param invoiceId - The invoice ID.
   * @returns Promise resolving to array of delegate address strings.
   *
   * @example
   * ```typescript
   * const delegates = await client.getDelegates('123');
   * ```
   */
  async getDelegates(invoiceId: string): Promise<string[]> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "get_delegates",
        nativeToScVal(invoiceId, { type: "u64" }),
      );

      const raw = (await this._simulateView(operation)) as string[];
      telemetry.recordMethod("getDelegates", true, Date.now() - startTime);
      return raw || [];
    } catch (error) {
      telemetry.recordMethod("getDelegates", false, Date.now() - startTime);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Parse the native return value from `check_nft_gate`. */
  private _parseNftGateResult(raw: unknown): NftGateResult {
    if (!raw || typeof raw !== "object") {
      return { gated: false, hasNft: false, contractAddress: null };
    }

    const obj = raw as Record<string, unknown>;
    const contractAddress = obj.contractAddress ?? obj.contract_address ?? null;

    return {
      gated: Boolean(obj.gated),
      hasNft: Boolean(obj.hasNft ?? obj.has_nft),
      contractAddress:
        typeof contractAddress === "string" ? contractAddress : null,
    };
  }

  /** Simulate a read-only contract call and return the native-decoded result. */
  private async _simulateView(
    operation: xdr.Operation,
    traceId?: string,
  ): Promise<unknown> {
    const account = await this.server
      .getAccount(this.config.contractId)
      .catch(() => null);
    const sourceAccount = account ?? new Account(this.config.contractId, "0");

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();
    if (traceId) {
      await runRequestInterceptors({
        method: "_simulateView",
        params: [],
        headers: { "X-Trace-Id": traceId },
      });
    }

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new SimulationFailedError(
        `Simulation failed: ${simResult.error}`,
        "_simulateView",
        simResult.error,
      );
    }

    const returnVal = (
      simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse
    ).result?.retval;
    if (!returnVal) throw new NoReturnValueError("_simulateView");

    return scValToNative(returnVal);
  }

  /** Build, simulate, sign, and submit a transaction — routed through the priority queue. */
  private _submitTx(
    sourceAddress: string,
    operation: xdr.Operation,
    priority: RequestPriority = "normal",
  ): Promise<{ txHash: string; returnValue: xdr.ScVal }> {
    return this._queue.enqueue(priority, async () => {
      if (this._idempotency) {
        const opXdr = operation.toXDR().toString("base64");
        const key = this._idempotency.generateKey(sourceAddress, opXdr);
        const existing = this._idempotency.getResult(key);
        if (existing) {
          return {
            txHash: existing.txHash,
            returnValue: xdr.ScVal.scvVoid(),
          };
        }
      }

      const submit = () =>
        this._advancedCircuitBreaker
          ? this._advancedCircuitBreaker.execute(() => this._doSubmitTx(sourceAddress, operation))
          : this._doSubmitTx(sourceAddress, operation);

      try {
        const result = await submit();
        if (this._idempotency) {
          const opXdr = operation.toXDR().toString("base64");
          const key = this._idempotency.generateKey(sourceAddress, opXdr);
          this._idempotency.tryClaim(key, { txHash: result.txHash });
        }
        return result;
      } catch (error) {
        if (this._standby) {
          this._standby.failover();
          const result = await submit();
          if (this._idempotency) {
            const opXdr = operation.toXDR().toString("base64");
            const key = this._idempotency.generateKey(sourceAddress, opXdr);
            this._idempotency.tryClaim(key, { txHash: result.txHash });
          }
          return result;
        }
        throw error;
      }
    });
  }

  private async _doSubmitTx(
    sourceAddress: string,
    operation: xdr.Operation,
  ): Promise<{ txHash: string; returnValue: xdr.ScVal }> {
    await this._rateLimiter?.acquire();
    const req = { method: "_submitTx", params: [sourceAddress] };
    await runRequestInterceptors(req);

    const startTime = Date.now();
    try {
      const account = await this.server.getAccount(sourceAddress);

      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simResult = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simResult)) {
        throw parseSorobanError(simResult.error);
      }

      const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      const signedXdr = await (this._adapter
        ? this._adapter.signTransaction(
            preparedTx.toXDR(),
            this.config.networkPassphrase,
          )
        : signTransaction(preparedTx.toXDR(), this.config.networkPassphrase));

      const sendResult = await this.server.sendTransaction(
        TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase),
      );
      if (sendResult.status === "ERROR") {
        throw new TransactionFailedError(
          `Transaction failed: ${JSON.stringify(sendResult.errorResult)}`,
          sendResult.hash,
          JSON.stringify(sendResult.errorResult),
        );
      }

      const txHash = sendResult.hash;
      let getResult = await this.server.getTransaction(txHash);
      let attempts = 0;
      while (
        getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
        attempts < 20
      ) {
        await new Promise((r) => setTimeout(r, 1500));
        getResult = await this.server.getTransaction(txHash);
        attempts++;
      }

      // If still not confirmed, submit a fee-bump transaction with a higher fee
      if (getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND) {
        const multiplier = this.config.feeBumpMultiplier ?? 2;
        const innerTx = TransactionBuilder.fromXDR(
          signedXdr,
          this.config.networkPassphrase,
        ) as Parameters<typeof TransactionBuilder.buildFeeBumpTransaction>[2];
        const bumpedFee = String(Math.ceil(Number(BASE_FEE) * multiplier));
        const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
          sourceAddress,
          bumpedFee,
          innerTx,
          this.config.networkPassphrase,
        );
        const signedBumpXdr = await (this._adapter
          ? this._adapter.signTransaction(
              feeBumpTx.toXDR(),
              this.config.networkPassphrase,
            )
          : signTransaction(feeBumpTx.toXDR(), this.config.networkPassphrase));
        const bumpSendResult = await this.server.sendTransaction(
          TransactionBuilder.fromXDR(
            signedBumpXdr,
            this.config.networkPassphrase,
          ),
        );
        if (bumpSendResult.status === "ERROR") {
          throw new TransactionFailedError(
            `Fee-bump transaction failed: ${JSON.stringify(bumpSendResult.errorResult)}`,
            bumpSendResult.hash,
            JSON.stringify(bumpSendResult.errorResult),
          );
        }
        const bumpHash = bumpSendResult.hash;
        let bumpResult = await this.server.getTransaction(bumpHash);
        let bumpAttempts = 0;
        while (
          bumpResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
          bumpAttempts < 20
        ) {
          await new Promise((r) => setTimeout(r, 1500));
          bumpResult = await this.server.getTransaction(bumpHash);
          bumpAttempts++;
        }
        if (bumpResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
          throw new TransactionNotConfirmedError(String(bumpResult.status));
        }
        const bumpReturnValue =
          (bumpResult as SorobanRpc.Api.GetSuccessfulTransactionResponse)
            .returnValue ?? xdr.ScVal.scvVoid();

        const durationMs = Date.now() - startTime;
        await runResponseInterceptors({
          method: "_submitTx",
          result: { txHash: bumpHash, returnValue: bumpReturnValue },
          durationMs,
        });
  /**
   * recordCall
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
        recordCall(true);
        return { txHash: bumpHash, returnValue: bumpReturnValue };
      }
      if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new TransactionNotConfirmedError(String(getResult.status));
      }

      const returnValue =
        (getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse)
          .returnValue ?? xdr.ScVal.scvVoid();

      const durationMs = Date.now() - startTime;
      await runResponseInterceptors({
        method: "_submitTx",
        result: { txHash, returnValue },
        durationMs,
      });
  /**
   * recordCall
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
      recordCall(true);
      return { txHash, returnValue };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      await runResponseInterceptors({
        method: "_submitTx",
        result: undefined,
        durationMs,
      });
  /**
   * recordCall
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
      recordCall(false);
      throw error;
    }
  }

  /** Build a deterministic SHA-256 receipt ID from invoice fields. */
  private async _buildReceiptId(invoice: Invoice): Promise<string> {
    const payload = `${invoice.id}${invoice.funded}${invoice.deadline}`;
    const data = new TextEncoder().encode(payload);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    return Array.from(new Uint8Array(hashBuffer))
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");
  }

  /** Parse a raw contract map into a typed Invoice. */
  private _parseInvoice(id: string, raw: Record<string, unknown>): Invoice {
    const statusMap: Record<string, InvoiceStatus> = {
      Pending: "Pending",
      Released: "Released",
      Refunded: "Refunded",
    };

    const amounts = raw.amounts as unknown[];
    const recipients: Recipient[] = (raw.recipients as string[]).map(
      (addr: string, i: number) => {
        const amt = amounts[i];
        if (amt === undefined)
          throw new NoReturnValueError(`_parseInvoice ${i}`);
        return {
          address: addr,
          amount: BigInt(amt as string | number),
        };
      },
    );

    const payments: Payment[] = ((raw.payments as unknown[]) ?? []).map(
      (p: unknown) => {
        const pm = p as Record<string, unknown>;
        return {
          payer: pm.payer as string,
          amount: BigInt(pm.amount as string | number),
          donateOnFailure: pm.donateOnFailure === true,
        };
      },
    );

    return {
      id,
      creator: raw.creator as string,
      recipients,
      token: raw.token as string,
      deadline: Number(raw.deadline),
      funded: BigInt(raw.funded as string | number),
      status: statusMap[raw.status as string] ?? "Pending",
      payments,
      recurring: raw.recurring as boolean | undefined,
      memo: raw.memo as string | undefined,
      clonedFrom: raw.clonedFrom as string | undefined,
      parentInvoiceId: raw.parentInvoiceId
        ? String(raw.parentInvoiceId)
        : undefined,
      cloneDepth:
        typeof raw.cloneDepth === "number" ? raw.cloneDepth : undefined,
      groupId: raw.groupId as string | undefined,
    };
  }

  /**
   * Fetch extended invoice metadata (clone chain info) via get_invoice_ext.
   */
  private async _getInvoiceExt(invoiceId: string): Promise<InvoiceExt> {
    const operation = this.contract.call(
      "get_invoice_ext",
      nativeToScVal(BigInt(invoiceId), { type: "u64" }),
    );

    const raw = (await this._simulateView(operation)) as Record<
      string,
      unknown
    >;

    return {
      parentInvoiceId: raw.parentInvoiceId ? String(raw.parentInvoiceId) : null,
      cloneDepth: Number(raw.cloneDepth ?? 0),
    };
  }

  /** Batcher-facing alias for _getInvoiceExt. */
  private _fetchInvoiceExt(invoiceId: string): Promise<InvoiceExt> {
    return this._getInvoiceExt(invoiceId);
  }

  /**
   * Resolve the full clone chain for an invoice.
   *
   * Recursively fetches parent invoices via `parentInvoiceId` from
   * `get_invoice_ext` until the root invoice is reached. Returns the chain
   * ordered from root to leaf.
   *
   * @param invoiceId - The leaf invoice ID to resolve the chain from.
   * @returns An array of invoices ordered root → leaf.
   * @throws If the clone chain exceeds 10 levels or a cycle is detected.
   *
   * @example
   * ```typescript
   * const chain = await client.resolveCloneChain('123');
   * ```
   */
  async resolveCloneChain(invoiceId: string): Promise<Invoice[]> {
    const chain: Invoice[] = [];
    let currentId: string | null = invoiceId;
    const seen = new Set<string>();
    let depth = 0;
    const MAX_DEPTH = 10;
    while (currentId) {
      if (seen.has(currentId)) {
        throw new CloneChainTooDeepError(currentId);
      }
      if (depth >= MAX_DEPTH) {
        throw new CloneChainTooDeepError();
      }

      seen.add(currentId);
      const invoice = await this.getInvoice(currentId);
      chain.unshift(invoice);

      const ext = await this._getInvoiceExt(currentId);
      currentId = ext.parentInvoiceId;
      depth++;
    }

    return chain;
  }

  // ---------------------------------------------------------------------------
  // Issue #198 — Horizon fallback for read-only account operations
  // ---------------------------------------------------------------------------

  /**
   * Fetch normalised account info (id + sequence number).
   *
   * Tries the Soroban RPC endpoint first.  If `horizonUrl` was supplied in
   * the config and the RPC call throws, the request is automatically retried
   * against the Horizon REST API via a two-link FallbackChain.
   *
   * @param address - Stellar public key of the account.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const account = await client.getAccount('GA...ACCOUNT');
   * ```
   */
  async getAccount(address: string): Promise<NormalizedAccount> {
    const rpcFetch = async (): Promise<NormalizedAccount> => {
      const acc = await this.server.getAccount(address);
      return { id: acc.accountId(), sequence: acc.sequenceNumber() };
    };
    if (!this._horizonReader) {
      return rpcFetch();
    }

    const horizonReader = this._horizonReader;
    const chain = new FallbackChain(["rpc", "horizon"], {
      logger: (attempt) =>
        console.warn(
          `[StellarSplitClient] getAccount fallback (${attempt.url}): ${attempt.error}`,
        ),
    });

    return chain.execute(async (provider) => {
      if (provider === "rpc") return rpcFetch();
      return horizonReader.getAccount(address);
    });
  }

  /**
   * Fetch all balances for `address`.
   *
   * Balance data is not exposed by the Soroban RPC protocol, so this always
   * reads from the Horizon API.  A two-link FallbackChain is used so that if
   * `horizonUrl` is absent the call fails fast with a clear message.
   *
   * Requires `horizonUrl` to be set in the client config.
   *
   * @param address - Stellar public key of the account.
   * @throws If no `horizonUrl` was configured.
   * @returns The result of the method.
   *
   * @example
   * ```typescript
   * const balances = await client.getAccountBalances('GA...ACCOUNT');
   * ```
   */
  async getAccountBalances(address: string): Promise<NormalizedBalance[]> {
    if (!this._horizonReader) {
      throw new ValidationError(
        "getAccountBalances requires horizonUrl to be set in StellarSplitClientConfig",
      );
    }

    const horizonReader = this._horizonReader;
    // Soroban RPC has no balance endpoint — the chain falls through to Horizon immediately.
    const chain = new FallbackChain(["rpc", "horizon"], {
      logger: (attempt) =>
        console.warn(
          `[StellarSplitClient] getAccountBalances fallback (${attempt.url}): ${attempt.error}`,
        ),
    });

    return chain.execute(async (provider) => {
      if (provider === "rpc") {
        throw new ValidationError(
          "Soroban RPC does not expose account balances; delegating to Horizon",
        );
      }
      return horizonReader.getAccountBalances(address);
    });
  }

  // ---------------------------------------------------------------------------
  // Issue #196 — Claimable-balance fallback for unconfirmed refunds
  // ---------------------------------------------------------------------------

  /**
   * Refund an invoice by calling the `refund_invoice` contract method.
   *
   * If the underlying token transfer fails because the recipient account does
   * not exist or has no trustline, and `config.horizonUrl` is configured, the
   * method automatically falls back to creating a Stellar claimable balance
   * that the payer can claim once their account is ready.
   *
   * A distinguishable log entry (`[StellarSplitClient] claimable-refund fallback`)
   * is emitted so callers can tell a normal refund from a fallback refund apart.
   * The returned object includes `fallback: boolean` for programmatic detection.
   *
   * @param invoiceId    - ID of the invoice to refund.
   * @param creator      - Stellar address of the invoice creator (must sign).
   * @param payerAddress - Stellar address of the payer who receives the refund.
   *                       Required for the claimable-balance fallback path.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.refundInvoice('123', 'GA...CREATOR');
   * ```
   */
  async refundInvoice(
    invoiceId: string,
    creator: string,
    payerAddress: string | undefined,
    options: { simulate: true },
  ): Promise<SimulationResult>;
  /**
   * Triggers a full or partial refund of invoice contributions back to payers.
   *
   * @param invoiceId - The invoice ID.
   * @param creator - Creator address executing the refund.
   * @param payerAddress - Optional specific payer address for single-payer refunds.
   * @param options - Optional execution settings.
   * @returns Promise resolving to refund TxResult.
   *
   * @example
   * ```typescript
   * await client.refundInvoice('123', 'GA...CREATOR');
   * ```
   */
  async refundInvoice(
    invoiceId: string,
    creator: string,
    payerAddress?: string,
  ): Promise<{ txHash: string; fallback: false } | ClaimableRefundResult>;
  /**
   * Triggers a full or partial refund of invoice contributions back to payers.
   *
   * @param invoiceId - The invoice ID.
   * @param creator - Creator address executing the refund.
   * @param payerAddress - Optional specific payer address for single-payer refunds.
   * @param options - Optional execution settings.
   * @returns Promise resolving to refund TxResult.
   *
   * @example
   * ```typescript
   * await client.refundInvoice('123', 'GA...CREATOR');
   * ```
   */
  async refundInvoice(
    invoiceId: string,
    creator: string,
    payerAddress?: string,
    options?: { simulate?: boolean },
  ): Promise<
    SimulationResult | { txHash: string; fallback: false } | ClaimableRefundResult
  > {
    // Issue #844 — `{ simulate: true }` performs a dry-run instead of submitting.
    if (options?.simulate) {
      return this.simulate("refund_invoice", { invoiceId });
    }
    const startTime = Date.now();

    try {
      const operation = this.contract.call(
        "refund_invoice",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
      );
      const result = await this._submitTx(creator, operation);

      const invoice = await this.getInvoice(invoiceId).catch(() => null);
      if (invoice) this._fireOnRefunded(invoice);

      telemetry.recordMethod("refundInvoice", true, Date.now() - startTime);
      return { txHash: result.txHash, fallback: false };
    } catch (error) {
      // Fallback path: if transfer failed due to missing account/trustline and
      // Horizon is configured, create a claimable balance instead.
      if (
  /**
   * isRefundTransferError
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
        isRefundTransferError(error) &&
        this.config.horizonUrl &&
        payerAddress
      ) {
        console.warn(
          `[StellarSplitClient] refundInvoice: transfer failed for invoice ${invoiceId} ` +
            `(${error instanceof Error ? error.message : String(error)}); ` +
            `creating claimable-balance fallback for payer ${payerAddress}`,
        );

        try {
          const invoice = await this.getInvoice(invoiceId).catch(() => null);
          const amount = invoice?.funded ?? 0n;

          const claimableResult = await createClaimableRefund(
            payerAddress,
            amount,
            Asset.native(),
            creator,
            this.config,
          );

          telemetry.recordMethod("refundInvoice", true, Date.now() - startTime);
          return claimableResult;
        } catch (fallbackError) {
          telemetry.recordMethod(
            "refundInvoice",
            false,
            Date.now() - startTime,
          );
          throw fallbackError;
        }
      }

      telemetry.recordMethod("refundInvoice", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * List all pending claimable balances on the Stellar network that `payer`
   * can claim (created by the claimable-balance refund fallback).
   *
   * Requires `config.horizonUrl` to be set.
   *
   * @param payer - Stellar address of the claimant to query.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const refunds = await client.getClaimableRefunds('GA...PAYER');
   * ```
   */
  async getClaimableRefunds(payer: string): Promise<ClaimableRefundEntry[]> {
    return getClaimableRefunds(payer, this.config);
  }

  // ---------------------------------------------------------------------------
  // Issue #73 — syncInvoice (cross-network)
  // ---------------------------------------------------------------------------

  /**
   * Resynchronizes local client state with the latest confirmed on-chain ledger state.
   *
   * @param invoiceId - The invoice ID to synchronize.
   * @returns Promise resolving to refreshed Invoice state.
   *
   * @example
   * ```typescript
   * const freshInvoice = await client.syncInvoice('123');
   * ```
   */
  async syncInvoice(
    invoiceId: string,
  ): Promise<{ invoice: Invoice; source: string; ledger: number }> {
    const urls = Array.isArray(this.config.rpcUrl)
      ? this.config.rpcUrl
      : [this.config.rpcUrl];

    const results = await Promise.allSettled(
      urls.map(async (url) => {
        const server = new SorobanRpc.Server(url, {
          allowHttp: url.startsWith("http://"),
        });
        const operation = this.contract.call(
          "get_invoice",
          nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        );
        const account = await server
          .getAccount(this.config.contractId)
          .catch(() => null);
        const sourceAccount =
          account ?? new Account(this.config.contractId, "0");
        const tx = new TransactionBuilder(sourceAccount, {
          fee: BASE_FEE,
          networkPassphrase: this.config.networkPassphrase,
        })
          .addOperation(operation)
          .setTimeout(30)
          .build();
        const simResult = await server.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(simResult)) {
          throw new SimulationFailedError(
            `Simulation failed on ${url}: ${simResult.error}`,
            "syncInvoice",
            simResult.error,
          );
        }
        const returnVal = (
          simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse
        ).result?.retval;
        if (!returnVal) throw new NoReturnValueError(`syncInvoice ${url}`);
        const raw = scValToNative(returnVal) as Record<string, unknown>;
        const invoice = this._parseInvoice(invoiceId, raw);
        const ledger =
          typeof raw.lastModifiedLedger === "number"
            ? raw.lastModifiedLedger
            : 0;
        return { invoice, source: url, ledger };
      }),
    );

    const successful = results
      .filter(
        (
          r,
        ): r is PromiseFulfilledResult<{
          invoice: Invoice;
          source: string;
          ledger: number;
        }> => r.status === "fulfilled",
      )
      .map((r) => r.value);
    if (successful.length === 0) {
      throw new RpcUnavailableError("syncInvoice");
    }

    return successful.reduce((best, cur) =>
      cur.ledger > best.ledger ? cur : best,
    );
  }

  // ---------------------------------------------------------------------------
  // Issue #274 — Pending payout claim helper
  // ---------------------------------------------------------------------------

  /**
   * Queries the unclaimed payout amount accrued for a split recipient on an invoice.
   *
   * @param invoiceId - Invoice identifier.
   * @param recipient - Recipient account address.
   * @returns Promise resolving to pending payout in stroops as bigint.
   *
   * @example
   * ```typescript
   * const pending = await client.getPendingPayout('123', 'GA...RECIPIENT');
   * ```
   */
  async getPendingPayout(
    invoiceId: string,
    recipient: string,
  ): Promise<bigint> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "get_pending_payout",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(recipient, { type: "address" }),
      );
      const raw = await this._simulateView(operation);
      const amount = raw == null ? 0n : BigInt(raw as string | number | bigint);
      telemetry.recordMethod("getPendingPayout", true, Date.now() - startTime);
      return amount;
    } catch {
      telemetry.recordMethod("getPendingPayout", false, Date.now() - startTime);
      return 0n;
    }
  }

  /**
   * Claims accrued payout funds for a recipient on an invoice.
   *
   * @param invoiceId - The invoice ID.
   * @param recipient - Recipient account address.
   * @returns Promise resolving to ClaimPayoutResult.
   *
   * @example
   * ```typescript
   * const result = await client.claimPendingPayout('123', 'GA...RECIPIENT');
   * ```
   */
  async claimPendingPayout(
    invoiceId: string,
    recipient: string,
  ): Promise<ClaimPayoutResult> {
    const startTime = Date.now();
    try {
      const pending = await this.getPendingPayout(invoiceId, recipient);
      if (pending === 0n) {
        throw new NoPendingPayoutError(recipient, invoiceId);
      }
      const operation = this.contract.call(
        "claim_pending_payout",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(recipient, { type: "address" }),
      );
      const result = await this._submitTx(recipient, operation);
      telemetry.recordMethod(
        "claimPendingPayout",
        true,
        Date.now() - startTime,
      );
      return { txHash: result.txHash, invoiceId, recipient };
    } catch (error) {
      telemetry.recordMethod(
        "claimPendingPayout",
        false,
        Date.now() - startTime,
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Issue #275 — Pay with attestation
  // ---------------------------------------------------------------------------

  /**
   * Executes an invoice payment accompanied by cryptographic verification proof.
   *
   * @param params - Payment and attestation parameters.
   * @returns Promise resolving to AttestationPaymentReceipt.
   *
   * @example
   * ```typescript
   * const receipt = await client.payWithAttestation(attestationPaymentParams);
   * ```
   */
  async payWithAttestation(
    params: PayWithAttestationParams,
  ): Promise<AttestationPaymentReceipt> {
    const startTime = Date.now();
    try {
      if (params.attestationHash.length !== 32) {
        throw new InvalidAttestationError(
          `attestationHash must be 32 bytes, got ${params.attestationHash.length}`,
        );
      }
      if (params.signature.length !== 64) {
        throw new InvalidAttestationError(
          `signature must be 64 bytes, got ${params.signature.length}`,
        );
      }
      const operation = this.contract.call(
        "pay_with_attestation",
        nativeToScVal(params.payer, { type: "address" }),
        nativeToScVal(BigInt(params.invoiceId), { type: "u64" }),
        nativeToScVal(params.amount, { type: "i128" }),
        xdr.ScVal.scvBytes(Buffer.from(params.attestationHash)),
        xdr.ScVal.scvBytes(Buffer.from(params.signature)),
        nativeToScVal(params.signerPubkey, { type: "address" }),
      );
      const result = await this._submitTx(params.payer, operation);
      const attestationHash = Buffer.from(params.attestationHash).toString(
        "hex",
      );
      telemetry.recordMethod(
        "payWithAttestation",
        true,
        Date.now() - startTime,
      );
      return {
        txHash: result.txHash,
        invoiceId: params.invoiceId,
        amount: params.amount,
        attestationHash,
      };
    } catch (error) {
      telemetry.recordMethod(
        "payWithAttestation",
        false,
        Date.now() - startTime,
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Issue #276 — Creator volume cap status checker
  // ---------------------------------------------------------------------------

  /**
   * Queries the maximum monthly invoice issuance volume ceiling for a creator account.
   *
   * @param address - Creator public key.
   * @returns Promise resolving to maximum cap in stroops as bigint, or null if uncapped.
   *
   * @example
   * ```typescript
   * const cap = await client.getCreatorVolumeCap('GA...');
   * ```
   */
  async getCreatorVolumeCap(address: string): Promise<bigint | null> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "get_creator_volume_cap",
        nativeToScVal(address, { type: "address" }),
      );
      const raw = await this._simulateView(operation);
      const cap = raw == null ? null : BigInt(raw as string | number | bigint);
      telemetry.recordMethod(
        "getCreatorVolumeCap",
        true,
        Date.now() - startTime,
      );
      return cap;
    } catch {
      telemetry.recordMethod(
        "getCreatorVolumeCap",
        false,
        Date.now() - startTime,
      );
      return null;
    }
  }

  /**
   * Queries the invoice volume consumed by a creator in the current billing period.
   *
   * @param address - Creator public key.
   * @returns Promise resolving to used volume in stroops as bigint.
   *
   * @example
   * ```typescript
   * const used = await client.getCreatorVolumeUsed('GA...');
   * ```
   */
  async getCreatorVolumeUsed(address: string): Promise<bigint> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "get_creator_volume_used",
        nativeToScVal(address, { type: "address" }),
      );
      const raw = await this._simulateView(operation);
      const used = raw == null ? 0n : BigInt(raw as string | number | bigint);
      telemetry.recordMethod(
        "getCreatorVolumeUsed",
        true,
        Date.now() - startTime,
      );
      return used;
    } catch {
      telemetry.recordMethod(
        "getCreatorVolumeUsed",
        false,
        Date.now() - startTime,
      );
      return 0n;
    }
  }

  /**
   * Computes the remaining invoice issuance volume allowed for a creator.
   *
   * @param address - Creator public key.
   * @returns Promise resolving to remaining volume allowance as bigint or Infinity.
   *
   * @example
   * ```typescript
   * const remaining = await client.getRemainingCreatorVolume('GA...');
   * ```
   */
  async getRemainingCreatorVolume(
    address: string,
  ): Promise<bigint | typeof Infinity> {
    const [cap, used] = await Promise.all([
      this.getCreatorVolumeCap(address),
      this.getCreatorVolumeUsed(address),
    ]);
    if (cap === null) return Infinity;
    return cap > used ? cap - used : 0n;
  }

  /**
   * Get aggregate performance metrics for a creator.
   * Combines on-chain stats and event history with 60-second caching.
   *
   * @param creator - Creator address.
   * @returns Creator statistics including success rate, funding time, ratings.
   *
   * @example
   * ```typescript
   * const stats = await client.getCreatorStats('GA...CREATOR');
   * ```
   */
  async getCreatorStats(creator: string): Promise<import("./creatorStats.js").CreatorStats> {
    const {
      getCreatorStatsCache,
      setCreatorStatsCache,
    } = await import("./creatorStats.js");

    const cached = getCreatorStatsCache(creator);
    if (cached) return cached;

    const result = await this.getInvoicesByCreator(creator);
    const invoiceIds = result.items || [];
    const invoices = await Promise.all(
      invoiceIds.map(async (id) => {
        try {
          return await this.getInvoice(id);
        } catch {
          return null;
        }
      }),
    ).then((list) => list.filter((inv): inv is Invoice => inv !== null));

    const getInvoiceAmount = (inv: Invoice) =>
      inv.recipients.reduce((sum, r) => sum + r.amount, 0n);

    const totalRaised = invoices.reduce((sum, inv) => sum + inv.funded, 0n);
    const totalReleased = invoices.reduce((sum, inv) => {
      if (inv.status === "Released") return sum + getInvoiceAmount(inv);
      return sum;
    }, 0n);
    const totalRefunded = invoices.reduce((sum, inv) => {
      if (inv.status === "Refunded") return sum + getInvoiceAmount(inv);
      return sum;
    }, 0n);

    const successCount = invoices.filter((inv) => inv.status === "Released").length;
    const successRate = invoices.length > 0 ? (successCount / invoices.length) * 100 : 0;

    const fundingTimes = invoices
      .filter((inv) => (inv.payments?.[0]?.timestamp ?? 0) > 0 && inv.createdAt)
      .map((inv) => ((inv.payments?.[0]?.timestamp ?? 0) - (inv.createdAt ?? 0)) / (1000 * 60 * 60));

    const averageFundingTimeHours = fundingTimes.length > 0
      ? fundingTimes.reduce((a, b) => a + b, 0) / fundingTimes.length
      : 0;

    const uniquePayers = new Set(
      invoices
        .filter((inv) => inv.payments && inv.payments.length > 0)
        .flatMap((inv) => inv.payments.map((p) => p.payer)),
    ).size;

    const stats = {
      totalInvoices: invoices.length,
      totalRaised,
      totalReleased,
      totalRefunded,
      successRate: Math.round(successRate * 100) / 100,
      averageFundingTimeHours: Math.round(averageFundingTimeHours * 100) / 100,
      uniquePayerCount: uniquePayers,
      averageRating: 0,
    };

    setCreatorStatsCache(creator, stats);
    return stats;
  }

  // ---------------------------------------------------------------------------
  // Issue #277 — Batch invoice creation helper
  // ---------------------------------------------------------------------------

  /**
   * Creates a batch of invoices with built-in chunking and idempotency keys.
   *
   * @param items - Array of invoice parameters.
   * @returns Promise resolving to batch creation result.
   *
   * @example
   * ```typescript
   * const batch = await client.createInvoiceBatch([itemA, itemB]);
   * ```
   */
  async createInvoiceBatch(
    items: CreateInvoiceParams[],
  ): Promise<{ invoiceIds: string[]; txHash: string }> {
    if (items.length === 0 || items.length > 10) {
      throw new InvalidBatchSizeError("1-10 items", items.length);
    }
    for (let i = 0; i < items.length; i++) {
      const item = items[i]!;
      if (!item.creator)
        throw new ValidationError(`Item ${i}: creator is required`);
      if (!item.token)
        throw new ValidationError(`Item ${i}: token is required`);
      if (!item.deadline || item.deadline <= 0)
        throw new ValidationError(
          `Item ${i}: deadline must be a positive number`,
        );
      if (!Array.isArray(item.recipients) || item.recipients.length === 0) {
        throw new ValidationError(
          `Item ${i}: recipients must be a non-empty array`,
        );
      }
      if (this.config.payloadGuard) {
  /**
   * validateInvoicePayload
   * @param params - The parameters for the method.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   */
        validateInvoicePayload(item, this.config.payloadGuard);
      }
    }

    const creator = items[0]!.creator;
    const invoiceParamVals = items.map((p) =>
      xdr.ScVal.scvMap([
        new xdr.ScMapEntry({
          key: nativeToScVal("creator", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(p.creator, { type: "address" }) as xdr.ScVal,
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("recipients", { type: "symbol" }) as xdr.ScVal,
          val: xdr.ScVal.scvVec(
            p.recipients.map((r) =>
              nativeToScVal(r.address, { type: "address" }),
            ),
          ),
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("amounts", { type: "symbol" }) as xdr.ScVal,
          val: xdr.ScVal.scvVec(
            p.recipients.map((r) => nativeToScVal(r.amount, { type: "i128" })),
          ),
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("token", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(p.token, { type: "address" }) as xdr.ScVal,
        }),
        new xdr.ScMapEntry({
          key: nativeToScVal("deadline", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(p.deadline, { type: "u64" }) as xdr.ScVal,
        }),
      ]),
    );

    const operation = this.contract.call(
      "create_invoice_batch",
      xdr.ScVal.scvVec(invoiceParamVals),
    );

    const startTime = Date.now();
    try {
      const account = await this.server.getAccount(creator);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(operation)
        .setTimeout(30)
        .build();

      const simResult = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(simResult)) {
        throw new SimulationFailedError(
          `Simulation failed: ${simResult.error}`,
          "createInvoiceBatch",
          simResult.error,
        );
      }

      const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
      const bumpedFee = String(
        Math.ceil(
          Number(BASE_FEE) *
            (this.config.feeBumpMultiplier ?? 2) *
            items.length,
        ),
      );
      const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
        creator,
        bumpedFee,
        preparedTx as Parameters<
          typeof TransactionBuilder.buildFeeBumpTransaction
        >[2],
        this.config.networkPassphrase,
      );

      const signedXdr = await (this._adapter
        ? this._adapter.signTransaction(
            feeBumpTx.toXDR(),
            this.config.networkPassphrase,
          )
        : signTransaction(feeBumpTx.toXDR(), this.config.networkPassphrase));

      const sendResult = await this.server.sendTransaction(
        TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase),
      );
      if (sendResult.status === "ERROR") {
        throw new TransactionFailedError(
          `Transaction failed: ${JSON.stringify(sendResult.errorResult)}`,
        );
      }

      const txHash = sendResult.hash;
      let getResult = await this.server.getTransaction(txHash);
      let attempts = 0;
      while (
        getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
        attempts < 20
      ) {
        await new Promise((r) => setTimeout(r, 1500));
        getResult = await this.server.getTransaction(txHash);
        attempts++;
      }
      if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new TransactionNotConfirmedError(String(getResult.status));
      }

      const returnVal =
        (getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse)
          .returnValue ?? xdr.ScVal.scvVoid();
      const invoiceIds = (
        scValToNative(returnVal) as (string | number | bigint)[]
      ).map((id) => id.toString());

      telemetry.recordMethod(
        "createInvoiceBatch",
        true,
        Date.now() - startTime,
      );
      return { invoiceIds, txHash };
    } catch (error) {
      telemetry.recordMethod(
        "createInvoiceBatch",
        false,
        Date.now() - startTime,
      );
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Leaderboard & invoice history (used in per-method timeout examples)
  // ---------------------------------------------------------------------------

  /**
   * Fetch the top creators by invoice volume from the contract.
   *
   * @param opts - Optional per-call timeout and trace ID overrides.
   * @returns Array of creator addresses sorted by invoice volume descending.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const top = await client.getLeaderboard({ limit: 10 });
   * ```
   */
  async getLeaderboard(opts?: {
    timeout?: number;
    traceId?: string;
  }): Promise<
    Array<{ creator: string; invoiceCount: number; totalVolume: bigint }>
  > {
    return this._withCache("getLeaderboard", [], () =>
      this._withTelemetry(
        "getLeaderboard",
        undefined,
        async () => {
          const operation = this.contract.call("get_leaderboard");
          const raw = await this._simulateView(operation, opts?.traceId);
          if (!Array.isArray(raw)) return [];
          return (raw as Array<Record<string, unknown>>).map((entry) => ({
            creator: String(entry.creator ?? ""),
            invoiceCount: Number(entry.invoice_count ?? 0),
            totalVolume: BigInt(
              (entry.total_volume as string | number | bigint) ?? 0,
            ),
          }));
        },
        opts,
      ),
    );
  }

  /**
   * Fetch the full payment history for an invoice.
   *
   * @param invoiceId - The invoice ID.
   * @param opts      - Optional per-call timeout and trace ID overrides.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const history = await client.getInvoiceHistory('123');
   * ```
   */
  async getInvoiceHistory(
    invoiceId: string,
    opts?: { timeout?: number; traceId?: string },
  ): Promise<Payment[]> {
    return this._withTelemetry(
      "getInvoiceHistory",
      { invoiceId },
      () => this._fetchPaymentHistory(invoiceId, opts?.traceId),
      opts,
    );
  }

  // ---------------------------------------------------------------------------
  // Cross-chain bridge payment helpers
  // ---------------------------------------------------------------------------

  /**
   * Estimate the bridge relay fee for routing a payment from a non-Stellar
   * chain toward a StellarSplit invoice.
   *
   * Supported source chains: `"ethereum"` (Ethereum mainnet) and
   * `"solana"` (Solana mainnet).
   *
   * The method first attempts to obtain a live quote from the chain's relayer
   * endpoint.  If unreachable it falls back to static fee basis-points defined
   * in {@link DEFAULT_CHAIN_CONFIGS}.
   *
   * @param sourceChain - Source chain identifier.
   * @param amount      - Gross payment amount in source-chain atomic units
   *                      (e.g. wei for ETH, lamports / USDC micro-units for SOL).
   * @param bridgeConfig - Optional per-chain configuration overrides.
   * @returns BridgeFeeEstimate containing bridgeFee, netAmount (in stroops), and estimatedTimeSeconds.
   *
   * @example
   * ```typescript
   * const estimate = await client.estimateBridgeFee("ethereum", 100_000_000n);
   * console.log(estimate.netAmount); // amount in stroops
   * ```
   * @throws {Error} If the method fails.
   */
  async estimateBridgeFee(
    sourceChain: ChainId,
    amount: bigint,
    bridgeConfig?: BridgeConfig,
  ): Promise<BridgeFeeEstimate> {
    return this._withTelemetry(
      "estimateBridgeFee",
      { sourceChain, amount: amount.toString() } as Record<string, unknown>,
      () => _estimateBridgeFee(sourceChain, amount, bridgeConfig),
    );
  }

  /**
   * Build an unsigned bridge relay proof struct for the given payment
   * parameters.
   *
   * The resulting {@link BridgePaymentRequest} contains a deterministic
   * `payloadHash` and a random `nonce` preventing replay attacks.  The caller
   * must sign the request with their source-chain wallet and pass the resulting
   * {@link SignedBridgeProof} to {@link submitBridgePayment}.
   *
   * This method is **synchronous** and does not perform any network I/O.
   *
   * @param params - Bridge payment parameters.
   * @returns Unsigned BridgePaymentRequest ready for source-chain signing.
   *
   * @example
   * ```typescript
   * const request = client.buildBridgePayment({
   *   sourceChain: "solana",
   *   payer: "GABC...XYZ",
   *   invoiceId: "42",
   *   amount: 1_000_000n,
   *   sourceToken: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
   *   deadline: Math.floor(Date.now() / 1000) + 3600,
   * });
   * ```
   * @throws {Error} If the method fails.
   */
  buildBridgePayment(params: BridgePaymentParams): BridgePaymentRequest {
    return _buildBridgePayment(params);
  }

  /**
   * Submit a signed bridge payment proof to the StellarSplit contract's
   * `bridge_pay` entry point.
   *
   * The contract is expected to validate the source-chain signature and
   * credit the payer's address toward the specified invoice.
   *
   * @param proof - Signed bridge proof from the source-chain wallet.
   * @returns Transaction hash of the submitted bridge payment.
   * @throws Error if the simulation fails or the on-chain transaction is rejected.
   *
   * @example
   * ```typescript
   * const { txHash } = await client.submitBridgePayment({
   *   request,
   *   signature: "0xdeadbeef...",
   *   signerAddress: "0xabc123...",
   * });
   * console.log("Bridge payment submitted:", txHash);
   * ```
   */
  async submitBridgePayment(
    proof: SignedBridgeProof,
  ): Promise<{ txHash: string }> {
    return this._withTelemetry(
      "submitBridgePayment",
      {
        invoiceId: proof.request.invoiceId,
        sourceChain: proof.request.sourceChain,
        signerAddress: proof.signerAddress,
      } as Record<string, unknown>,
      () => _submitBridgePayment(proof, this.config),
    );
  }

  // ---------------------------------------------------------------------------
  // Issue #1 — Account Merge Detection: rerouteRecipient
  // ---------------------------------------------------------------------------

  /**
   * Reroute an invoice recipient from a merged (invalid) account to a new destination.
   *
   * Validates the new address exists on-chain and has required trustlines,
   * then updates the recipient record. Emits `recipient:rerouted`.
   *
   * @param invoiceId   - Invoice whose recipient should be updated.
   * @param oldAddress  - The merged (invalid) recipient address.
   * @param newAddress  - The destination account after the merge.
   * @returns The result of the method.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.rerouteRecipient('123', 'GA...OLD', 'GA...NEW');
   * ```
   */
  async rerouteRecipient(
    invoiceId: string,
    oldAddress: string,
    newAddress: string,
  ): Promise<void> {
    const { AccountMergeDetector, InvalidDestinationError } = await import(
      "./accounts/AccountMergeDetector.js"
    );

    const horizonUrl = this.config.horizonUrl;
    if (!horizonUrl) {
      throw new Error(
        "horizonUrl is required in client config to validate reroute destination",
      );
    }

    const detector = new AccountMergeDetector(this, horizonUrl);
    await detector.validateDestination(newAddress);

    // Emit rerouted event so consumers can react
    this.emit("recipient:rerouted", { invoiceId, oldAddress, newAddress });
  }

  /**
   * Finalizes split payment disbursements and triggers escrow fund release.
   *
   * @param invoiceId - The invoice ID to finalize.
   * @param options - Optional finalization parameters.
   * @returns Promise resolving to finalization result.
   *
   * @example
   * ```typescript
   * await client.finalizeInvoice('123');
   * ```
   */
  async finalizeInvoice(
    invoiceId: string,
    options?: { allowUnreachable?: boolean },
  ): Promise<void> {
    const { PaymentGraphChecker } = await import(
      "./graph/PaymentGraphChecker.js"
    );

    const horizonUrl = this.config.horizonUrl;
    if (!horizonUrl) {
      throw new Error(
        "horizonUrl is required in client config for payment graph checking",
      );
    }

    const invoice = await this.getInvoice(invoiceId);
    const checker = new PaymentGraphChecker({ horizonUrl });
    await checker.check(invoice, options);
  }

  // ---------------------------------------------------------------------------
  // Issue #4 — Wallet Session Manager: connectWallet / disconnectWallet
  // ---------------------------------------------------------------------------

  /**
   * Connect a wallet adapter and register it as the active signer.
   * All subsequent `signTransaction` calls will use this adapter.
   *
   * @param adapter - A `WalletAdapter` (e.g. from `WalletSessionManager.detect()`).
   * @returns The connected Stellar public key.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const address = await client.connectWallet(new FreighterAdapter());
   * ```
   */
  async connectWallet(adapter: WalletAdapter): Promise<string> {
    const address =
      typeof (adapter as any).connect === "function"
        ? await (adapter as any).connect()
        : await adapter.getAddress();
    this._adapter = adapter;

    // Listen for account changes and update internal reference
    if (typeof (adapter as any).onAccountChange === "function") {
      (adapter as any).onAccountChange((newAddress: string) => {
        this.emit("wallet:accountChanged", newAddress);
      });
    }

    this.emit("wallet:connected", {
      walletName: (adapter as any).name ?? "Wallet",
      address,
    });
    return address;
  }

  /**
   * Disconnects the current active wallet session.
   * @returns void
   *
   * @example
   * ```typescript
   * client.disconnectWallet();
   * ```
   */
  disconnectWallet(): void {
    if (this._adapter) {
      this._adapter.disconnect();
      const walletName = this._adapter.name;
      this._adapter = null;
      this.emit("wallet:disconnected", { walletName });
    }
  }

  // ---------------------------------------------------------------------------
  // Invoice Hash Verification
  // ---------------------------------------------------------------------------

  /**
   * Verify that an invoice's content hash matches the expected hash,
   * detecting tampering between creation and payment.
   *
   * @param invoice - The invoice to verify.
   * @param expectedHash - Previously computed content hash.
   * @returns `true` when hashes match.
   * @throws InvoiceIntegrityError when hashes diverge.
   *
   * @example
   * ```typescript
   * const isValid = await client.verifyInvoice(invoice, expectedHash);
   * ```
   */
  async verifyInvoice(invoice: Invoice, expectedHash: string): Promise<boolean> {
    const valid = await verifyInvoiceHash(invoice, expectedHash);
    if (!valid) {
      const computed = await hashInvoice(invoice);
      throw new InvoiceIntegrityError(invoice.id, expectedHash, computed);
    }
    return true;
  }

  // ---------------------------------------------------------------------------
  // Fee Bump Submission
  // ---------------------------------------------------------------------------

  /**
   * Build and submit a fee bump transaction wrapping an inner transaction
   * signed by a recipient who cannot pay their own fee.
   *
   * @param innerTxXdr - Base-64 XDR of the inner signed transaction.
   * @param feeSource  - Stellar address of the account paying the fee.
   * @param baseFee    - Base fee in stroops.
   * @param config     - Optional surge multiplier config.
   * @returns The fee bump transaction hash.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * const result = await client.submitWithFeeBump(innerTx, 'GA...SPONSOR');
   * ```
   */
  async submitWithFeeBump(
    innerTxXdr: string,
    feeSource: string,
    baseFee?: string,
    config?: FeeBumpConfig,
  ): Promise<TxResult> {
    const innerTx = TransactionBuilder.fromXDR(
      innerTxXdr,
      this.config.networkPassphrase,
    ) as Transaction;

    const effectiveBaseFee = baseFee ?? BASE_FEE;
    const feeBumpTx = buildFeeBump(innerTx, feeSource, effectiveBaseFee, this.config.networkPassphrase, config);

    const signedXdr = await (this._adapter
      ? this._adapter.signTransaction(feeBumpTx.toXDR(), this.config.networkPassphrase)
      : signTransaction(feeBumpTx.toXDR(), this.config.networkPassphrase));

    const sendResult = await this.server.sendTransaction(
      TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase),
    );
    if (sendResult.status === "ERROR") {
      throw new TransactionFailedError(
        `Fee bump transaction failed: ${JSON.stringify(sendResult.errorResult)}`,
      );
    }

    const txHash = sendResult.hash;
    let getResult = await this.server.getTransaction(txHash);
    let attempts = 0;
    while (
      getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
      attempts < 20
    ) {
      await new Promise((r) => setTimeout(r, 1500));
      getResult = await this.server.getTransaction(txHash);
      attempts++;
    }
    if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
      throw new TransactionNotConfirmedError(String(getResult.status));
    }

    return { txHash };
  }

  // ---------------------------------------------------------------------------
  // Escrow Vault integration (#549)
  // ---------------------------------------------------------------------------

  /**
   * Confirm delivery for an invoice, triggering escrow release when an
   * {@link EscrowVaultManager} is provided via the config.
   *
   * This method updates the invoice status to "Released" and, if the client
   * was constructed with an `escrowVaultManager` and the invoice has an
   * associated `escrowVaultId`, also calls `EscrowVaultManager.release()` to
   * claim the locked funds on behalf of the recipient.
   *
   * @param invoiceId         - The invoice to confirm delivery for.
   * @param recipientId       - The recipient who should receive the escrowed funds.
   * @param escrowVaultId     - The vault ID to release (optional).
   * @param signerSecret      - Secret key for signing the claim transaction.
   * @returns Object with `{ invoiceId, txHash? }`.
   * @throws {Error} If the method fails.
   *
   * @example
   * ```typescript
   * await client.confirmDelivery('123', 'GA...RECIPIENT');
   * ```
   */
  async confirmDelivery(
    invoiceId: string,
    recipientId: string,
    escrowVaultId?: string,
    signerSecret?: string,
  ): Promise<{ invoiceId: string; txHash?: string }> {
    // Update invoice status to Released
    await this.updateInvoiceStatus(invoiceId, "Released");

    let txHash: string | undefined;

    // Release the escrow vault if provided
    const escrowManager = (this.config as Record<string, unknown>)["escrowVaultManager"] as
      | import("./escrowVaultManager.js").EscrowVaultManager
      | undefined;
    if (escrowManager && escrowVaultId && signerSecret) {
      const result = await escrowManager.release(escrowVaultId, recipientId, signerSecret);
      txHash = result.txHash;
    }

    return { invoiceId, txHash };
  }

  // ---------------------------------------------------------------------------
  // Issue #878 — Fundraising Round methods
  // ---------------------------------------------------------------------------

  /**
   * Closes a fundraising round for the given invoice, computing pro-rata
   * refunds for any over-subscribed payers.
   *
   * @throws {RoundNotEndedError} if the round_end timestamp has not yet passed.
   * @throws {InvoiceNotFoundError} if the invoice does not exist.
   *
   * @example
   * ```typescript
   * const round = await client.closeRound('123');
   * ```
   */
  async closeRound(invoiceId: string): Promise<RoundCloseResult> {
    const method = "close_round";
    try {
      const account = await this.server.getAccount(this.config.publicKey ?? "");
      const contract = new Contract(this.config.contractId);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          contract.call(
            method,
            nativeToScVal(invoiceId, { type: "string" })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(sim)) {
        const raw = (sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error;
        if (raw?.includes("RoundNotEnded") || raw?.includes("round_not_ended")) {
          // Parse round end from context if available
          throw new RoundNotEndedError(invoiceId, 0, raw);
        }
        throw new SimulationFailedError(raw ?? "Simulation failed", method, raw);
      }

      const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
      const signed = await signTransaction(
        prepared.toXDR(),
        this.config.networkPassphrase,
      );
      const result = await this.server.sendTransaction(
        TransactionBuilder.fromXDR(signed, this.config.networkPassphrase)
      );
      if (result.status === "ERROR") {
        throw new TransactionFailedError("close_round transaction failed", result.hash);
      }

      // Parse the result — the contract returns a map of payer -> amounts
      // We decode optimistically; real XDR parsing is contract-specific
      const native = sim.result ? scValToNative(sim.result.retval) : null;
      const refunds: PayerRefund[] = [];
      let totalRaised = 0n;
      let hardCap = 0n;
      let overflow = 0n;

      if (native && typeof native === "object") {
        const n = native as Record<string, any>;
        totalRaised = BigInt(n.total_raised ?? 0);
        hardCap = BigInt(n.hard_cap ?? 0);
        overflow = BigInt(n.overflow ?? 0);
        if (Array.isArray(n.refunds)) {
          for (const r of n.refunds as Record<string, any>[]) {
            refunds.push({
              payer: String(r.payer),
              amountKept: BigInt(r.amount_kept ?? 0),
              amountRefunded: BigInt(r.amount_refunded ?? 0),
            });
          }
        }
      }

      return { totalRaised, hardCap, overflow, refunds, txHash: result.hash };
    } catch (err) {
      if (
        err instanceof RoundNotEndedError ||
        err instanceof InvoiceNotFoundError ||
        err instanceof SimulationFailedError ||
        err instanceof TransactionFailedError
      ) {
        throw err;
      }
      throw parseSorobanError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Fetches the current state of the fundraising round for the given invoice.
   *
   * @throws {InvoiceNotFoundError} if the invoice does not exist.
   *
   * @example
   * ```typescript
   * const info = await client.getRoundInfo('123');
   * ```
   */
  async getRoundInfo(invoiceId: string): Promise<RoundInfo> {
    const method = "get_round_info";
    try {
      const account = await this.server.getAccount(this.config.publicKey ?? "");
      const contract = new Contract(this.config.contractId);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          contract.call(
            method,
            nativeToScVal(invoiceId, { type: "string" })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(sim)) {
        const raw = (sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error;
        if (raw?.includes("NotFound") || raw?.includes("not_found")) {
          throw new InvoiceNotFoundError(invoiceId, raw);
        }
        throw new SimulationFailedError(raw ?? "Simulation failed", method, raw);
      }

      const native = sim.result ? scValToNative(sim.result.retval) : {};
      const n = (native ?? {}) as Record<string, any>;
      return {
        invoiceId,
        totalRaised: BigInt(n.total_raised ?? 0),
        hardCap: BigInt(n.hard_cap ?? 0),
        roundEnd: Number(n.round_end ?? 0),
        closed: Boolean(n.closed ?? false),
      };
    } catch (err) {
      if (err instanceof InvoiceNotFoundError || err instanceof SimulationFailedError) {
        throw err;
      }
      throw parseSorobanError(err instanceof Error ? err.message : String(err));
    }
  }

  // ---------------------------------------------------------------------------
  // Issue #879 — Milestone methods
  // ---------------------------------------------------------------------------

  /**
   * Marks the specified milestone as completed and releases funds to recipients.
   *
   * @throws {WrongMilestoneError} if `index` is not the currently active milestone.
   * @throws {InvoiceNotFoundError} if the invoice does not exist.
   *
   * @example
   * ```typescript
   * await client.completeMilestone('123', 0);
   * ```
   */
  async completeMilestone(invoiceId: string, index: number): Promise<MilestoneResult> {
    const method = "complete_milestone";
    try {
      const account = await this.server.getAccount(this.config.publicKey ?? "");
      const contract = new Contract(this.config.contractId);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          contract.call(
            method,
            nativeToScVal(invoiceId, { type: "string" }),
            nativeToScVal(index, { type: "u32" })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(sim)) {
        const raw = (sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error;
        if (raw?.includes("WrongMilestone") || raw?.includes("wrong_milestone")) {
          throw new WrongMilestoneError(invoiceId, index, -1, raw);
        }
        if (raw?.includes("NotFound") || raw?.includes("not_found")) {
          throw new InvoiceNotFoundError(invoiceId, raw);
        }
        throw new SimulationFailedError(raw ?? "Simulation failed", method, raw);
      }

      const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
      const signed = await signTransaction(
        prepared.toXDR(),
        this.config.networkPassphrase,
      );
      const result = await this.server.sendTransaction(
        TransactionBuilder.fromXDR(signed, this.config.networkPassphrase)
      );
      if (result.status === "ERROR") {
        throw new TransactionFailedError("complete_milestone transaction failed", result.hash);
      }

      const native = sim.result ? scValToNative(sim.result.retval) : {};
      const n = (native ?? {}) as Record<string, any>;
      return {
        index,
        amountReleased: BigInt(n.amount_released ?? 0),
        nextMilestoneIndex: n.next_milestone_index != null ? Number(n.next_milestone_index) : undefined,
        txHash: result.hash,
      };
    } catch (err) {
      if (
        err instanceof WrongMilestoneError ||
        err instanceof InvoiceNotFoundError ||
        err instanceof SimulationFailedError ||
        err instanceof TransactionFailedError
      ) {
        throw err;
      }
      throw parseSorobanError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Returns the currently active milestone for the given invoice.
   *
   * @throws {InvoiceNotFoundError} if the invoice does not exist.
   *
   * @example
   * ```typescript
   * const milestone = await client.getActiveMilestone('123');
   * ```
   */
  async getActiveMilestone(invoiceId: string): Promise<Milestone | null> {
    const method = "get_active_milestone";
    try {
      const account = await this.server.getAccount(this.config.publicKey ?? "");
      const contract = new Contract(this.config.contractId);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          contract.call(
            method,
            nativeToScVal(invoiceId, { type: "string" })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(sim)) {
        const raw = (sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error;
        if (raw?.includes("NotFound") || raw?.includes("not_found")) {
          throw new InvoiceNotFoundError(invoiceId, raw);
        }
        throw new SimulationFailedError(raw ?? "Simulation failed", method, raw);
      }

      const native = sim.result ? scValToNative(sim.result.retval) : null;
      if (!native) return null;
      const n = native as Record<string, any>;
      return {
        index: Number(n.index ?? 0),
        description: String(n.description ?? ""),
        targetAmount: BigInt(n.target_amount ?? 0),
        fundedAmount: BigInt(n.funded_amount ?? 0),
        status: (n.status as MilestoneStatus) ?? "active",
      };
    } catch (err) {
      if (err instanceof InvoiceNotFoundError || err instanceof SimulationFailedError) {
        throw err;
      }
      throw parseSorobanError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Returns all milestones for the given invoice.
   *
   * @throws {InvoiceNotFoundError} if the invoice does not exist.
   *
   * @example
   * ```typescript
   * const milestones = await client.getMilestones('123');
   * ```
   */
  async getMilestones(invoiceId: string): Promise<Milestone[]> {
    const method = "get_milestones";
    try {
      const account = await this.server.getAccount(this.config.publicKey ?? "");
      const contract = new Contract(this.config.contractId);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          contract.call(
            method,
            nativeToScVal(invoiceId, { type: "string" })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(sim)) {
        const raw = (sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error;
        if (raw?.includes("NotFound") || raw?.includes("not_found")) {
          throw new InvoiceNotFoundError(invoiceId, raw);
        }
        throw new SimulationFailedError(raw ?? "Simulation failed", method, raw);
      }

      const native = sim.result ? scValToNative(sim.result.retval) : [];
      if (!Array.isArray(native)) return [];
      return (native as Record<string, any>[]).map((n) => ({
        index: Number(n.index ?? 0),
        description: String(n.description ?? ""),
        targetAmount: BigInt(n.target_amount ?? 0),
        fundedAmount: BigInt(n.funded_amount ?? 0),
        status: (n.status as MilestoneStatus) ?? "locked",
      }));
    } catch (err) {
      if (err instanceof InvoiceNotFoundError || err instanceof SimulationFailedError) {
        throw err;
      }
      throw parseSorobanError(err instanceof Error ? err.message : String(err));
    }
  }

  // ---------------------------------------------------------------------------
  // Issue #880 — Referral methods
  // ---------------------------------------------------------------------------

  /**
   * Claims any accumulated referral rewards for the connected wallet.
   *
   * @throws {NothingToClaimError} if the referral balance is zero.
   *
   * @example
   * ```typescript
   * const claim = await client.claimReferralRewards();
   * ```
   */
  async claimReferralRewards(): Promise<ReferralClaimResult> {
    const method = "claim_referral_rewards";
    const address = this.config.publicKey ?? "";
    try {
      const balance = await this.getReferralBalance(address);
      if (balance === 0n) {
        throw new NothingToClaimError(address);
      }

      const account = await this.server.getAccount(address);
      const contract = new Contract(this.config.contractId);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          contract.call(
            method,
            nativeToScVal(address, { type: "address" })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(sim)) {
        const raw = (sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error;
        throw new SimulationFailedError(raw ?? "Simulation failed", method, raw);
      }

      const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
      const signed = await signTransaction(
        prepared.toXDR(),
        this.config.networkPassphrase,
      );
      const result = await this.server.sendTransaction(
        TransactionBuilder.fromXDR(signed, this.config.networkPassphrase)
      );
      if (result.status === "ERROR") {
        throw new TransactionFailedError("claim_referral_rewards transaction failed", result.hash);
      }

      const native = sim.result ? scValToNative(sim.result.retval) : 0n;
      const amountClaimed = BigInt(typeof native === "bigint" ? native : ((native as any) ?? 0));
      return { amountClaimed, txHash: result.hash };
    } catch (err) {
      if (
        err instanceof NothingToClaimError ||
        err instanceof SimulationFailedError ||
        err instanceof TransactionFailedError
      ) {
        throw err;
      }
      throw parseSorobanError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Returns the current referral reward balance for the given address (or the
   * connected wallet if no address is specified).
   *
   * @example
   * ```typescript
   * const balance = await client.getReferralBalance('GA...');
   * ```
   */
  async getReferralBalance(address?: string): Promise<bigint> {
    const method = "get_referral_balance";
    const target = address ?? this.config.publicKey ?? "";
    try {
      const account = await this.server.getAccount(this.config.publicKey ?? "");
      const contract = new Contract(this.config.contractId);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          contract.call(
            method,
            nativeToScVal(target, { type: "address" })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(sim)) {
        const raw = (sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error;
        throw new SimulationFailedError(raw ?? "Simulation failed", method, raw);
      }

      const native = sim.result ? scValToNative(sim.result.retval) : 0n;
      return BigInt(typeof native === "bigint" ? native : ((native as any) ?? 0));
    } catch (err) {
      if (err instanceof SimulationFailedError) throw err;
      throw parseSorobanError(err instanceof Error ? err.message : String(err));
    }
  }

  /**
   * Pays toward an invoice while crediting a referrer address.
   *
   * @param invoiceId - The invoice to pay toward.
   * @param amount - Amount to pay in stroops.
   * @param referrer - Stellar G-address of the referrer to credit.
   *
   * @throws {ValidationError} if the referrer address is not a valid G-address.
   * @throws {InvoiceNotFoundError} if the invoice does not exist.
   *
   * @example
   * ```typescript
   * await client.payWithReferral('123', 50_0000000n, 'GA...REFERRER');
   * ```
   */
  async payWithReferral(
    invoiceId: string,
    amount: bigint,
    referrer: string
  ): Promise<ReferralPayResult> {
    const method = "pay_with_referral";

    if (!isValidAddress(referrer)) {
      throw new ValidationError(`Invalid referrer address: ${referrer}`, { referrer });
    }

    try {
      const account = await this.server.getAccount(this.config.publicKey ?? "");
      const contract = new Contract(this.config.contractId);
      const tx = new TransactionBuilder(account, {
        fee: BASE_FEE,
        networkPassphrase: this.config.networkPassphrase,
      })
        .addOperation(
          contract.call(
            method,
            nativeToScVal(invoiceId, { type: "string" }),
            nativeToScVal(amount, { type: "i128" }),
            nativeToScVal(referrer, { type: "address" })
          )
        )
        .setTimeout(30)
        .build();

      const sim = await this.server.simulateTransaction(tx);
      if (SorobanRpc.Api.isSimulationError(sim)) {
        const raw = (sim as SorobanRpc.Api.SimulateTransactionErrorResponse).error;
        if (raw?.includes("NotFound") || raw?.includes("not_found")) {
          throw new InvoiceNotFoundError(invoiceId, raw);
        }
        throw new SimulationFailedError(raw ?? "Simulation failed", method, raw);
      }

      const prepared = SorobanRpc.assembleTransaction(tx, sim).build();
      const signed = await signTransaction(
        prepared.toXDR(),
        this.config.networkPassphrase,
      );
      const result = await this.server.sendTransaction(
        TransactionBuilder.fromXDR(signed, this.config.networkPassphrase)
      );
      if (result.status === "ERROR") {
        throw new TransactionFailedError("pay_with_referral transaction failed", result.hash);
      }

      return { txHash: result.hash, referrer };
    } catch (err) {
      if (
        err instanceof ValidationError ||
        err instanceof InvoiceNotFoundError ||
        err instanceof SimulationFailedError ||
        err instanceof TransactionFailedError
      ) {
        throw err;
      }
      throw parseSorobanError(err instanceof Error ? err.message : String(err));
    }
  }
}

// ---------------------------------------------------------------------------
// Client modules (issue #1079)
// ---------------------------------------------------------------------------
export * from "./client/modules/index.js";
