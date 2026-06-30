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
} from "@stellar/stellar-sdk";
import { signTransaction } from "./wallet.js";
import { telemetry } from "./telemetry.js";
import { exportInvoice } from "./export.js";
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
import { resolveToken } from "./token.js";
import { generatePaymentProof } from "./proof.js";
import { compilePaymentReceipt } from "./receipt.js";
import type { PaymentReceipt } from "./receipt.js";
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
} from "./types.js";
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
  SignerFailedError,
  NoSignerProvidedError,
  ValidationError,
  StellarSplitError,
} from "./errors.js";
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
import { validateInvoicePayload } from "./payloadGuard.js";
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
import { TimeoutManager, withTimeout } from "./timeout.js";
import type { TimeoutConfig } from "./timeout.js";
import { RequestTimeoutError } from "./errors.js";
import { TraceIdManager } from "./traceId.js";
import type { RpcClient } from "./rpcClient.js";

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
  /** Optional compliance rules injectable for invoice checks. */
  complianceRules?: import("./compliance.js").ComplianceRule[];
  /** Optional dependency injection container for RPC, cache, and wallet implementations. */
  container?: DIContainer;
  /** Optional request/response compression middleware. Disabled by default. */
  compression?: CompressionConfig;
  /** Optional invoice lifecycle hooks. */
  hooks?: InvoiceLifecycleHooks;
  /** Optional retry configuration. Enables automatic retry with exponential backoff and jitter. */
  retry?: RetryOptions;
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

/** Shared countdown computation used by client method and standalone function. */
function _computeCountdown(target: number): ScheduledReleaseCountdown {
  const now = Math.floor(Date.now() / 1000);
  const diff = target - now;
  if (diff <= 0) {
    return {
      total_seconds: 0,
      days: 0,
      hours: 0,
      minutes: 0,
      seconds: 0,
      overdue: true,
    };
  }
  return {
    total_seconds: diff,
    days: Math.floor(diff / 86400),
    hours: Math.floor((diff % 86400) / 3600),
    minutes: Math.floor((diff % 3600) / 60),
    seconds: diff % 60,
    overdue: false,
  };
}

/**
 * Standalone pure function — computes time remaining until a scheduled release.
 * Returns null when the invoice has no scheduled_release_at field.
 *
 * @param invoice - Invoice object from the contract.
 * @returns ScheduledReleaseCountdown or null.
 */
export function getScheduledReleaseCountdown(
  invoice: Invoice,
): ScheduledReleaseCountdown | null {
  const ts =
    (invoice as { scheduled_release_at?: number }).scheduled_release_at ??
    invoice.scheduledReleaseDate;
  if (ts === undefined) return null;
  return _computeCountdown(ts);
}

/**
 * Standalone pure function — verifies a CompletionProof from the contract.
 * Recomputes cert_hash from proof fields and compares against stored value.
 *
 * @param proof - CompletionProof from the contract's get_completion_proof call.
 * @returns { valid: boolean, reason?: string }
 */
export function verifyCompletionProof(proof: CompletionProof): {
  valid: boolean;
  reason?: string;
} {
  if (
    !proof.invoiceId ||
    !proof.releasedBy ||
    !proof.releasedAt ||
    !proof.cert_hash
  ) {
    return { valid: false, reason: "Missing required proof fields" };
  }
  const data = `${proof.invoiceId}${proof.releasedBy}${proof.releasedAt}${proof.totalAmount.toString()}`;
  const encoder = new TextEncoder();
  const buffer = encoder.encode(data);
  let hash = 0;
  for (let i = 0; i < buffer.length; i++) {
    hash = (hash << 5) - hash + (buffer[i] ?? 0);
    hash = hash & hash;
  }
  const computed = Math.abs(hash).toString(16).padStart(64, "0").slice(0, 64);
  if (computed !== proof.cert_hash) {
    return { valid: false, reason: "cert_hash mismatch" };
  }
  return { valid: true };
}

export class StellarSplitClient {
  private _mainServer!: SorobanRpc.Server;
  private _standby: WarmStandby | null = null;
  private _queue = new PriorityQueue();
  private contract: Contract;
  private config: StellarSplitClientConfig;
  private _plugins = new Set<string>();
  private _pluginInstances: StellarSplitPlugin[] = [];
  private _pluginRegistry = new PluginRegistry();
  private _dedup = new Deduplicator<Invoice>();
  private _cache: SimpleCache<Invoice> | ICacheStore<Invoice> | null = null;
  private _auditLogger: AuditLogger | null = null;
  private _degradation: DegradationManager | null = null;
  private _rateLimiter: RateLimiter | null = null;
  private _rpcClient: IRPCClient | null = null;
  private _adapter: WalletAdapter | null = null;
  private _hooks: InvoiceLifecycleHooks = {};
  private _retryOptions: RetryOptions | null = null;
  private _horizonReader: HorizonFallbackReader | null = null;
  private _idempotency: IdempotencyManager | null = null;
  private _pool: ConnectionPool | null = null;
  /**
   * Effective pool size chosen at construction (or 0 when pooling is off).
   * Cached separately from `config` because {@link NetworkConfig} (used by
   * `switchNetwork`) does not carry `rpcPoolSize`, so reading from
   * `this.config.rpcPoolSize` after a switch would silently disable pooling.
   */
  private _effectiveRpcPoolSize = 0;
  private _batcher: BatchedRpcClient | null = null;
  private _telemetryHookManager = new TelemetryHookManager();
  private _timeoutManager: TimeoutManager | null = null;
  private _traceIdManager = new TraceIdManager();
  private _injectedRpcClient: RpcClient | null = null;
  private _wsTransport: WebSocketTransport | null = null;
  private _transportType: TransportType = 'http';
  private _activeTransportType: TransportType = 'http';
  private _fallbackListeners: Array<(event: { from: 'websocket'; to: 'http' }) => void> = [];

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private get server(): any {
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
    validateOrThrow(config);
    this.config = config;
    const primaryUrl = Array.isArray(config.rpcUrl)
      ? config.rpcUrl[0]!
      : config.rpcUrl;

    // Injectable RpcClient (Issue #3): config.rpcClient takes priority over DI container.
    this._injectedRpcClient = config.rpcClient ?? null;
    this._rpcClient = config.container?.getRPCClient() ?? null;
    this._adapter =
      config.container?.getWalletAdapter() ?? config.adapter ?? null;

    // Per-method timeout manager (Issue #1)
    if (config.timeout !== undefined) {
      this._timeoutManager = new TimeoutManager(config.timeout);
    }
    this._mainServer = new SorobanRpc.Server(primaryUrl, {
      allowHttp: primaryUrl.startsWith("http://"),
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

    this._cache =
      config.container?.getCacheStore() ??
      (config.cache ? new SimpleCache<Invoice>(config.cache) : null);

    if (config.telemetry) {
      telemetry.init(config.telemetry);
    }

    if (config.signingKeypair) {
      addRequestInterceptor(
        createRequestSigningInterceptor(config.signingKeypair),
      );
    }

    if (config.compression?.enabled) {
      addRequestInterceptor(
        createCompressionRequestInterceptor(config.compression),
      );
      addResponseInterceptor(
        createCompressionResponseInterceptor(config.compression),
      );
    }

    if (config.cache && !config.container?.getCacheStore()) {
      this._cache = new SimpleCache<Invoice>(config.cache);
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
  }

  /**
   * Performs a health check of the client's RPC connection and contract.
   * Resolves with status information or throws HealthCheckTimeoutError if taking > 5000ms.
   */
  async healthCheck(): Promise<HealthCheckResult> {
    const start = Date.now();
    try {
      return await Promise.race([
        this._doHealthCheck(start),
        new Promise<never>((_, reject) =>
          setTimeout(
            () =>
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
   */
  public invalidateCache(method?: string, args?: any[]): void {
    if (this._cache) {
      if (typeof (this._cache as any).invalidate === "function") {
        (this._cache as any).invalidate(method, args);
      }
    }
  }

  /**
   * Get cache statistics.
   * @returns Cache stats including hits, misses, size, and keys.
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
      return withTimeout(() => run(), timeoutMs, method);
    }
    return run();
  }

  // ---------------------------------------------------------------------------
  // Plugin system
  // ---------------------------------------------------------------------------

  /**
   * Register a plugin that extends this client instance.
   * Throws if a plugin with the same name has already been registered.
   */
  registerPlugin(plugin: StellarSplitPlugin): void {
    if (this._plugins.has(plugin.name)) {
      throw new PluginAlreadyRegisteredError(plugin.name);
    }
    this._plugins.add(plugin.name);
    this._pluginInstances.push(plugin);
    plugin.install?.(this);
  }

  /** Register a middleware plugin (interceptor-style). */
  use(plugin: SdkPlugin): void {
    this._pluginRegistry.use(plugin);
  }

  /** Deregister a middleware plugin by name. */
  removePlugin(name: string): void {
    this._pluginRegistry.removePlugin(name);
  }

  /** Return the names of all active middleware plugins. */
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
   */
  setTelemetryHooks(hooks: TelemetryHooks): void {
    this._telemetryHookManager.setHooks(hooks);
  }

  /**
   * Remove all registered telemetry hooks.
   */
  clearTelemetryHooks(): void {
    this._telemetryHookManager.clearHooks();
  }

  // ---------------------------------------------------------------------------
  // Timeout config (Issue #1)
  // ---------------------------------------------------------------------------

  /**
   * Returns the resolved timeout (in ms) for each known SDK method.
   * Reflects both the `default` timeout and any per-method overrides.
   * Returns an empty object when no `timeout` option was set at construction.
   */
  getTimeoutConfig(): Record<string, number> {
    return this._timeoutManager?.getTimeoutConfig() ?? {};
  }

  // ---------------------------------------------------------------------------
  // Trace ID (Issue #2)
  // ---------------------------------------------------------------------------

  /**
   * Replace the default UUID v4 generator with a custom function.
   * Useful for integrating OpenTelemetry span IDs or other systems.
   *
   * @example
   * sdk.setDefaultTraceIdGenerator(() => opentelemetry.trace.getActiveSpan()?.spanContext().traceId ?? crypto.randomUUID());
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

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Create a new on-chain invoice.
   *
   * @returns The new invoice ID and the transaction hash.
   */
  async createInvoice(
    params: CreateInvoiceParams,
  ): Promise<{ invoiceId: string; txHash: string }> {
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
            validateInvoicePayload(params, this.config.payloadGuard);
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
   */
  async cloneInvoice(
    sourceId: string,
    overrides: CloneOverrides = {},
  ): Promise<string> {
    const startTime = Date.now();
    const sourceInvoice = await this.getInvoice(sourceId);

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
          typeof (sourceInvoice as unknown as Record<string, unknown>)
            .cloneDepth === "number"
            ? ((sourceInvoice as unknown as Record<string, unknown>)
                .cloneDepth as number) + 1
            : 1;

        const optimisticInvoice: Invoice = {
          ...sourceInvoice,
          id,
          clonedFrom: sourceId,
          parentInvoiceId: sourceId,
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
        throw new InvoiceNotFoundError(sourceId);
      }
      throw error;
    }
  }

  /**
   * Pay toward an invoice.
   *
   * @returns The transaction hash.
   */
  async pay(params: PayParams): Promise<TxResult> {
    const startTime = Date.now();
    params = this._pluginRegistry.runBeforeCall("pay", params);
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
      telemetry.recordMethod("pay", true, Date.now() - startTime);
      return this._pluginRegistry.runAfterCall("pay", {
        txHash: result.txHash,
      });
    } catch (error) {
      telemetry.recordMethod("pay", false, Date.now() - startTime);
      this._pluginRegistry.runOnError("pay", error);
      throw error;
    }
  }

  /**
   * Create multiple invoices in a single transaction.
   *
   * @param params - Array of invoice creation parameters (1-5 items)
   * @returns All created invoice IDs and the transaction hash
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
    const isSimpleCache =
      this._cache && typeof (this._cache as any).getStats === "function";

    if (isSimpleCache) {
      const key = `${methodName}:${JSON.stringify(args)}`;
      const cached = (this._cache as any).get(key) as T | undefined;
      if (cached) return cached;
    } else if (this._cache && methodName === "getInvoice") {
      const cached = this._cache.get(args[0]) as T | undefined;
      if (cached) return cached;
    }

    const result = await fetcher();

    if (isSimpleCache) {
      const key = `${methodName}:${JSON.stringify(args)}`;
      (this._cache as any).set(key, result);
    } else if (this._cache && methodName === "getInvoice") {
      this._cache.set(args[0], result as any);
    }

    return result;
  }

  /**
   * Fetch an invoice by ID. Returns cached result if within TTL.
   */
  async getInvoice(
    invoiceId: string,
    opts?: { retry?: PerMethodRetryOptions; dedupe?: boolean; traceId?: string; timeout?: number }
  ): Promise<Invoice> {
    return this._withCache("getInvoice", [invoiceId], async () => {
      const fetcher = this._batcher
        ? () => this._batcher!.getInvoice(invoiceId)
        : () => this._fetchInvoice(invoiceId, opts?.traceId);

      const useDedupe = opts?.dedupe !== false;
      const effectiveRetry =
        opts?.retry ?? (this._retryOptions ? {} : undefined);
      if (this._retryOptions && effectiveRetry !== undefined) {
        return await executeWithRetry(
          () =>
            useDedupe ? this._dedup.dedupe(invoiceId, fetcher) : fetcher(),
          this._retryOptions,
          opts?.retry,
        );
      }
      return useDedupe ? this._dedup.dedupe(invoiceId, fetcher) : fetcher();
    });
  }

  /**
   * Returns deduplication statistics for observability.
   * @returns { deduped: number, total: number } — deduped is how many calls were short-circuited.
   */
  getDedupStats(): { deduped: number; total: number } {
    return this._dedup.getDedupStats();
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
      recordCall(false);
      throw error;
    }
  }

  /**
   * Check invoice compliance against built-in and configured rules.
   * @param invoiceId - Invoice ID to validate
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
   * Fetch all payments for an invoice.
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
   */
  verifyCompletionProof(proof: CompletionProof): {
    valid: boolean;
    reason?: string;
  } {
    return verifyCompletionProof(proof);
  }

  /**
   * Reconcile an invoice's reported funded amount with its payment records and historical payment events.
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
   * Generate a typed receipt for a released invoice.
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

  /** Clears the NFT gate status cache (useful for testing). */
  clearNftGateCache(): void {
    this._nftGateCache.clear();
  }

  /**
   * Resolves the forward chain for an invoice.
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
   * Gracefully shutdown the SDK client, flush pending operations, and close internal resources.
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
        typeof (this._rpcClient as any).close === "function"
      ) {
        await (this._rpcClient as any).close();
      }

      telemetry.destroy();
    }
  }

  /**
   * Cancel multiple invoices in parallel without aborting on individual failures.
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
   * Archive multiple invoices in parallel without aborting on individual failures.
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
   * Export multiple invoices in parallel and return formatted results by invoice ID.
   */
  async bulkExport(
    ids: string[],
    format: ExportFormat,
  ): Promise<Record<string, string>> {
    const settled = await Promise.allSettled(
      ids.map(async (invoiceId) => {
        const invoice = await this.getInvoice(invoiceId);
        return { invoiceId, data: exportInvoice(invoice, format) };
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
   * Save an invoice template for reuse.
   *
   * @returns The transaction hash.
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
   * Create an invoice from a saved template.
   *
   * @returns The new invoice ID and the transaction hash.
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
   * List all template names for a creator.
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
   * Get all recurring invoices for a creator.
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
   * Cancel a recurring invoice.
   *
   * @returns The transaction hash.
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
   * Update amounts for a recurring invoice.
   *
   * @returns The transaction hash.
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
   * Check the health of the RPC endpoint.
   */
  async checkRPCHealth(): Promise<RPCHealth> {
    return checkRPCHealth(this.server);
  }

  /**
   * Create a group of linked invoices.
   *
   * @returns The new group ID and transaction hash.
   */
  async createGroup(
    creator: string,
    invoiceIds: string[],
  ): Promise<{ groupId: string; txHash: string }> {
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
  }

  /**
   * Get the status of an invoice group.
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
   * Release all invoices in a group.
   *
   * @returns The transaction hash.
   */
  async releaseGroup(creator: string, groupId: string): Promise<TxResult> {
    const operation = this.contract.call(
      "release_invoice_group",
      nativeToScVal(creator, { type: "address" }),
      nativeToScVal(BigInt(groupId), { type: "u64" }),
    );

    const result = await this._submitTx(creator, operation);
    return { txHash: result.txHash };
  }

  /**
   * Calculate the protocol fee for a given amount.
   *
   * @param amount - Gross amount in stroops
   * @returns Fee breakdown with gross, fee, net, and feeBps
   */
  async calculateFee(amount: bigint): Promise<FeeBreakdown> {
    return calculateFee(amount, this.config);
  }

  /**
   * Resolve token metadata from a SAC contract address.
   *
   * @param address - Token contract address
   * @returns Token metadata (symbol, name, decimals)
   */
  async resolveToken(address: string): Promise<TokenInfo> {
    return resolveToken(address, this.config);
  }

  /**
   * Generate a cryptographic proof of payment.
   *
   * @param txHash - Transaction hash
   * @returns Payment proof with deterministic SHA-256 hash
   */
  async generatePaymentProof(txHash: string): Promise<PaymentProof> {
    return generatePaymentProof(txHash, this.config);
  }

  /**
   * Generate a payment receipt for an invoice and payer address.
   * Compiles on-chain invoice details, total paid, timestamps, and a SHA-256 proof hash.
   * Works for both completed and in-progress invoices.
   *
   * @param invoiceId - The ID of the invoice.
   * @param payerAddress - The Stellar address of the payer.
   * @returns Payment receipt with proofHash and optional JSON serialization.
   */
  async generatePaymentReceipt(
    invoiceId: string,
    payerAddress: string,
  ): Promise<PaymentReceipt> {
    const invoice = await this.getInvoice(invoiceId);
    return compilePaymentReceipt(invoice, payerAddress);
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

    return computePaymentValidation(invoice, amount, balance);
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
   */
  subscribeToInvoice(
    invoiceId: string,
    callbacks: InvoiceEventCallbacks,
    intervalMs?: number,
  ): () => void;
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
   * Returns the current status of the active transport.
   *
   * When `transport: 'websocket'` was configured, returns `{ type: 'websocket', connected, reconnectAttempts }`.
   * Otherwise returns `{ type: 'http', connected: true, reconnectAttempts: 0 }`.
   */
  getTransportStatus(): TransportStatus {
    if (this._wsTransport) {
      return this._wsTransport.getStatus();
    }
    return { type: 'http', connected: true, reconnectAttempts: 0 };
  }

  /**
   * Register a callback for the `transport:fallback` event.
   * Fired when the WebSocket transport fails to connect after 3 attempts
   * and the client falls back to HTTP polling.
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
   * Simulate a createInvoice call without submitting a transaction.
   *
   * @returns The expected invoice ID and estimated fee in stroops.
   * @throws StellarSplitError with the simulation error message on failure.
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
   * Simulate a pay call without submitting a transaction.
   *
   * @returns The estimated fee in stroops.
   * @throws StellarSplitError with the simulation error message on failure.
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

  /** Clear the entire invoice cache. */
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
   */
  async bumpStorageTtl(
    invoiceId: string,
    extendTo: number,
    source: string,
  ): Promise<TtlExtensionResult> {
    const ledgerKeys = [
      buildInvoiceDataLedgerKey(this.config.contractId, invoiceId),
    ];
    return extendStorageTtl(this.config, { source, extendTo, ledgerKeys });
  }

  /**
   * Bump storage TTL for multiple contract data keys in a single transaction.
   *
   * @param options - TTL extension parameters including source, target ledger,
   *                  and an array of ledger keys to extend.
   */
  async bumpStorageTtlBatch(
    options: TtlExtensionOptions,
  ): Promise<TtlExtensionResult> {
    return extendStorageTtl(this.config, options);
  }

  /**
   * Switch to a different network.
   *
   * @param network - Network name ('testnet', 'mainnet') or custom NetworkConfig
   */
  switchNetwork(network: string | NetworkConfig): void {
    let config: NetworkConfig;

    if (typeof network === "string") {
      const preset = NETWORKS[network];
      if (!preset) {
        throw new UnknownNetworkError(network);
      }
      config = { ...preset, contractId: this.config.contractId };
    } else {
      config = network;
    }

    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });

    // Rebuild the connection pool for the new endpoint. We read from
    // `_effectiveRpcPoolSize` (cached at construction) rather than
    // `this.config.rpcPoolSize` here because `NetworkConfig` doesn't carry a
    // pool size — reading from `this.config` after `this.config = config`
    // above would silently disable pooling on every network switch.
    if (this._pool) {
      this._pool.dispose();
      this._pool = null;
    }
    const wantsPool = !this._standby && this._effectiveRpcPoolSize >= 2;
    if (wantsPool) {
      try {
        this._pool = new ConnectionPool({
          rpcUrl: config.rpcUrl,
          poolSize: this._effectiveRpcPoolSize,
          allowHttp: config.rpcUrl.startsWith("http://"),
        });
      } catch {
        // The Soroban SDK can reject bare http:// without allowHttp or ws:// URLs.
        // Fail open so switchNetwork() stays a no-op rather than crashing the SDK.
      }
    }

    this.contract = new Contract(config.contractId);
  }

  // ---------------------------------------------------------------------------
  // Connection pool monitoring (issue #360)
  // ---------------------------------------------------------------------------

  /**
   * Snapshot of the underlying RPC connection pool's statistics.
   *
   * Returns `null` when the client is configured with the default single
   * connection. When `rpcPoolSize >= 2` was set at construction time, the
   * returned {@link PoolStats} reports pool size, available slots,
   * cumulative request / error / recycle counters, and per-slot details.
   */
  getPoolStats() {
    return this._pool ? this._pool.getStats() : null;
  }

  // ---------------------------------------------------------------------------
  // Issue #94 — co-signer workflow
  // ---------------------------------------------------------------------------

  /**
   * Build an unsigned transaction XDR for a multi-sig invoice operation.
   * Each signer in the provided list must independently sign this XDR and
   * return a CoSignature for use with submitWithCoSignatures.
   *
   * @param invoiceId - The invoice requiring multiple signatures.
   * @param signers   - Stellar addresses of all required co-signers.
   * @returns Base64-encoded unsigned transaction XDR.
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
   * Compute the time remaining until a scheduled release fires.
   * Accepts an Invoice or a raw timestamp (Unix seconds).
   * When an Invoice is provided, `scheduled_release_at` (or `scheduledReleaseDate`) is used if present;
   * returns null if neither field is set on the invoice.
   *
   * @param invoiceOrTimestamp - An Invoice object or a Unix timestamp (seconds).
   * @returns A structured countdown with total_seconds, days, hours, minutes, seconds, and whether overdue. Null when no scheduled release date.
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
   * Freeze an invoice. Only an authorized admin keypair can call this.
   * The `admin` address must sign the transaction.
   *
   * @param invoiceId - The invoice ID to freeze.
   * @param admin     - Stellar address of the admin (must sign).
   * @returns The transaction hash.
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

  // Timelock action queue
  // ---------------------------------------------------------------------------

  /**
   * Queue a treasury or fee change action for execution after a timelock delay.
   * @param params - Queue action parameters.
   * @returns The action ID and transaction hash.
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
   * Cancel a queued action before it has been executed.
   * @param caller - Stellar address of the caller (must sign).
   * @param actionId - The ID of the action to cancel.
   * @returns The transaction hash.
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

      try {
        const result = await this._doSubmitTx(sourceAddress, operation);
        if (this._idempotency) {
          const opXdr = operation.toXDR().toString("base64");
          const key = this._idempotency.generateKey(sourceAddress, opXdr);
          this._idempotency.tryClaim(key, { txHash: result.txHash });
        }
        return result;
      } catch (error) {
        if (this._standby) {
          this._standby.failover();
          const result = await this._doSubmitTx(sourceAddress, operation);
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
      recordCall(true);
      return { txHash, returnValue };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      await runResponseInterceptors({
        method: "_submitTx",
        result: undefined,
        durationMs,
      });
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
   */
  async refundInvoice(
    invoiceId: string,
    creator: string,
    payerAddress?: string,
  ): Promise<{ txHash: string; fallback: false } | ClaimableRefundResult> {
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
   */
  async getClaimableRefunds(payer: string): Promise<ClaimableRefundEntry[]> {
    return getClaimableRefunds(payer, this.config);
  }

  // ---------------------------------------------------------------------------
  // Issue #73 — syncInvoice (cross-network)
  // ---------------------------------------------------------------------------

  /**
   * Fetch invoice state from all configured RPC endpoints in parallel and
   * return the most recent version based on lastModifiedLedger.
   *
   * @param invoiceId - The invoice ID to sync.
   * @returns The invoice from the endpoint with the highest lastModifiedLedger.
   * @throws If all endpoints fail.
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
   * Get the claimable payout amount for a recipient on an invoice.
   * Returns 0n if no pending payout exists.
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
   * Claim a pending payout for a recipient on an invoice.
   * Emits a `pending_payout_claimed` event on success.
   * @throws If no pending payout exists for the recipient.
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
   * Pay toward an invoice bound to an off-chain identity attestation.
   * Validates attestationHash (32 bytes) and signature (64 bytes) before submission.
   * Returns a payment receipt with the attestation hash included.
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

  /** Returns the volume cap for a creator in token units, or null if uncapped. */
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

  /** Returns the lifetime volume used by a creator in token units. */
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

  /** Returns remaining volume (cap - used) or Infinity if the creator is uncapped. */
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

  // ---------------------------------------------------------------------------
  // Issue #277 — Batch invoice creation helper
  // ---------------------------------------------------------------------------

  /**
   * Create up to 10 invoices in a single fee-bump transaction.
   * Validates all items before submission; fails fast on the first invalid item.
   * Returns invoice IDs in the same order as the input array.
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
   */
  async getLeaderboard(opts?: {
    timeout?: number;
    traceId?: string;
  }): Promise<
    Array<{ creator: string; invoiceCount: number; totalVolume: bigint }>
  > {
    return this._withTelemetry(
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
    );
  }

  /**
   * Fetch the full payment history for an invoice.
   *
   * @param invoiceId - The invoice ID.
   * @param opts      - Optional per-call timeout and trace ID overrides.
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
}

/** Coerce a native-decoded scalar (bigint | number | string) into a bigint, defaulting to 0n. */
function toBigInt(value: unknown): bigint {
  if (typeof value === "bigint") return value;
  if (typeof value === "number") return BigInt(Math.trunc(value));
  if (typeof value === "string" && value !== "") return BigInt(value);
  return 0n;
}
