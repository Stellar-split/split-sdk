import { vi } from "vitest";
import type { Invoice, Payment, CreateInvoiceParams, DisputeResult, HealthCheckResult, InvoiceReceipt, BatchResolveResult, NftGateResult, InvoiceStatus, PaymentReconciliationReport, BulkResult, InvoiceTemplate, PaginatedResult, PaginationOptions, ScheduledReleaseCountdown, CompletionProof, ClaimPayoutResult, PayWithAttestationParams, AttestationPaymentReceipt, SetCrossChainRefParams, AuctionInfo, QueueActionParams, TimelockAction, CrossChainRef, VelocityStatus, FeeBreakdown, TokenInfo, PaymentProof, BatchPayment, PaymentValidation, SimulateCreateInvoiceResult, SimulatePayResult, FeeEstimate, CoSignature, PaymentCooldown, ArbiterVote, PayParams, AdminFreezeResult, AdminUnfreezeResult } from "../types.js";
import type { TxResult, StellarSplitClientConfig } from "../client.js";
import type { InvoiceSnapshot } from "../snapshot.js";
import type { TtlExtensionOptions, TtlExtensionResult } from "../ttlExtension.js";
import type { NormalizedAccount, NormalizedBalance } from "../horizonFallback.js";
import type { ComplianceReport, ComplianceRule } from "../compliance.js";
import type { TelemetryHooks } from "../telemetryHooks.js";
import type { SdkPlugin } from "../plugin.js";
import type { ExportFormat } from "../export.js";
import { Transaction, Keypair } from "@stellar/stellar-sdk";

// Minimal mock for Contract to allow type checking without full implementation
class MockContract {
  call = vi.fn((_method: string, ..._args: any[]) => ({ type: "mock" }));
}

// Minimal mock for SorobanRpc.Server
class MockSorobanRpcServer {
  getLatestLedger = vi.fn(() => Promise.resolve({ sequence: 100 }));
  getNetwork = vi.fn(() => Promise.resolve({ passphrase: "Test SDF Network ; September 2015" }));
  getContractWasmByContractId = vi.fn(() => Promise.resolve({ wasm: "mock_wasm" }));
  simulateTransaction = vi.fn((_tx: Transaction) => Promise.resolve({}));
  getAccount = vi.fn((_accountId: string) => Promise.resolve({ sequenceNumber: () => "123", incrementSequenceNumber: () => {} }));
}

// Local mock function type compatible with both Jest and Vitest
type MockFn<A extends any[], R> = ((...args: A) => R) & {
  mock: {
    calls: A[];
    results: Array<{ type: "return"; value: Awaited<R> } | { type: "throw"; value: any }>;
    mockResolvedValueOnce: (value: Awaited<R>) => any;
    mockReturnValueOnce: (value: R) => any;
    mockImplementation: (fn: (...args: A) => R) => any;
    mockImplementationOnce: (fn: (...args: A) => R) => any;
    mockClear: () => void;
    mockReset: () => void;
    mockRestore: () => void;
  };
};

// Utility type to mock all methods of a class/interface
type Mocked<T> = {
  [P in keyof T]: T[P] extends (...args: infer A) => infer R
    ? MockFn<A, Promise<Awaited<R>>>
    : T[P];
};

export type MockStellarSplitSDK = Mocked<
  Omit<
    import("../client.js").StellarSplitClient,
    | "constructor"
    | "_mainServer"
    | "_standby"
    | "_queue"
    | "contract"
    | "config"
    | "_plugins"
    | "_pluginInstances"
    | "_pluginRegistry"
    | "_dedup"
    | "_cache"
    | "_auditLogger"
    | "_degradation"
    | "_rateLimiter"
    | "_rpcClient"
    | "_adapter"
    | "_hooks"
    | "_retryOptions"
    | "_horizonReader"
    | "_idempotency"
    | "_pool"
    | "_effectiveRpcPoolSize"
    | "_batcher"
    | "_telemetryHookManager"
    | "_timeoutManager"
    | "_traceIdManager"
    | "_injectedRpcClient"
    | "server"
    | "_fireOnCreated"
    | "_fireOnPaid"
    | "_fireOnReleased"
    | "_fireOnRefunded"
    | "_fireOnCancelled"
    | "_doHealthCheck"
    | "_logAudit"
    | "_withTelemetry"
    | "use"
    | "removePlugin"
    | "getPlugins"
    | "setTelemetryHooks"
    | "clearTelemetryHooks"
    | "getTimeoutConfig"
    | "setDefaultTraceIdGenerator"
    | "_withCache"
    | "_fetchInvoice"
    | "_executeBulkInvoiceAction"
    | "_parseInvoice"
    | "_submitTx"
    | "_simulateView"
    | "_nftGateCache"
    | "_parseNftGateResult"
    | "_buildReceiptId"
    | "_getInvoiceExt"
    | "_needsCoCreatorApproval"
    | "_fetchPaymentHistory"
    | "_computeCountdown"
    | "_isRateLimited"
    | "_handleRateLimit"
  >
>;

interface MockSdkState {
  invoices: Map<string, Invoice>;
  // Add other state properties as needed
}

export function createMockSdk(overrides?: Partial<MockStellarSplitSDK>): MockStellarSplitSDK {
  const _state: MockSdkState = {
    invoices: new Map(),
  };

  const mockSdk = {
    __state: _state, // Expose internal state for testing

    // Mock public methods with vi.fn()
    healthCheck: vi.fn(async () => ({ rpcReachable: true, latencyMs: 10, network: "testnet", contractDeployed: true })),
    disputeInvoice: vi.fn(async (invoiceId: string) => ({ disputeId: `mock-dispute-${invoiceId}`, txHash: "mock-tx-hash" })),
    submitArbiterVote: vi.fn(async (vote: ArbiterVote) => ({ disputeId: `mock-dispute-${vote.invoiceId}`, txHash: "mock-tx-hash" })),
    resolveDispute: vi.fn(async (invoiceId: string, arbiter: string) => ({ disputeId: `mock-dispute-${invoiceId}`, txHash: "mock-tx-hash" })),
    raiseDispute: vi.fn(async (invoiceId: string) => ({ disputeId: `mock-dispute-${invoiceId}`, txHash: "mock-tx-hash" })),
    getDisputeStatus: vi.fn(async (invoiceId: string) => ({ invoiceId, disputed: false, arbiter: null, resolved: false, resolution: null })),
    createInvoice: vi.fn(async (params: CreateInvoiceParams) => {
      const newInvoice: Invoice = {
        id: `mock-invoice-${_state.invoices.size + 1}`,
        creator: params.creator,
        recipients: params.recipients,
        token: params.token,
        deadline: params.deadline,
        funded: 0n,
        payments: [],
        status: "Pending",
      };
      _state.invoices.set(newInvoice.id, newInvoice);
      return { invoiceId: newInvoice.id, txHash: "mock-tx-hash" };
    }),
    cloneInvoice: vi.fn(async (sourceId: string, overrides: Partial<Invoice> = {}) => {
      const sourceInvoice = _state.invoices.get(sourceId);
      if (!sourceInvoice) throw new Error("Invoice not found");
      const newInvoice: Invoice = {
        ...sourceInvoice,
        ...overrides,
        id: `mock-invoice-${_state.invoices.size + 1}`,
        clonedFrom: sourceId,
        payments: [],
        funded: 0n,
      };
      _state.invoices.set(newInvoice.id, newInvoice);
      return newInvoice.id;
    }),
    pay: vi.fn(async (params: PayParams) => {
      const invoice = _state.invoices.get(params.invoiceId);
      if (!invoice) throw new Error("Invoice not found");
      invoice.funded = (invoice.funded || 0n) + params.amount;
      invoice.payments.push({ payer: params.payer, amount: params.amount, timestamp: Date.now() });
      return { txHash: "mock-tx-hash" };
    }),
    batchCreateInvoices: vi.fn(async (params: CreateInvoiceParams[]) => {
      const invoiceIds: string[] = [];
      for (const p of params) {
        const newInvoice: Invoice = {
          id: `mock-invoice-${_state.invoices.size + 1}`,
          creator: p.creator,
          recipients: p.recipients,
          token: p.token,
          deadline: p.deadline,
          funded: 0n,
          payments: [],
          status: "Pending",
        };
        _state.invoices.set(newInvoice.id, newInvoice);
        invoiceIds.push(newInvoice.id);
      }
      return { invoiceIds, txHash: "mock-tx-hash" };
    }),
    getInvoice: vi.fn(async (invoiceId: string) => {
      const invoice = _state.invoices.get(invoiceId);
      if (invoice) return invoice;
      return {
        id: invoiceId,
        creator: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
        recipients: [],
        token: "native",
        deadline: Math.floor(Date.now() / 1000) + 86400,
        funded: 0n,
        payments: [],
        status: "Pending" as const,
      };
    }),
    getDedupStats: vi.fn(() => ({ deduped: 0, total: 0 })),
    checkCompliance: vi.fn(async (invoiceId: string) => ({ invoiceId, compliant: true, rules: [] })),
    getPayments: vi.fn(async (invoiceId: string) => {
      const invoice = _state.invoices.get(invoiceId);
      if (!invoice) return [];
      return invoice.payments;
    }),
    verifyCompletionProof: vi.fn(() => ({ valid: true })),
    reconcilePayments: vi.fn(async (invoiceId: string) => {
      const invoice = _state.invoices.get(invoiceId);
      if (!invoice) throw new Error("Invoice not found");
      return { invoiceId, invoice, invoiceFunded: invoice.funded, paymentRecordsTotal: invoice.funded, paymentEventsTotal: invoice.funded, fundedDiscrepancy: 0n, recordsMatchEvents: true, consistent: true, paymentEvents: [] };
    }),
    generateReceipt: vi.fn(async (invoiceId: string) => {
      const invoice = _state.invoices.get(invoiceId);
      if (!invoice) throw new Error("Invoice not found");
      return { receiptId: `mock-receipt-${invoiceId}`, invoiceId, creator: invoice.creator, recipients: invoice.recipients, payments: invoice.payments, totalAmount: invoice.funded, releasedAt: Date.now() };
    }),
    snapshotInvoice: vi.fn(async (invoiceId: string) => {
      const invoice = _state.invoices.get(invoiceId);
      if (!invoice) throw new Error("Invoice not found");
      return { ...invoice, timestamp: Date.now() };
    }),
    resolveBatch: vi.fn(async (ids: string[]) => {
      return ids.map(id => {
        const invoice = _state.invoices.get(id);
        if (invoice) return { invoiceId: id, success: true, invoice };
        return { invoiceId: id, success: false, error: "Invoice not found" };
      });
    }),
    checkNftGate: vi.fn(async (creatorAddress: string) => ({ gated: false, hasNft: true, contractAddress: null })),
    clearNftGateCache: vi.fn(() => {}),
    getForwardChain: vi.fn(async (invoiceId: string) => ([{ id: invoiceId, status: "Pending" }])),
    shutdown: vi.fn(async () => {}),
    bulkCancel: vi.fn(async (ids: string[]) => ids.map(id => ({ invoiceId: id, success: true }))),
    bulkArchive: vi.fn(async (ids: string[]) => ids.map(id => ({ invoiceId: id, success: true }))),
    bulkExport: vi.fn(async (ids: string[], format: ExportFormat) => {
      const result: Record<string, string> = {};
      for (const id of ids) {
        result[id] = `mock-export-format-${format}-for-${id}`;
      }
      return result;
    }),
    saveTemplate: vi.fn(async (creator: string, template: InvoiceTemplate) => ({ txHash: "mock-tx-hash" })),
    createFromTemplate: vi.fn(async (creator: string, templateName: string, deadline: number) => ({ invoiceId: `mock-invoice-from-template-${templateName}`, txHash: "mock-tx-hash" })),
    listTemplates: vi.fn(async (creator: string) => ([`template-for-${creator}`])),
    getRecurringInvoices: vi.fn(async (creator: string) => ([])),
    cancelRecurring: vi.fn(async (invoiceId: string, creator: string) => ({ txHash: "mock-tx-hash" })),
    updateRecurringAmount: vi.fn(async (invoiceId: string, creator: string, amounts: bigint[]) => ({ txHash: "mock-tx-hash" })),
    getInvoicesByCreator: vi.fn(async (creator: string, _options: PaginationOptions = {}) => ({
      items: Array.from(_state.invoices.values()).filter(inv => inv.creator === creator).map(inv => inv.id),
      nextCursor: null as string | null,
      total: Array.from(_state.invoices.values()).filter(inv => inv.creator === creator).length,
    })),
    getInvoicesByRecipient: vi.fn(async (recipient: string, _options: PaginationOptions = {}) => ({
      items: Array.from(_state.invoices.values()).filter(inv => inv.recipients.some(r => r.address === recipient)).map(inv => inv.id),
      nextCursor: null as string | null,
      total: Array.from(_state.invoices.values()).filter(inv => inv.recipients.some(r => r.address === recipient)).length,
    })),
    checkRPCHealth: vi.fn(async () => ({ rpcReachable: true, latencyMs: 10, network: "testnet", contractDeployed: true, error: undefined })),
    createGroup: vi.fn(async (creator: string, invoiceIds: string[]) => ({ groupId: "mock-group-id", txHash: "mock-tx-hash" })),
    getGroupStatus: vi.fn(async (groupId: string) => ({ groupId, status: "Active", invoiceIds: [], creator: "mock-creator" })),
    releaseGroup: vi.fn(async (creator: string, groupId: string) => ({ txHash: "mock-tx-hash" })),
    calculateFee: vi.fn(async (amount: bigint) => ({ fixed: 100n, percent: 1n, total: amount + 100n })),
    resolveToken: vi.fn(async (address: string) => ({ address, code: "XLM", issuer: null, decimals: 7 })),
    generatePaymentProof: vi.fn(async (txHash: string) => ({ proof: "mock-proof", txHash })),
    generatePaymentReceipt: vi.fn(async (invoiceId: string, payerAddress: string) => ({ receiptId: `mock-payment-receipt-${invoiceId}-${payerAddress}`, invoiceId, creator: "mock-creator", recipients: [], payments: [], totalAmount: 100n, releasedAt: Date.now() })),
    batchPay: vi.fn(async (payer: string, payments: BatchPayment[]) => ({ txHash: "mock-tx-hash" })),
    verifyBatchPay: vi.fn(async (payments: BatchPayment[]) => ({ allValid: true, results: payments.map(p => ({ invoiceId: p.invoiceId, valid: true })) })),
    validatePayment: vi.fn(async (invoiceId: string, payerAddress: string, amount: bigint) => ({ valid: true, issues: [] })),
    buildTransaction: vi.fn(async (sourceAddress: string, operations: any[]) => ({ xdr: "mock-xdr-transaction" })),
    submitTransaction: vi.fn(async (signedXdr: string) => ({ txHash: "mock-tx-hash" })),
    simulateCreateInvoice: vi.fn(async (params: CreateInvoiceParams) => ({ success: true, error: undefined, result: { invoiceId: "mock-sim-invoice-id", txHash: "mock-sim-tx-hash" } })),
    simulatePay: vi.fn(async (params: PayParams) => ({ success: true, error: undefined, result: { txHash: "mock-sim-tx-hash" } })),
    previewTokenSwap: vi.fn(async (invoiceId: string, sellAmount: bigint, sellToken: string, buyToken: string) => ({ minReceived: 100n, price: 1.0 })),
    estimateFee: vi.fn(async (operation: any) => ({ fixed: 100n, network: 100n, total: 200n })),
    collectSignatures: vi.fn(async (xdrStr: string, signers: string[]) => "mock-signed-xdr"),
    bumpStorageTtl: vi.fn(async (invoiceId: string, options?: TtlExtensionOptions) => ({ invoiceId, newTtl: Date.now() + 1000 })),
    bumpStorageTtlBatch: vi.fn(async (options: TtlExtensionOptions) => ([{ invoiceId: "mock-invoice-id", newTtl: Date.now() + 1000 }])),
    collectCoSignatures: vi.fn(async (invoiceId: string, signers: string[]) => "mock-co-signed-xdr"),
    submitWithCoSignatures: vi.fn(async (invoiceId: string, signatures: CoSignature[]) => ({ txHash: "mock-tx-hash" })),
    rolloverInvoice: vi.fn(async (invoiceId: string, newDeadline: number, caller: string) => ({ txHash: "mock-tx-hash", newInvoiceId: "mock-new-invoice-id" })),
    submitCoCreatorApproval: vi.fn(async (invoiceId: string, signer: string) => ({ txHash: "mock-tx-hash" })),
    getCoCreatorApprovals: vi.fn(async (invoiceId: string) => (["mock-signer-address"])),
    revokeCoCreatorApproval: vi.fn(async (invoiceId: string, signer: string) => ({ txHash: "mock-tx-hash" })),
    getPaymentCooldown: vi.fn(async (invoiceId: string, payerAddress: string) => ({ remainingSeconds: 0, canPay: true })),
    placeBid: vi.fn(async (bidder: string, invoiceId: string, amount: bigint) => ({ txHash: "mock-tx-hash" })),
    getPaymentHistory: vi.fn(async (invoiceId: string) => {
      const invoice = _state.invoices.get(invoiceId);
      return invoice ? invoice.payments : [];
    }),
    settleAuction: vi.fn(async (caller: string, invoiceId: string) => ({ txHash: "mock-tx-hash" })),
    getAuctionInfo: vi.fn(async (invoiceId: string) => ({ invoiceId, highestBid: 0n, highestBidder: null, endTime: Date.now() + 10000 })),
    adminFreeze: vi.fn(async (invoiceId: string, admin: string) => ({ txHash: "mock-tx-hash" })),
    queueAction: vi.fn(async (params: QueueActionParams) => ({ txHash: "mock-tx-hash", actionId: "mock-action-id" })),
    adminUnfreeze: vi.fn(async (invoiceId: string, admin: string) => ({ txHash: "mock-tx-hash" })),
    executeAction: vi.fn(async (caller: string, actionId: string) => ({ txHash: "mock-tx-hash" })),
    getCrossChainRef: vi.fn(async (invoiceId: string) => (null)),
    cancelAction: vi.fn(async (caller: string, actionId: string) => ({ txHash: "mock-tx-hash" })),
    setCrossChainRef: vi.fn(async (params: SetCrossChainRefParams) => ({ txHash: "mock-tx-hash" })),
    getActionStatus: vi.fn(async (actionId: string) => ({ actionId, status: "Pending", actionType: "transfer", invoiceId: "mock-invoice-id" })),
    getVelocityStatus: vi.fn(async (invoiceId: string, address: string) => ({ currentVelocity: 0n, velocityLimit: 10000n, exceeded: false, remaining: 10000n })),
    getCreatorVolumeCap: vi.fn(async (address: string) => 1000000n),
    getCreatorVolumeUsed: vi.fn(async (address: string) => 50000n),
    getRemainingCreatorVolume: vi.fn(async (address: string) => 950000n),
    createInvoiceBatch: vi.fn(async (items: CreateInvoiceParams[]) => ({ invoiceIds: items.map((_, i) => `mock-batch-invoice-${i}`), txHash: "mock-tx-hash" })),
    getLeaderboard: vi.fn(async (_opts?: { timeout?: number; traceId?: string }) => ([] as { creator: string; invoiceCount: number; totalVolume: bigint }[])),
    getInvoiceHistory: vi.fn(async (invoiceId: string, _opts?: { timeout?: number; traceId?: string }) => ([] as Payment[])),
    refundInvoice: vi.fn(async (invoiceId: string, creator: string, recipient: string, amount: bigint) => ({ txHash: "mock-tx-hash" })),
    getClaimableRefunds: vi.fn(async (payer: string) => ([])),
    syncInvoice: vi.fn(async (invoiceId: string) => ({
      invoice: _state.invoices.get(invoiceId) || ({} as Invoice), // Return a dummy or actual invoice
      source: "mock-source",
      ledger: 12345,
    })),
    getPendingPayout: vi.fn(async (invoiceId: string, recipient: string) => 0n),
    claimPendingPayout: vi.fn(async (invoiceId: string, recipient: string) => ({ txHash: "mock-tx-hash", claimedAmount: 100n })),
    payWithAttestation: vi.fn(async (params: PayWithAttestationParams) => ({ txHash: "mock-tx-hash", invoiceId: params.invoiceId, amount: params.amount, attestationHash: "mock-attestation-hash" })),
    getAccount: vi.fn(async (address: string) => ({ address, balance: 10000000000n, sequence: "123" })),
    getAccountBalances: vi.fn(async (address: string) => ([{ asset: "XLM", balance: 10000000000n, assetType: "native" }])),
    adminFreezeInvoice: vi.fn(async (invoiceId: string, _reason: string, adminKeypair: Keypair) => ({ txHash: "mock-tx-hash", invoiceId, adminAddress: adminKeypair.publicKey(), reason: _reason, timestamp: Date.now() })),
    adminUnfreezeInvoice: vi.fn(async (invoiceId: string, _reason: string, adminKeypair: Keypair) => ({ txHash: "mock-tx-hash", invoiceId, adminAddress: adminKeypair.publicKey(), timestamp: Date.now() })),
    setBatchingEnabled: vi.fn((_enabled: boolean) => {}),
  };

  return { ...mockSdk, ...overrides } as unknown as MockStellarSplitSDK;
}

// We need a global Jest/Vitest mock function to ensure `vi.fn()` works.
// In a real test environment, this would be provided by Jest/Vitest.
declare const jest: {
  fn: <T extends (...args: any[]) => any>(implementation?: T) => T & {
    mock: {
      calls: Parameters<T>[];
      results: Array<{ type: "return"; value: Awaited<ReturnType<T>> } | { type: "throw"; value: any }>;
      // Add other mock properties as needed, like mockResolvedValueOnce
      mockResolvedValueOnce: (value: Awaited<ReturnType<T>>) => any;
      mockReturnValueOnce: (value: ReturnType<T>) => any;
      mockImplementation: (fn: T) => any;
      mockImplementationOnce: (fn: T) => any;
      mockClear: () => void;
      mockReset: () => void;
      mockRestore: () => void;
    };
  };
};
