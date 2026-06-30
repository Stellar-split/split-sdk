import type { Invoice, Payment, TxResult, CreateInvoiceParams, DisputeResult, HealthCheckResult, InvoiceReceipt, BatchResolveResult, NftGateResult, InvoiceStatus, PaymentReconciliationReport, InvoiceSnapshot, BulkResult, InvoiceTemplate, PaginatedResult, PaginationOptions, ScheduledReleaseCountdown, CompletionProof, ClaimPayoutResult, PayWithAttestationParams, AttestationPaymentReceipt, SetCrossChainRefParams, AuctionInfo, QueueActionParams, TimelockAction, CrossChainRef, VelocityStatus, FeeBreakdown, TokenInfo, PaymentProof, BatchPayment, PaymentValidation, SimulateCreateInvoiceResult, SimulatePayResult, FeeEstimate, TtlExtensionOptions, TtlExtensionResult, CoSignature, PaymentCooldown, NormalizedAccount, NormalizedBalance, ComplianceReport, ComplianceRule, TelemetryHooks, SdkPlugin, StellarSplitClientConfig } from "../types.js";
import { SorobanRpc, Transaction, TransactionBuilder, BASE_FEE, nativeToScVal, scValToNative, xdr, Keypair } from "@stellar/stellar-sdk";

// Minimal mock for Contract to allow type checking without full implementation
class MockContract {
  call = jest.fn((_method: string, ..._args: any[]) => ({ type: "mock" }));
}

// Minimal mock for SorobanRpc.Server
class MockSorobanRpcServer {
  getLatestLedger = jest.fn(() => Promise.resolve({ sequence: 100 }));
  getNetwork = jest.fn(() => Promise.resolve({ passphrase: "Test SDF Network ; September 2015" }));
  getContractWasmByContractId = jest.fn(() => Promise.resolve({ wasm: "mock_wasm" }));
  simulateTransaction = jest.fn((_tx: Transaction) => Promise.resolve({}));
  getAccount = jest.fn((_accountId: string) => Promise.resolve({ sequenceNumber: () => "123", incrementSequenceNumber: () => {} }));
}

// Utility type to mock all methods of a class/interface with JestMocks
type Mocked<T> = {
  [P in keyof T]: T[P] extends (...args: infer A) => infer R
    ? ((...args: A) => Promise<Awaited<R>>) & jest.Mock<Awaited<R>, A>
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

    // Mock public methods with jest.fn()
    healthCheck: jest.fn(async () => ({ rpcReachable: true, latencyMs: 10, network: "testnet", contractDeployed: true })),
    disputeInvoice: jest.fn(async (invoiceId: string) => ({ disputeId: `mock-dispute-${invoiceId}`, txHash: "mock-tx-hash" })),
    submitArbiterVote: jest.fn(async (vote: ArbiterVote) => ({ disputeId: `mock-dispute-${vote.invoiceId}`, txHash: "mock-tx-hash" })),
    resolveDispute: jest.fn(async (invoiceId: string, arbiter: string) => ({ disputeId: `mock-dispute-${invoiceId}`, txHash: "mock-tx-hash" })),
    raiseDispute: jest.fn(async (invoiceId: string) => ({ disputeId: `mock-dispute-${invoiceId}`, txHash: "mock-tx-hash" })),
    getDisputeStatus: jest.fn(async (invoiceId: string) => ({ invoiceId, disputed: false, arbiter: null, resolved: false, resolution: null })),
    createInvoice: jest.fn(async (params: CreateInvoiceParams) => {
      const newInvoice: Invoice = {
        id: `mock-invoice-${_state.invoices.size + 1}`,
        creator: params.creator,
        recipients: params.recipients,
        token: params.token,
        deadline: params.deadline,
        funded: 0n,
        payments: [],
        status: "Pending",
        hash: "mock-hash",
        createdAt: Date.now(),
        updatedAt: Date.now(),
      };
      _state.invoices.set(newInvoice.id, newInvoice);
      return { invoiceId: newInvoice.id, txHash: "mock-tx-hash" };
    }),
    cloneInvoice: jest.fn(async (sourceId: string, overrides: Partial<Invoice> = {}) => {
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
    pay: jest.fn(async (params: PayParams) => {
      const invoice = _state.invoices.get(params.invoiceId);
      if (!invoice) throw new Error("Invoice not found");
      invoice.funded = (invoice.funded || 0n) + params.amount;
      invoice.payments.push({ payer: params.payer, amount: params.amount, timestamp: Date.now() });
      return { txHash: "mock-tx-hash" };
    }),
    batchCreateInvoices: jest.fn(async (params: CreateInvoiceParams[]) => {
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
          hash: "mock-hash",
          createdAt: Date.now(),
          updatedAt: Date.now(),
        };
        _state.invoices.set(newInvoice.id, newInvoice);
        invoiceIds.push(newInvoice.id);
      }
      return { invoiceIds, txHash: "mock-tx-hash" };
    }),
    getInvoice: jest.fn(async (invoiceId: string) => {
      const invoice = _state.invoices.get(invoiceId);
      if (!invoice) throw new Error("Invoice not found");
      return invoice;
    }),
    getDedupStats: jest.fn(() => ({ deduped: 0, total: 0 })),
    checkCompliance: jest.fn(async (invoiceId: string) => ({ invoiceId, compliant: true, rules: [] })),
    getPayments: jest.fn(async (invoiceId: string) => {
      const invoice = _state.invoices.get(invoiceId);
      if (!invoice) return [];
      return invoice.payments;
    }),
    verifyCompletionProof: jest.fn(() => ({ valid: true })),
    reconcilePayments: jest.fn(async (invoiceId: string) => {
      const invoice = _state.invoices.get(invoiceId);
      if (!invoice) throw new Error("Invoice not found");
      return { invoiceId, invoice, invoiceFunded: invoice.funded, paymentRecordsTotal: invoice.funded, paymentEventsTotal: invoice.funded, fundedDiscrepancy: 0n, recordsMatchEvents: true, consistent: true, paymentEvents: [] };
    }),
    generateReceipt: jest.fn(async (invoiceId: string) => {
      const invoice = _state.invoices.get(invoiceId);
      if (!invoice) throw new Error("Invoice not found");
      return { receiptId: `mock-receipt-${invoiceId}`, invoiceId, creator: invoice.creator, recipients: invoice.recipients, payments: invoice.payments, totalAmount: invoice.funded, releasedAt: Date.now() };
    }),
    snapshotInvoice: jest.fn(async (invoiceId: string) => {
      const invoice = _state.invoices.get(invoiceId);
      if (!invoice) throw new Error("Invoice not found");
      return { ...invoice, timestamp: Date.now() };
    }),
    resolveBatch: jest.fn(async (ids: string[]) => {
      return ids.map(id => {
        const invoice = _state.invoices.get(id);
        if (invoice) return { invoiceId: id, success: true, invoice };
        return { invoiceId: id, success: false, error: "Invoice not found" };
      });
    }),
    checkNftGate: jest.fn(async (creatorAddress: string) => ({ gated: false, hasNft: true, contractAddress: null })),
    clearNftGateCache: jest.fn(() => {}),
    getForwardChain: jest.fn(async (invoiceId: string) => ([{ id: invoiceId, status: "Pending" }])),
    shutdown: jest.fn(async () => {}),
    bulkCancel: jest.fn(async (ids: string[]) => ids.map(id => ({ invoiceId: id, success: true }))),
    bulkArchive: jest.fn(async (ids: string[]) => ids.map(id => ({ invoiceId: id, success: true }))),
    bulkExport: jest.fn(async (ids: string[], format: ExportFormat) => {
      const result: Record<string, string> = {};
      for (const id of ids) {
        result[id] = `mock-export-format-${format}-for-${id}`;
      }
      return result;
    }),
    saveTemplate: jest.fn(async (creator: string, template: InvoiceTemplate) => ({ txHash: "mock-tx-hash" })),
    createFromTemplate: jest.fn(async (creator: string, templateName: string, deadline: number) => ({ invoiceId: `mock-invoice-from-template-${templateName}`, txHash: "mock-tx-hash" })),
    listTemplates: jest.fn(async (creator: string) => ([`template-for-${creator}`])),
    getRecurringInvoices: jest.fn(async (creator: string) => ([])),
    cancelRecurring: jest.fn(async (invoiceId: string, creator: string) => ({ txHash: "mock-tx-hash" })),
    updateRecurringAmount: jest.fn(async (invoiceId: string, creator: string, amounts: bigint[]) => ({ txHash: "mock-tx-hash" })),
    getInvoicesByCreator: jest.fn(async (creator: string, options: PaginationOptions = {}) => ({
      items: Array.from(_state.invoices.values()).filter(inv => inv.creator === creator).map(inv => inv.id),
      nextCursor: null,
      total: Array.from(_state.invoices.values()).filter(inv => inv.creator === creator).length,
    })),
    getInvoicesByRecipient: jest.fn(async (recipient: string, options: PaginationOptions = {}) => ({
      items: Array.from(_state.invoices.values()).filter(inv => inv.recipients.some(r => r.address === recipient)).map(inv => inv.id),
      nextCursor: null,
      total: Array.from(_state.invoices.values()).filter(inv => inv.recipients.some(r => r.address === recipient)).length,
    })),
    checkRPCHealth: jest.fn(async () => ({ rpcReachable: true, latencyMs: 10, network: "testnet", contractDeployed: true, error: undefined })),
    createGroup: jest.fn(async (creator: string, invoiceIds: string[]) => ({ groupId: "mock-group-id", txHash: "mock-tx-hash" })),
    getGroupStatus: jest.fn(async (groupId: string) => ({ groupId, status: "Active", invoiceIds: [], creator: "mock-creator" })),
    releaseGroup: jest.fn(async (creator: string, groupId: string) => ({ txHash: "mock-tx-hash" })),
    calculateFee: jest.fn(async (amount: bigint) => ({ fixed: 100n, percent: 1n, total: amount + 100n })),
    resolveToken: jest.fn(async (address: string) => ({ address, code: "XLM", issuer: null, decimals: 7 })),
    generatePaymentProof: jest.fn(async (txHash: string) => ({ proof: "mock-proof", txHash })),
    generatePaymentReceipt: jest.fn(async (invoiceId: string, payerAddress: string) => ({ receiptId: `mock-payment-receipt-${invoiceId}-${payerAddress}`, invoiceId, creator: "mock-creator", recipients: [], payments: [], totalAmount: 100n, releasedAt: Date.now() })),
    batchPay: jest.fn(async (payer: string, payments: BatchPayment[]) => ({ txHash: "mock-tx-hash" })),
    verifyBatchPay: jest.fn(async (payments: BatchPayment[]) => ({ allValid: true, results: payments.map(p => ({ invoiceId: p.invoiceId, valid: true })) })),
    validatePayment: jest.fn(async (invoiceId: string, payerAddress: string, amount: bigint) => ({ valid: true, issues: [] })),
    buildTransaction: jest.fn(async (sourceAddress: string, operations: any[]) => ({ xdr: "mock-xdr-transaction" })),
    submitTransaction: jest.fn(async (signedXdr: string) => ({ txHash: "mock-tx-hash" })),
    simulateCreateInvoice: jest.fn(async (params: CreateInvoiceParams) => ({ success: true, error: undefined, result: { invoiceId: "mock-sim-invoice-id", txHash: "mock-sim-tx-hash" } })),
    simulatePay: jest.fn(async (params: PayParams) => ({ success: true, error: undefined, result: { txHash: "mock-sim-tx-hash" } })),
    previewTokenSwap: jest.fn(async (invoiceId: string, sellAmount: bigint, sellToken: string, buyToken: string) => ({ minReceived: 100n, price: 1.0 })),
    estimateFee: jest.fn(async (operation: any) => ({ fixed: 100n, network: 100n, total: 200n })),
    collectSignatures: jest.fn(async (xdrStr: string, signers: string[]) => "mock-signed-xdr"),
    bumpStorageTtl: jest.fn(async (invoiceId: string, options?: TtlExtensionOptions) => ({ invoiceId, newTtl: Date.now() + 1000 })),
    bumpStorageTtlBatch: jest.fn(async (options: TtlExtensionOptions) => ([{ invoiceId: "mock-invoice-id", newTtl: Date.now() + 1000 }])),
    collectCoSignatures: jest.fn(async (invoiceId: string, signers: string[]) => "mock-co-signed-xdr"),
    submitWithCoSignatures: jest.fn(async (invoiceId: string, signatures: CoSignature[]) => ({ txHash: "mock-tx-hash" })),
    rolloverInvoice: jest.fn(async (invoiceId: string, newDeadline: number) => ({ txHash: "mock-tx-hash", newInvoiceId: "mock-new-invoice-id" })),
    submitCoCreatorApproval: jest.fn(async (invoiceId: string, signer: string) => ({ txHash: "mock-tx-hash" })),
    getCoCreatorApprovals: jest.fn(async (invoiceId: string) => (["mock-signer-address"])),
    revokeCoCreatorApproval: jest.fn(async (invoiceId: string, signer: string) => ({ txHash: "mock-tx-hash" })),
    getPaymentCooldown: jest.fn(async (invoiceId: string, payerAddress: string) => ({ remainingSeconds: 0, canPay: true })),
    placeBid: jest.fn(async (bidder: string, invoiceId: string, amount: bigint) => ({ txHash: "mock-tx-hash" })),
    getPaymentHistory: jest.fn(async (invoiceId: string) => {
      const invoice = _state.invoices.get(invoiceId);
      return invoice ? invoice.payments : [];
    }),
    settleAuction: jest.fn(async (caller: string, invoiceId: string) => ({ txHash: "mock-tx-hash" })),
    getAuctionInfo: jest.fn(async (invoiceId: string) => ({ invoiceId, highestBid: 0n, highestBidder: null, endTime: Date.now() + 10000 })),
    adminFreeze: jest.fn(async (invoiceId: string, admin: string) => ({ txHash: "mock-tx-hash" })),
    queueAction: jest.fn(async (params: QueueActionParams) => ({ txHash: "mock-tx-hash", actionId: "mock-action-id" })),
    adminUnfreeze: jest.fn(async (invoiceId: string, admin: string) => ({ txHash: "mock-tx-hash" })),
    executeAction: jest.fn(async (caller: string, actionId: string) => ({ txHash: "mock-tx-hash" })),
    getCrossChainRef: jest.fn(async (invoiceId: string) => (null)),
    cancelAction: jest.fn(async (caller: string, actionId: string) => ({ txHash: "mock-tx-hash" })),
    setCrossChainRef: jest.fn(async (params: SetCrossChainRefParams) => ({ txHash: "mock-tx-hash" })),
    getActionStatus: jest.fn(async (actionId: string) => ({ actionId, status: "Pending", actionType: "transfer", invoiceId: "mock-invoice-id" })),
    getVelocityStatus: jest.fn(async (invoiceId: string, address: string) => ({ currentVelocity: 0n, velocityLimit: 10000n, exceeded: false, remaining: 10000n })),
    getCreatorVolumeCap: jest.fn(async (address: string) => 1000000n),
    getCreatorVolumeUsed: jest.fn(async (address: string) => 50000n),
    getRemainingCreatorVolume: jest.fn(async (address: string) => 950000n),
    createInvoiceBatch: jest.fn(async (items: CreateInvoiceParams[]) => ({ invoiceIds: items.map((_, i) => `mock-batch-invoice-${i}`), txHash: "mock-tx-hash" })),
    getLeaderboard: jest.fn(async (opts?: { timeout?: number; traceId?: string }) => ([])), // Default to empty array
    getInvoiceHistory: jest.fn(async (invoiceId: string, opts?: PaginationOptions) => ({ items: [], nextCursor: null, total: 0 })),
    refundInvoice: jest.fn(async (invoiceId: string, creator: string, recipient: string, amount: bigint) => ({ txHash: "mock-tx-hash" })),
    getClaimableRefunds: jest.fn(async (payer: string) => ([])),
    syncInvoice: jest.fn(async (invoiceId: string) => ({
      invoice: _state.invoices.get(invoiceId) || ({} as Invoice), // Return a dummy or actual invoice
      source: "mock-source",
      ledger: 12345,
    })),
    getPendingPayout: jest.fn(async (invoiceId: string, recipient: string) => 0n),
    claimPendingPayout: jest.fn(async (invoiceId: string, recipient: string) => ({ txHash: "mock-tx-hash", claimedAmount: 100n })),
    payWithAttestation: jest.fn(async (params: PayWithAttestationParams) => ({ receiptId: "mock-attestation-receipt", invoiceId: params.invoiceId, creator: "mock-creator", recipients: [], payments: [], totalAmount: params.amount, releasedAt: Date.now(), attestation: params.attestation })),
    getAccount: jest.fn(async (address: string) => ({ address, balance: 10000000000n, sequence: "123" })),
    getAccountBalances: jest.fn(async (address: string) => ([{ asset: "XLM", balance: 10000000000n, assetType: "native" }])),
  };

  return { ...mockSdk, ...overrides };
}

// We need a global Jest/Vitest mock function to ensure `jest.fn()` works.
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
