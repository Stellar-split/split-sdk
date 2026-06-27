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
import type { ExportFormat } from "./export.js";
import { computePaymentValidation } from "./paymentValidator.js";
import type { PaymentValidation } from "./paymentValidator.js";
import { withRetry } from "./retry.js";
import { RetryEngine } from "./retryEngine.js";
import type { RetryConfig } from "./retryEngine.js";
import { TelemetryCollector } from "./telemetryCollector.js";
import { isFeatureEnabled } from "./flags.js";
import type { FeatureFlags } from "./flags.js";
import { checkRPCHealth } from "./health.js";
import { Deduplicator } from "./dedup.js";
import { verifyBatchPayments } from "./batchVerifier.js";
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
import type {
  ArchivedInvoice,
  ArbiterVote,
  BatchPayment,
  BatchResolveResult,
  BulkResult,
  CloneOverrides,
  CoSignature,
  CreateInvoiceParams,
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
} from "./types.js";
import type { DIContainer, IRPCClient, ICacheStore, IWalletAdapter } from "./container.js";
import {
  CoCreatorApprovalNotRequiredError,
  ForwardChainTooDeepError,
  InvoiceFrozenError,
  InvoiceNotFoundError,
  InvoiceNotPendingError,
  UnauthorizedError,
  parseSorobanError,
} from "./errors.js";
import { replayEvents } from "./events.js";
import { subscribeToInvoice as _subscribeToInvoice } from "./stream.js";
import { ConnectionPool } from "./connectionPool.js";
import { snapshotInvoice as _snapshotInvoice } from "./snapshot.js";
import type { InvoiceSnapshot } from "./snapshot.js";
import { SimpleCache } from "./cache.js";
import { validateOrThrow } from "./configValidator.js";
import { extendStorageTtl, buildInvoiceDataLedgerKey } from "./ttlExtension.js";
import type { TtlExtensionOptions, TtlExtensionResult } from "./ttlExtension.js";
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
import type { NormalizedAccount, NormalizedBalance } from "./horizonFallback.js";
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
  cache?: { ttlMs: number };
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
  /** Optional adaptive retry configuration. When provided, replaces legacy maxRetries for pay/cloneInvoice. */
  retry?: RetryConfig;
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

export class StellarSplitClient {
  private _mainServer!: SorobanRpc.Server;
  private _standby: WarmStandby | null = null;
  private _queue = new PriorityQueue();
  private contract: Contract;
  private config: StellarSplitClientConfig;
  private _plugins = new Set<string>();
  private _pluginInstances: StellarSplitPlugin[] = [];
  private _dedup = new Deduplicator<Invoice>();
  private _cache: SimpleCache<Invoice> | ICacheStore<Invoice> | null = null;
  private _auditLogger: AuditLogger | null = null;
  private _degradation: DegradationManager | null = null;
  private _rateLimiter: RateLimiter | null = null;
  private _rpcClient: IRPCClient | null = null;
  private _adapter: WalletAdapter | null = null;
  private _hooks: InvoiceLifecycleHooks = {};
  private _retryEngine: RetryEngine | null = null;
  private _horizonReader: HorizonFallbackReader | null = null;
  private _idempotency: IdempotencyManager | null = null;

  private get server(): SorobanRpc.Server {
    return this._rpcClient ?? this._standby?.server ?? this._mainServer;
  }
  private set server(s: SorobanRpc.Server) {
    this._rpcClient = null;
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
    const primaryUrl = Array.isArray(config.rpcUrl) ? config.rpcUrl[0]! : config.rpcUrl;
    this._rpcClient = config.container?.getRPCClient() ?? null;
    this._adapter = config.container?.getWalletAdapter() ?? config.adapter ?? null;
    this._mainServer = new SorobanRpc.Server(primaryUrl, {
      allowHttp: primaryUrl.startsWith("http://"),
    });

    if (!this._rpcClient && Array.isArray(config.rpcUrl) && config.rpcUrl.length > 1) {
      this._standby = new WarmStandby(config.rpcUrl);
      this._standby.start();
    }

    this.contract = new Contract(config.contractId);

    this._cache =
      config.container?.getCacheStore() ??
      (config.cache ? new SimpleCache<Invoice>(config.cache.ttlMs) : null);

    if (config.telemetry) {
      telemetry.init(config.telemetry);
    }

    if (config.signingKeypair) {
      addRequestInterceptor(createRequestSigningInterceptor(config.signingKeypair));
    }

    if (config.compression?.enabled) {
      addRequestInterceptor(createCompressionRequestInterceptor(config.compression));
      addResponseInterceptor(createCompressionResponseInterceptor(config.compression));
    }

    if (config.cache) {
      this._cache = new SimpleCache<Invoice>(config.cache.ttlMs);
    }

    // Initialize hooks
    this._hooks = config.hooks ?? {};

    if (config.retry) {
      this._retryEngine = new RetryEngine(config.retry, new TelemetryCollector());
    }

    if (config.horizonUrl) {
      this._horizonReader = new HorizonFallbackReader(config.horizonUrl);
    }

    if (config.idempotency) {
      this._idempotency = new IdempotencyManager(config.idempotency);
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

  private _logAudit(method: string, params: Record<string, unknown>, success: boolean, durationMs: number): void {
    if (!this._auditLogger) return;
    this._auditLogger.log({
      timestamp: Date.now(),
      method,
      params: this._auditLogger.sanitize(params),
      success,
      durationMs,
    });
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
      throw new Error(`Plugin "${plugin.name}" is already registered.`);
    }
    this._plugins.add(plugin.name);
    this._pluginInstances.push(plugin);
    plugin.install?.(this);
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
        nativeToScVal(BigInt(invoiceId), { type: "u64" })
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
        nativeToScVal(vote.approve, { type: "bool" })
      );
      const result = await this._submitTx(vote.arbiter, operation);
      const disputeId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod("submitArbiterVote", true, Date.now() - startTime);
      return { disputeId, txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("submitArbiterVote", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Resolve a dispute for an invoice.
   * @param invoiceId - The ID of the invoice to resolve dispute for.
   * @returns The dispute ID and transaction hash.
   */
  async resolveDispute(invoiceId: string): Promise<DisputeResult> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "resolve_dispute",
        nativeToScVal(BigInt(invoiceId), { type: "u64" })
      );
      const result = await this._submitTx(this.config.contractId, operation);
      const disputeId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod("resolveDispute", true, Date.now() - startTime);
      return { disputeId, txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("resolveDispute", false, Date.now() - startTime);
      throw error;
    }
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
    params: CreateInvoiceParams
  ): Promise<{ invoiceId: string; txHash: string }> {
    const startTime = Date.now();
    try {
      if (this.config.payloadGuard) {
        validateInvoicePayload(params, this.config.payloadGuard);
      }

      const recipientAddresses = params.recipients.map((r) =>
        nativeToScVal(r.address, { type: "address" })
      );
      const recipientAmounts = params.recipients.map((r) =>
        nativeToScVal(r.amount, { type: "i128" })
      );

      const operation = this.contract.call(
        "create_invoice",
        nativeToScVal(params.creator, { type: "address" }),
        xdr.ScVal.scvVec(recipientAddresses),
        xdr.ScVal.scvVec(recipientAmounts),
        nativeToScVal(params.token, { type: "address" }),
        nativeToScVal(params.deadline, { type: "u64" })
      );

      const result = await this._submitTx(params.creator, operation);
      const invoiceId = scValToNative(result.returnValue).toString();
      const durationMs = Date.now() - startTime;
      telemetry.recordMethod("createInvoice", true, durationMs);
      this._logAudit("createInvoice", { creator: params.creator, token: params.token, deadline: params.deadline }, true, durationMs);
      return { invoiceId, txHash: result.txHash };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      telemetry.recordMethod("createInvoice", false, durationMs);
      this._logAudit("createInvoice", { creator: params.creator, token: params.token, deadline: params.deadline }, false, durationMs);
      throw error;
    }
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
    overrides: CloneOverrides = {}
  ): Promise<string> {
    const startTime = Date.now();
    const sourceInvoice = await this.getInvoice(sourceId);

    const mapEntries: xdr.ScMapEntry[] = [];

    if (overrides.newDeadline !== undefined) {
      mapEntries.push(
        new xdr.ScMapEntry({
          key: nativeToScVal("new_deadline", { type: "symbol" }) as xdr.ScVal,
          val: nativeToScVal(overrides.newDeadline, { type: "u64" }) as xdr.ScVal,
        })
      );
    }
    if (overrides.newAmounts !== undefined) {
      mapEntries.push(
        new xdr.ScMapEntry({
          key: nativeToScVal("new_amounts", { type: "symbol" }) as xdr.ScVal,
          val: xdr.ScVal.scvVec(
            overrides.newAmounts.map((a) => nativeToScVal(a, { type: "i128" }))
          ) as xdr.ScVal,
        })
      );
    }
    if (overrides.newRecipients !== undefined) {
      mapEntries.push(
        new xdr.ScMapEntry({
          key: nativeToScVal("new_recipients", { type: "symbol" }) as xdr.ScVal,
          val: xdr.ScVal.scvVec(
            overrides.newRecipients.map((r) => nativeToScVal(r, { type: "address" }))
          ) as xdr.ScVal,
        })
      );
    }
    // new_overflow_behavior is a Vec<OverflowBehavior> on the contract side (0 or 1
    // elements), not an Option — the contract can't represent Option<PlainEnum> in a
    // #[contracttype] struct, so the key is always sent.
    mapEntries.push(
      new xdr.ScMapEntry({
        key: nativeToScVal("new_overflow_behavior", { type: "symbol" }) as xdr.ScVal,
        val: xdr.ScVal.scvVec(
          overrides.newOverflowBehavior !== undefined
            ? [nativeToScVal(overrides.newOverflowBehavior, { type: "symbol" }) as xdr.ScVal]
            : []
        ) as xdr.ScVal,
      })
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
      const result = this._retryEngine
        ? await this._retryEngine.execute(submitFn, "cloneInvoice")
        : await withRetry(submitFn, this.config.maxRetries ?? 3, 1000);

      const id = scValToNative(result.returnValue).toString() as string;
      newInvoiceId = id;

      if (this._cache) {
        const cloneDepth =
          typeof (sourceInvoice as unknown as Record<string, unknown>).cloneDepth === "number"
            ? ((sourceInvoice as unknown as Record<string, unknown>).cloneDepth as number) + 1
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
    try {
      const operation = this.contract.call(
        "pay",
        nativeToScVal(params.payer, { type: "address" }),
        nativeToScVal(BigInt(params.invoiceId), { type: "u64" }),
        nativeToScVal(params.amount, { type: "i128" }),
        nativeToScVal(params.donateOnFailure ?? false, { type: "bool" })
      );

      const submitFn = () => this._submitTx(params.payer, operation);
      const result = this._retryEngine
        ? await this._retryEngine.execute(submitFn, "pay")
        : await withRetry(submitFn, this.config.maxRetries ?? 3, 1000);
      this._cache?.invalidate(params.invoiceId);
      telemetry.recordMethod("pay", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("pay", false, Date.now() - startTime);
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
    params: CreateInvoiceParams[]
  ): Promise<{ invoiceIds: string[]; txHash: string }> {
    if (params.length === 0 || params.length > 5) {
      throw new Error("Batch size must be between 1 and 5 items");
    }

    const invoiceParams = params.map((p) => {
      const recipientAddresses = p.recipients.map((r) =>
        nativeToScVal(r.address, { type: "address" })
      );
      const recipientAmounts = p.recipients.map((r) =>
        nativeToScVal(r.amount, { type: "i128" })
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
      xdr.ScVal.scvVec(invoiceParams)
    );

    const firstParam = params[0];
    if (!firstParam) throw new Error("Batch params array is empty");
    const result = await this._submitTx(firstParam.creator, operation);
    const invoiceIds = (scValToNative(result.returnValue) as (string | number)[]).map(
      (id) => id.toString()
    );
    return { invoiceIds, txHash: result.txHash };
  }

  /**
   * Fetch an invoice by ID. Returns cached result if within TTL.
   */
  async getInvoice(invoiceId: string): Promise<Invoice> {
    if (this._cache) {
      const cached = this._cache.get(invoiceId);
      if (cached) return cached;
    }
    const invoice = await this._dedup.dedupe(invoiceId, () => this._fetchInvoice(invoiceId));
    if (this._cache) {
      this._cache.set(invoiceId, invoice);
    }
    return invoice;
  }

  private async _fetchInvoice(invoiceId: string): Promise<Invoice> {
    const startTime = Date.now();
    const req = { method: "getInvoice", params: [invoiceId] };
    await runRequestInterceptors(req);

    const fetchFn = async (): Promise<Invoice> => {
      const operation = this.contract.call(
        "get_invoice",
        nativeToScVal(BigInt(invoiceId), { type: "u64" })
      );

      const account = await this.server.getAccount(this.config.contractId).catch(() => null);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const sourceAccount = account ?? ({ accountId: () => this.config.contractId, sequenceNumber: () => "0", incrementSequenceNumber: () => {} } as any);

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

      const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
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
      await runResponseInterceptors({ method: "getInvoice", result: invoice, durationMs });
      recordCall(true);
      return invoice;
    } catch (error) {
      telemetry.recordMethod("getInvoice", false, Date.now() - startTime);
      const durationMs = Date.now() - startTime;
      await runResponseInterceptors({ method: "getInvoice", result: undefined, durationMs });
      recordCall(false);
      throw error;
    }
  }

  /**
   * Check invoice compliance against built-in and configured rules.
   * @param invoiceId - Invoice ID to validate
   */
  async checkCompliance(invoiceId: string): Promise<import("./compliance.js").ComplianceReport> {
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
   * Reconcile an invoice's reported funded amount with its payment records and historical payment events.
   */
  async reconcilePayments(invoiceId: string): Promise<PaymentReconciliationReport> {
    const startTime = Date.now();
    try {
      const invoice = await this.getInvoice(invoiceId);
      const events = await replayEvents(this.server, this.config.contractId, 0, Number.MAX_SAFE_INTEGER);
      const paymentEvents = events
        .filter((event) => event.invoiceId === invoiceId && event.type === "payment")
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

      const paymentRecordsTotal = invoice.payments.reduce((sum, payment) => sum + payment.amount, 0n);
      const paymentEventsTotal = paymentEvents.reduce((sum, event) => sum + event.amount, 0n);
      const fundedDiscrepancy = invoice.funded - paymentRecordsTotal;
      const recordsMatchEvents = paymentRecordsTotal === paymentEventsTotal;
      const consistent = invoice.funded === paymentEventsTotal && recordsMatchEvents;

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
      telemetry.recordMethod("reconcilePayments", false, Date.now() - startTime);
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
        throw new Error("Invoice must be Released to generate a receipt");
      }

      const receiptId = await this._buildReceiptId(invoice);
      const totalAmount = invoice.payments.reduce(
        (sum, payment) => sum + payment.amount,
        0n
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
    const settled = await Promise.allSettled(ids.map((id) => this.getInvoice(id)));
    return settled.map((result, i) => {
      const invoiceId = ids[i]!;
      if (result.status === "fulfilled") {
        return { invoiceId, success: true as const, invoice: result.value };
      }
      return {
        invoiceId,
        success: false as const,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
      };
    });
  }

  private _nftGateCache = new Map<string, { timestamp: number; result: { gated: boolean; hasNft: boolean; contractAddress: string | null } }>();

  /**
   * Checks the NFT gate status for a given creator address.
   */
  async checkNftGate(creatorAddress: string): Promise<{ gated: boolean; hasNft: boolean; contractAddress: string | null }> {
    const now = Date.now();
    const cached = this._nftGateCache.get(creatorAddress);
    if (cached && now - cached.timestamp < 30000) {
      return cached.result;
    }

    try {
      const operation = this.contract.call(
        "check_nft_gate",
        nativeToScVal(creatorAddress, { type: "address" })
      );
      
      const raw = await this._simulateView(operation) as any;
      let result = { gated: false, hasNft: false, contractAddress: null };
      
      if (raw && typeof raw === "object") {
        result = {
          gated: Boolean(raw.gated),
          hasNft: Boolean(raw.hasNft || raw.has_nft),
          contractAddress: (raw.contractAddress || raw.contract_address) ?? null
        };
      }
      
      this._nftGateCache.set(creatorAddress, { timestamp: now, result });
      return result;
    } catch (error) {
      // If the method doesn't exist or fails, assume no gate
      const result = { gated: false, hasNft: false, contractAddress: null };
      this._nftGateCache.set(creatorAddress, { timestamp: now, result });
      return result;
    }
  }

  /**
   * Resolves the forward chain for an invoice.
   */
  async getForwardChain(invoiceId: string): Promise<Array<{ id: string; status: InvoiceStatus; forwardTo?: string }>> {
    const chain: Array<{ id: string; status: InvoiceStatus; forwardTo?: string }> = [];
    const visited = new Set<string>();
    let currentId: string | undefined = invoiceId;
    let depth = 0;

    while (currentId) {
      if (depth >= 10) {
        throw new ForwardChainTooDeepError(`Max chain depth of 10 exceeded starting from invoice ${invoiceId}`);
      }
      if (visited.has(currentId)) {
        throw new Error(`Circular forward chain detected at invoice ${currentId}`);
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
        console.error(`[StellarSplitClient] Plugin "${p.name}" onDestroy error:`, error);
      }
    }
    this._pluginInstances = [];
    this._plugins.clear();

    try {
      await this._queue.shutdown();
    } finally {
      this._standby?.stop();

      if (this._cache && typeof (this._cache as any).persist === "function") {
        await (this._cache as any).persist();
      }
      if (this._cache && typeof (this._cache as any).close === "function") {
        await (this._cache as any).close();
      }
      if (this._rpcClient && typeof (this._rpcClient as any).close === "function") {
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
        nativeToScVal(BigInt(invoiceId), { type: "u64" })
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
        nativeToScVal(BigInt(invoiceId), { type: "u64" })
      );
      return this._submitTx(this.config.contractId, operation);
    });
  }

  /**
   * Export multiple invoices in parallel and return formatted results by invoice ID.
   */
  async bulkExport(ids: string[], format: ExportFormat): Promise<Record<string, string>> {
    const settled = await Promise.allSettled(
      ids.map(async (invoiceId) => {
        const invoice = await this.getInvoice(invoiceId);
        return { invoiceId, data: exportInvoice(invoice, format) };
      })
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
    execute: (invoiceId: string) => Promise<unknown>
  ): Promise<BulkResult[]> {
    const settled = await Promise.allSettled(ids.map((invoiceId) => execute(invoiceId)));
    return settled.map((result, index) => {
      const invoiceId = ids[index]!;
      if (result.status === "fulfilled") {
        return { invoiceId, success: true };
      }
      return {
        invoiceId,
        success: false,
        error: result.reason instanceof Error ? result.reason.message : String(result.reason),
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
    template: InvoiceTemplate
  ): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const recipientAddresses = template.recipients.map((r) =>
        nativeToScVal(r.address, { type: "address" })
      );
      const recipientAmounts = template.recipients.map((r) =>
        nativeToScVal(r.amount, { type: "i128" })
      );

      const operation = this.contract.call(
        "save_template",
        nativeToScVal(creator, { type: "address" }),
        nativeToScVal(template.name, { type: "string" }),
        xdr.ScVal.scvVec(recipientAddresses),
        xdr.ScVal.scvVec(recipientAmounts),
        nativeToScVal(template.token, { type: "address" })
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
    deadline: number
  ): Promise<{ invoiceId: string; txHash: string }> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "create_from_template",
        nativeToScVal(creator, { type: "address" }),
        nativeToScVal(templateName, { type: "string" }),
        nativeToScVal(deadline, { type: "u64" })
      );

      const result = await this._submitTx(creator, operation);
      const invoiceId = scValToNative(result.returnValue).toString();
      telemetry.recordMethod("createFromTemplate", true, Date.now() - startTime);
      return { invoiceId, txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("createFromTemplate", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * List all template names for a creator.
   */
  async listTemplates(creator: string): Promise<string[]> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "list_templates",
        nativeToScVal(creator, { type: "address" })
      );

      const templates = await this._simulateView(operation);
      const result = Array.isArray(templates) ? (templates as string[]) : [];
      telemetry.recordMethod("listTemplates", true, Date.now() - startTime);
      return result;
    } catch (error) {
      telemetry.recordMethod("listTemplates", false, Date.now() - startTime);
      throw error;
    }
  }

  /**
   * Get all recurring invoices for a creator.
   */
  async getRecurringInvoices(creator: string): Promise<Invoice[]> {
    const startTime = Date.now();
    try {
      const page = await this.getInvoicesByCreator(creator);
      const invoices = await Promise.all(page.items.map((id) => this.getInvoice(id)));
      const recurring = invoices.filter((inv) => inv.recurring === true);
      telemetry.recordMethod("getRecurringInvoices", true, Date.now() - startTime);
      return recurring;
    } catch (error) {
      telemetry.recordMethod("getRecurringInvoices", false, Date.now() - startTime);
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
        nativeToScVal(creator, { type: "address" })
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
    amounts: bigint[]
  ): Promise<TxResult> {
    const startTime = Date.now();
    try {
      const amountVals = amounts.map((a) => nativeToScVal(a, { type: "i128" }));

      const operation = this.contract.call(
        "update_recurring_amount",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(creator, { type: "address" }),
        xdr.ScVal.scvVec(amountVals)
      );

      const result = await this._submitTx(creator, operation);
      telemetry.recordMethod("updateRecurringAmount", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("updateRecurringAmount", false, Date.now() - startTime);
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
    options: PaginationOptions = {}
  ): Promise<PaginatedResult<string>> {
    const limit = options.limit ?? 20;

    const operation = this.contract.call(
      "get_invoices_by_creator",
      nativeToScVal(creator, { type: "address" })
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
    const nextCursor = startIndex + limit < total ? (page[page.length - 1] ?? null) : null;

    return { items: page, nextCursor, total };
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
    options: PaginationOptions = {}
  ): Promise<PaginatedResult<string>> {
    const limit = options.limit ?? 20;

    const operation = this.contract.call(
      "get_invoices_by_recipient",
      nativeToScVal(recipient, { type: "address" })
    );

    const account = await this.server.getAccount(this.config.contractId).catch(() => null);
    const sourceAccount = account ?? new Account(this.config.contractId, "0");

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) throw new Error("No return value from get_invoices_by_recipient");

    const raw = scValToNative(returnVal);
    const allIds: string[] = Array.isArray(raw) ? raw.map((id: unknown) => String(id)) : [];

    const total = allIds.length;
    const startIndex = options.cursor ? allIds.indexOf(options.cursor) + 1 : 0;
    const page = allIds.slice(startIndex, startIndex + limit);
    const nextCursor = startIndex + limit < total ? (page[page.length - 1] ?? null) : null;

    return { items: page, nextCursor, total };
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
    invoiceIds: string[]
  ): Promise<{ groupId: string; txHash: string }> {
    const invoiceIdsBigInt = invoiceIds.map((id) =>
      nativeToScVal(BigInt(id), { type: "u64" })
    );

    const operation = this.contract.call(
      "create_invoice_group",
      nativeToScVal(creator, { type: "address" }),
      xdr.ScVal.scvVec(invoiceIdsBigInt)
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
      nativeToScVal(BigInt(groupId), { type: "u64" })
    );

    const raw = await this._simulateView(operation) as Record<string, unknown>;
    return {
      groupId,
      invoiceIds: (raw.invoiceIds as (string | number)[]).map((id) => String(id)),
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
      nativeToScVal(BigInt(groupId), { type: "u64" })
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
      throw new Error("payments array must not be empty");
    }

    for (const p of payments) {
      if (!p.invoiceId || isNaN(Number(p.invoiceId))) {
        throw new Error(`Invalid invoiceId: ${p.invoiceId}`);
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
      xdr.ScVal.scvVec(paymentVals)
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
  async verifyBatchPay(payments: BatchPayment[]): Promise<BatchVerificationResult> {
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
    amount: bigint
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
    tokenAddress: string
  ): Promise<bigint> {
    const tokenContract = new Contract(tokenAddress);
    const operation = tokenContract.call(
      "balance",
      nativeToScVal(address, { type: "address" })
    );

    const result = await this._simulateView(operation);
    if (typeof result === "bigint") {
      return result;
    }
    if (typeof result === "string" || typeof result === "number") {
      return BigInt(result);
    }
    if (typeof result === "object" && result !== null && "balance" in result) {
      return BigInt((result as Record<string, unknown>).balance as string | number);
    }

    throw new Error("Unable to determine USDC balance");
  }

  // ---------------------------------------------------------------------------
  // Issue #2 — subscribeToInvoice
  // ---------------------------------------------------------------------------

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
    intervalMs?: number
  ): () => void {
    return _subscribeToInvoice(
      this.server,
      this.config.contractId,
      invoiceId,
      callbacks,
      intervalMs
    );
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
    operation: xdr.Operation
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
      throw new Error(`Simulation failed: ${simResult.error}`);
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
    const tx = TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase);
    const sendResult = await this.server.sendTransaction(tx);

    if (sendResult.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(sendResult.errorResult)}`);
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
      throw new Error(`Transaction not confirmed: ${getResult.status}`);
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
    params: CreateInvoiceParams
  ): Promise<SimulateCreateInvoiceResult> {
    const recipientAddresses = params.recipients.map((r) =>
      nativeToScVal(r.address, { type: "address" })
    );
    const recipientAmounts = params.recipients.map((r) =>
      nativeToScVal(r.amount, { type: "i128" })
    );

    const operation = this.contract.call(
      "create_invoice",
      nativeToScVal(params.creator, { type: "address" }),
      xdr.ScVal.scvVec(recipientAddresses),
      xdr.ScVal.scvVec(recipientAmounts),
      nativeToScVal(params.token, { type: "address" }),
      nativeToScVal(params.deadline, { type: "u64" })
    );

    const account = await this.server.getAccount(params.creator).catch(() => null);
    const sourceAccount = account ?? ({
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
      throw new Error(`Simulation error: ${simResult.error}`);
    }

    const success = simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse;
    const returnVal = success.result?.retval;
    if (!returnVal) throw new Error("No return value from simulate create_invoice");

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
      nativeToScVal(params.amount, { type: "i128" })
    );

    const account = await this.server.getAccount(params.payer).catch(() => null);
    const sourceAccount = account ?? ({
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
      throw new Error(`Simulation error: ${simResult.error}`);
    }

    const success = simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse;
    const fee = success.minResourceFee ?? "0";

    return { fee: fee.toString() };
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
    const simResult = await this._simulateView(operation) as { minResourceFee?: string; error?: string };
    if (simResult.error) throw new Error(`Fee estimation failed: ${simResult.error}`);
    const fee = BigInt(simResult.minResourceFee ?? "0");
    let congestion: FeeEstimate["congestion"] = "low";
    try {
      const stats = await this.server.getFeeStats() as { sorobanInclusionFee?: { p50?: string; p99?: string } };
      const p50 = Number(stats.sorobanInclusionFee?.p50 ?? "1");
      const p99 = Number(stats.sorobanInclusionFee?.p99 ?? "1");
      const ratio = p99 > 0 ? p50 / p99 : 1;
      congestion = ratio >= 0.9 ? "low" : ratio >= 0.5 ? "medium" : "high";
    } catch { /* use default */ }
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
      throw new Error("signers array must not be empty");
    }

    let current = xdrStr;
    for (const signer of signers) {
      try {
        current = await (this._adapter
          ? this._adapter.signTransaction(current, this.config.networkPassphrase)
          : signTransaction(current, this.config.networkPassphrase));
      } catch (err) {
        throw new Error(
          `Signer ${signer} failed to sign: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
    return current;
  }

  // ---------------------------------------------------------------------------
  // Issue #7 — cache invalidation helpers (public)
  // ---------------------------------------------------------------------------

  /** Manually invalidate a cached invoice entry. */
  invalidateCache(invoiceId: string): void {
    this._cache?.invalidate(invoiceId);
  }

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
    source: string
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
    options: TtlExtensionOptions
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
        throw new Error(`Unknown network: ${network}`);
      }
      config = { ...preset, contractId: this.config.contractId };
    } else {
      config = network;
    }

    this.config = config;
    this.server = new SorobanRpc.Server(config.rpcUrl, {
      allowHttp: config.rpcUrl.startsWith("http://"),
    });
    this.contract = new Contract(config.contractId);
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
  async collectCoSignatures(invoiceId: string, signers: string[]): Promise<string> {
    if (signers.length === 0) throw new Error("At least one signer required");

    const firstSigner = signers[0]!;
    const operation = this.contract.call(
      "release_invoice",
      nativeToScVal(BigInt(invoiceId), { type: "u64" })
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
      throw new Error(`Simulation failed: ${simResult.error}`);
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
  async submitWithCoSignatures(invoiceId: string, signatures: CoSignature[]): Promise<TxResult> {
    const invoice = await this.getInvoice(invoiceId);
    const requiredCount = invoice.recipients.length;

    if (signatures.length < requiredCount) {
      throw new Error(
        `Insufficient signatures: ${signatures.length} provided, ${requiredCount} required`
      );
    }

    const firstSig = signatures[0]!;
    const mergedTx = TransactionBuilder.fromXDR(
      firstSig.signedXdr,
      this.config.networkPassphrase
    ) as Transaction;

    for (let i = 1; i < signatures.length; i++) {
      const sig = signatures[i]!;
      const otherTx = TransactionBuilder.fromXDR(
        sig.signedXdr,
        this.config.networkPassphrase
      ) as Transaction;
      for (const decoratedSig of otherTx.signatures) {
        mergedTx.addDecoratedSignature(decoratedSig);
      }
    }

    const sendResult = await this.server.sendTransaction(mergedTx);
    if (sendResult.status === "ERROR") {
      throw new Error(`Transaction failed: ${JSON.stringify(sendResult.errorResult)}`);
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
      throw new Error(`Transaction not confirmed: ${getResult.status}`);
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
    caller: string
  ): Promise<RolloverResult> {
    const startTime = Date.now();
    try {
      const result = await _rolloverInvoice(
        invoiceId,
        newDeadline,
        caller,
        this.server,
        this.config,
        this._adapter
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
      nativeToScVal(BigInt(invoiceId), { type: "u64" })
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
  async submitCoCreatorApproval(invoiceId: string, signer: string): Promise<TxResult> {
    const startTime = Date.now();
    try {
      await this._needsCoCreatorApproval(invoiceId);

      const operation = this.contract.call(
        "submit_co_creator_approval",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(signer, { type: "address" })
      );
      const result = await this._submitTx(signer, operation);
      telemetry.recordMethod("submitCoCreatorApproval", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("submitCoCreatorApproval", false, Date.now() - startTime);
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
        nativeToScVal(BigInt(invoiceId), { type: "u64" })
      );
      const raw = await this._simulateView(operation) as string[];
      telemetry.recordMethod("getCoCreatorApprovals", true, Date.now() - startTime);
      return raw;
    } catch (error) {
      telemetry.recordMethod("getCoCreatorApprovals", false, Date.now() - startTime);
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
  async revokeCoCreatorApproval(invoiceId: string, signer: string): Promise<TxResult> {
    const startTime = Date.now();
    try {
      await this._needsCoCreatorApproval(invoiceId);

      const operation = this.contract.call(
        "revoke_co_creator_approval",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(signer, { type: "address" })
      );
      const result = await this._submitTx(signer, operation);
      telemetry.recordMethod("revokeCoCreatorApproval", true, Date.now() - startTime);
      return { txHash: result.txHash };
    } catch (error) {
      telemetry.recordMethod("revokeCoCreatorApproval", false, Date.now() - startTime);
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
  async getPaymentCooldown(invoiceId: string, payerAddress: string): Promise<PaymentCooldown> {
    const startTime = Date.now();
    try {
      const operation = this.contract.call(
        "payment_cooldown",
        nativeToScVal(BigInt(invoiceId), { type: "u64" }),
        nativeToScVal(payerAddress, { type: "address" })
      );
      const raw = await this._simulateView(operation) as Record<string, unknown>;
      const result: PaymentCooldown = {
        inCooldown: Boolean(raw.in_cooldown ?? raw.inCooldown ?? false),
        cooldownEndsAt: raw.cooldown_ends_at != null
          ? Number(raw.cooldown_ends_at)
          : raw.cooldownEndsAt != null
            ? Number(raw.cooldownEndsAt)
            : null,
      };
      telemetry.recordMethod("getPaymentCooldown", true, Date.now() - startTime);
      return result;
    } catch (error) {
      telemetry.recordMethod("getPaymentCooldown", false, Date.now() - startTime);
      throw error;
    }
  }

  // ---------------------------------------------------------------------------
  // Internal helpers
  // ---------------------------------------------------------------------------

  /** Simulate a read-only contract call and return the native-decoded result. */
  private async _simulateView(operation: xdr.Operation): Promise<unknown> {
    const account = await this.server.getAccount(this.config.contractId).catch(() => null);
    const sourceAccount = account ?? new Account(this.config.contractId, "0");

    const tx = new TransactionBuilder(sourceAccount, {
      fee: BASE_FEE,
      networkPassphrase: this.config.networkPassphrase,
    })
      .addOperation(operation)
      .setTimeout(30)
      .build();

    const simResult = await this.server.simulateTransaction(tx);
    if (SorobanRpc.Api.isSimulationError(simResult)) {
      throw new Error(`Simulation failed: ${simResult.error}`);
    }

    const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
    if (!returnVal) throw new Error("No return value from simulation");

    return scValToNative(returnVal);
  }

  /** Build, simulate, sign, and submit a transaction — routed through the priority queue. */
  private _submitTx(
    sourceAddress: string,
    operation: xdr.Operation,
    priority: RequestPriority = "normal"
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
    operation: xdr.Operation
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
        ? this._adapter.signTransaction(preparedTx.toXDR(), this.config.networkPassphrase)
        : signTransaction(preparedTx.toXDR(), this.config.networkPassphrase));

      const sendResult = await this.server.sendTransaction(
        TransactionBuilder.fromXDR(signedXdr, this.config.networkPassphrase)
      );

      if (sendResult.status === "ERROR") {
        throw new Error(`Transaction failed: ${JSON.stringify(sendResult.errorResult)}`);
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
          this.config.networkPassphrase
        ) as Parameters<typeof TransactionBuilder.buildFeeBumpTransaction>[2];
        const bumpedFee = String(Math.ceil(Number(BASE_FEE) * multiplier));
        const feeBumpTx = TransactionBuilder.buildFeeBumpTransaction(
          sourceAddress,
          bumpedFee,
          innerTx,
          this.config.networkPassphrase
        );
        const signedBumpXdr = await (this._adapter
          ? this._adapter.signTransaction(feeBumpTx.toXDR(), this.config.networkPassphrase)
          : signTransaction(feeBumpTx.toXDR(), this.config.networkPassphrase));
        const bumpSendResult = await this.server.sendTransaction(
          TransactionBuilder.fromXDR(signedBumpXdr, this.config.networkPassphrase)
        );
        if (bumpSendResult.status === "ERROR") {
          throw new Error(`Fee-bump transaction failed: ${JSON.stringify(bumpSendResult.errorResult)}`);
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
          throw new Error(`Fee-bump transaction not confirmed: ${bumpResult.status}`);
        }
        const bumpReturnValue =
          (bumpResult as SorobanRpc.Api.GetSuccessfulTransactionResponse).returnValue ??
          xdr.ScVal.scvVoid();

        const durationMs = Date.now() - startTime;
        await runResponseInterceptors({ method: "_submitTx", result: { txHash: bumpHash, returnValue: bumpReturnValue }, durationMs });
        recordCall(true);
        return { txHash: bumpHash, returnValue: bumpReturnValue };
      }

      if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
        throw new Error(`Transaction not confirmed: ${getResult.status}`);
      }

      const returnValue =
        (getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse).returnValue ??
        xdr.ScVal.scvVoid();

      const durationMs = Date.now() - startTime;
      await runResponseInterceptors({ method: "_submitTx", result: { txHash, returnValue }, durationMs });
      recordCall(true);
      return { txHash, returnValue };
    } catch (error) {
      const durationMs = Date.now() - startTime;
      await runResponseInterceptors({ method: "_submitTx", result: undefined, durationMs });
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
        if (amt === undefined) throw new Error(`Missing amount for recipient at index ${i}`);
        return {
          address: addr,
          amount: BigInt(amt as string | number),
        };
      }
    );

    const payments: Payment[] = ((raw.payments as unknown[]) ?? []).map(
      (p: unknown) => {
        const pm = p as Record<string, unknown>;
        return {
          payer: pm.payer as string,
          amount: BigInt(pm.amount as string | number),
          donateOnFailure: pm.donateOnFailure === true,
        };
      }
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
      parentInvoiceId: raw.parentInvoiceId ? String(raw.parentInvoiceId) : undefined,
      cloneDepth: typeof raw.cloneDepth === "number" ? raw.cloneDepth : undefined,
      groupId: raw.groupId as string | undefined,
    };
  }

  /**
   * Fetch extended invoice metadata (clone chain info) via get_invoice_ext.
   */
  private async _getInvoiceExt(invoiceId: string): Promise<InvoiceExt> {
    const operation = this.contract.call(
      "get_invoice_ext",
      nativeToScVal(BigInt(invoiceId), { type: "u64" })
    );

    const raw = await this._simulateView(operation) as Record<string, unknown>;

    return {
      parentInvoiceId: raw.parentInvoiceId ? String(raw.parentInvoiceId) : null,
      cloneDepth: Number(raw.cloneDepth ?? 0),
    };
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
        throw new Error("clone chain cycle detected");
      }
      if (depth >= MAX_DEPTH) {
        throw new Error("clone chain depth exceeded");
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
          `[StellarSplitClient] getAccount fallback (${attempt.url}): ${attempt.error}`
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
      throw new Error(
        "getAccountBalances requires horizonUrl to be set in StellarSplitClientConfig"
      );
    }

    const horizonReader = this._horizonReader;
    // Soroban RPC has no balance endpoint — the chain falls through to Horizon immediately.
    const chain = new FallbackChain(["rpc", "horizon"], {
      logger: (attempt) =>
        console.warn(
          `[StellarSplitClient] getAccountBalances fallback (${attempt.url}): ${attempt.error}`
        ),
    });

    return chain.execute(async (provider) => {
      if (provider === "rpc") {
        throw new Error(
          "Soroban RPC does not expose account balances; delegating to Horizon"
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
    payerAddress?: string
  ): Promise<{ txHash: string; fallback: false } | ClaimableRefundResult> {
    const startTime = Date.now();

    try {
      const operation = this.contract.call(
        "refund_invoice",
        nativeToScVal(BigInt(invoiceId), { type: "u64" })
      );
      const result = await this._submitTx(creator, operation);

      const invoice = await this.getInvoice(invoiceId).catch(() => null);
      if (invoice) this._fireOnRefunded(invoice);

      telemetry.recordMethod("refundInvoice", true, Date.now() - startTime);
      return { txHash: result.txHash, fallback: false };
    } catch (error) {
      // Fallback path: if transfer failed due to missing account/trustline and
      // Horizon is configured, create a claimable balance instead.
      if (isRefundTransferError(error) && this.config.horizonUrl && payerAddress) {
        console.warn(
          `[StellarSplitClient] refundInvoice: transfer failed for invoice ${invoiceId} ` +
            `(${error instanceof Error ? error.message : String(error)}); ` +
            `creating claimable-balance fallback for payer ${payerAddress}`
        );

        try {
          const invoice = await this.getInvoice(invoiceId).catch(() => null);
          const amount = invoice?.funded ?? 0n;

          const claimableResult = await createClaimableRefund(
            payerAddress,
            amount,
            Asset.native(),
            creator,
            this.config
          );

          telemetry.recordMethod("refundInvoice", true, Date.now() - startTime);
          return claimableResult;
        } catch (fallbackError) {
          telemetry.recordMethod("refundInvoice", false, Date.now() - startTime);
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
  async syncInvoice(invoiceId: string): Promise<{ invoice: Invoice; source: string; ledger: number }> {
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
          nativeToScVal(BigInt(invoiceId), { type: "u64" })
        );
        const account = await server.getAccount(this.config.contractId).catch(() => null);
        const sourceAccount = account ?? new Account(this.config.contractId, "0");
        const tx = new TransactionBuilder(sourceAccount, {
          fee: BASE_FEE,
          networkPassphrase: this.config.networkPassphrase,
        })
          .addOperation(operation)
          .setTimeout(30)
          .build();
        const simResult = await server.simulateTransaction(tx);
        if (SorobanRpc.Api.isSimulationError(simResult)) {
          throw new Error(`Simulation failed on ${url}: ${simResult.error}`);
        }
        const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
        if (!returnVal) throw new Error(`No return value from ${url}`);
        const raw = scValToNative(returnVal) as Record<string, unknown>;
        const invoice = this._parseInvoice(invoiceId, raw);
        const ledger = typeof raw.lastModifiedLedger === "number"
          ? raw.lastModifiedLedger
          : 0;
        return { invoice, source: url, ledger };
      })
    );

    const successful = results
      .filter((r): r is PromiseFulfilledResult<{ invoice: Invoice; source: string; ledger: number }> => r.status === "fulfilled")
      .map((r) => r.value);

    if (successful.length === 0) {
      throw new Error("All RPC endpoints failed to sync invoice");
    }

    return successful.reduce((best, cur) => cur.ledger > best.ledger ? cur : best);
  }

}
