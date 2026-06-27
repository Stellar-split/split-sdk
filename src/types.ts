/** Result of a dispute-related transaction. */
export interface DisputeResult {
  disputeId: string;
  txHash: string;
}

/** Error thrown when an invoice is not found. */
export class InvoiceNotFoundError extends Error {
  constructor(invoiceId: string) {
    super(`Invoice not found: ${invoiceId}`);
    this.name = "InvoiceNotFoundError";
  }
}

/** Result of an approval check. */
export interface ApprovalResult {
  approved: boolean;
  reason?: string;
}

/** Parameters for an arbiter's vote on a dispute. */
export interface ArbiterVote {
  invoiceId: string;
  arbiter: string;
  approve: boolean;
}
/** Lifecycle status of an invoice. */
export type InvoiceStatus = "Pending" | "Released" | "Refunded" | "Cancelled";

/** Error thrown for invalid invoice state transitions. */
export class InvalidTransitionError extends Error {
  constructor(from: InvoiceStatus, to: InvoiceStatus) {
    super(`Invalid transition from "${from}" to "${to}"`);
    this.name = "InvalidTransitionError";
  }
}

/** Result of comparing two invoices. */
export interface InvoiceDiff {
  changed: Array<{
    field: string;
    from: unknown;
    to: unknown;
  }>;
}

/** Aggregated SDK health metrics. */
export interface SDKHealth {
  rpcLatency: number;
  cacheHitRate: number;
  errorRate: number;
  uptimeMs: number;
}

/** A single payment made toward an invoice. */
export interface Payment {
  /** Stellar address of the payer. */
  payer: string;
  /** Amount paid in stroops (1 XLM = 10_000_000 stroops). */
  amount: bigint;
  /** Ledger sequence number where the payment was recorded. */
  ledger?: number;
  /** Unix timestamp in seconds when the payment was made (optional). */
  timestamp?: number;
  /** When true, funds are donated rather than refunded on invoice failure. */
  donateOnFailure?: boolean;
}

/** A payment event reconstructed from contract event history. */
export interface PaymentEventRecord extends Payment {
  /** Ledger sequence when the event was emitted. */
  ledger: number;
}

/** Result of reconciling invoice payments with contract events. */
export interface PaymentReconciliationReport {
  invoiceId: string;
  invoice: Invoice;
  invoiceFunded: bigint;
  paymentRecordsTotal: bigint;
  paymentEventsTotal: bigint;
  fundedDiscrepancy: bigint;
  recordsMatchEvents: boolean;
  consistent: boolean;
  paymentEvents: PaymentEventRecord[];
}

/** An archived invoice record. */
export interface ArchivedInvoice {
  /** Invoice ID. */
  invoiceId: string;
  /** Unix timestamp in seconds when the invoice was archived. */
  archivedAt: number;
}

/** A recipient and their owed share. */
export interface Recipient {
  /** Stellar address of the recipient. */
  address: string;
  /** Amount owed in stroops. */
  amount: bigint;
}

/** An on-chain StellarSplit invoice. */
export interface Invoice {
  /** Invoice ID (u64 from the contract). */
  id: string;
  /** Address that created the invoice. */
  creator: string;
  /** Ordered list of recipients with their owed amounts. */
  recipients: Recipient[];
  /** USDC token contract address. */
  token: string;
  /** Unix timestamp deadline (seconds). */
  deadline: number;
  /** Total amount funded so far in stroops. */
  funded: bigint;
  /** Current lifecycle status. */
  status: InvoiceStatus;
  /** All payments recorded on-chain. */
  payments: Payment[];
  /** Whether this is a recurring invoice. */
  recurring?: boolean;
  /** Optional memo / description attached to the invoice. */
  memo?: string;
  /** ID of the source invoice this was cloned from. */
  clonedFrom?: string;
  /** ID of the group this invoice belongs to. */
  groupId?: string;
  /** Ledger sequence when this invoice was last modified. */
  lastModifiedLedger?: number;
  /** IDs of invoices that must be paid before this one. */
  prerequisites?: string[];
  /** ID of the parent invoice this was cloned from (clone chain). */
  parentInvoiceId?: string;
  /** Depth in the clone chain (0 = root, 1 = cloned from root, etc.). */
  cloneDepth?: number;
  /** The address of the NFT contract used for gating, if any. */
  nft_gate?: string;
  /** ID of the next invoice in the forward chain, if any. */
  forward_invoice_id?: string;
  /** Unix timestamp after which penalties apply. */
  penalty_deadline?: number;
  /** Configured penalty tiers for late payments. */
  penalty_tiers?: { days_late: number; penalty_bps: number }[];
  /** List of caller addresses permitted to interact, or null if open. */
  allowed_callers?: string[] | null;
}

export interface InvoiceLifecycleHooks {
  onCreated?: (invoice: Invoice) => void;
  onPaid?: (invoice: Invoice, payment: Payment) => void;
  onReleased?: (invoice: Invoice) => void;
  onRefunded?: (invoice: Invoice) => void;
  onCancelled?: (invoice: Invoice) => void;
}

/** Invoice receipt returned after a successful release. */
export interface InvoiceReceipt {
  /** Deterministic receipt identifier. */
  receiptId: string;
  /** Invoice ID this receipt belongs to. */
  invoiceId: string;
  /** Address that created the invoice. */
  creator: string;
  /** Ordered list of recipients with their owed amounts. */
  recipients: Recipient[];
  /** All payments recorded on-chain. */
  payments: Payment[];
  /** Total amount paid in stroops. */
  totalAmount: bigint;
  /** Timestamp when the receipt was generated. */
  releasedAt: number;
}

/** Parameters for creating an invoice. */
export interface CreateInvoiceParams {
  /** Stellar address of the creator (must sign). */
  creator: string;
  /** Recipients and their owed amounts. */
  recipients: Recipient[];
  /** USDC token contract address. */
  token: string;
  /** Unix timestamp deadline (seconds). */
  deadline: number;
}

/** Generic hardware/software wallet adapter interface. */
export interface WalletAdapter {
  /** Return the Stellar public key (G... address) from the device. */
  getAddress(): Promise<string>;
  /**
   * Sign a Stellar transaction XDR string.
   *
   * @param xdr     - Base64-encoded transaction XDR.
   * @param network - Network passphrase.
   * @returns Signed transaction XDR.
   */
  signTransaction(xdr: string, network: string): Promise<string>;
}

/** Parameters for paying toward an invoice. */
export interface PayParams {
  /** Stellar address of the payer (must sign). */
  payer: string;
  /** Invoice ID to pay toward. */
  invoiceId: string;
  /** Amount to pay in stroops. */
  amount: bigint;
  /**
   * When true, the funds are donated rather than refunded if the invoice
   * fails to reach its goal. Defaults to false.
   */
  donateOnFailure?: boolean;
}

/** @deprecated Use PayParams instead. */
export type PaymentOptions = PayParams;

/** Options for paginated queries. */
export interface PaginationOptions {
  /** Cursor (invoice ID) to start after. */
  cursor?: string;
  /** Maximum number of items to return. Defaults to 20. */
  limit?: number;
}

/** A page of results with a cursor for the next page. */
export interface PaginatedResult<T> {
  items: T[];
  nextCursor: string | null;
  total: number;
}

/** A group of linked invoices. */
export interface InvoiceGroup {
  groupId: string;
  invoiceIds: string[];
  allFunded: boolean;
}

/** Invoice receipt returned after a successful release. */
export interface InvoiceReceipt {
  /** Deterministic receipt identifier. */
  receiptId: string;
  /** Invoice ID this receipt belongs to. */
  invoiceId: string;
  /** Address that created the invoice. */
  creator: string;
  /** Ordered list of recipients with their owed amounts. */
  recipients: Recipient[];
  /** All payments recorded on-chain. */
  payments: Payment[];
  /** Total amount paid in stroops. */
  totalAmount: bigint;
  /** Timestamp when the receipt was generated. */
  releasedAt: number;
}

/** An invoice template for reuse. */
export interface InvoiceTemplate {
  /** Template name. */
  name: string;
  /** Recipients and their owed amounts. */
  recipients: Recipient[];
  /** USDC token contract address. */
  token: string;
}

/** Health status of the RPC endpoint. */
export interface RPCHealth {
  status: "ok" | "degraded" | "down";
  latencyMs: number;
  blockHeight: number;
  timestamp: number;
}

/** Event emitted when a contract WASM upgrade is detected. */
export interface UpgradeEvent {
  previousHash: string;
  newHash: string;
  detectedAt: number;
}

/** A single payment in a batch pay operation. */
export interface BatchPayment {
  /** Invoice ID to pay toward. */
  invoiceId: string;
  /** Amount to pay in stroops. */
  amount: bigint;
}

/** Callbacks for invoice event streaming. */
export interface InvoiceEventCallbacks {
  /** Fired when a payment event is detected. */
  onPayment?: (payment: Payment) => void;
  /** Fired when the invoice status changes to Released. */
  onReleased?: () => void;
  /** Fired when the invoice status changes to Refunded. */
  onRefunded?: () => void;
}

/** Result of a dry-run simulation for createInvoice. */
export interface SimulateCreateInvoiceResult {
  /** The invoice ID that would be created. */
  invoiceId: string;
  /** Estimated fee in stroops. */
  fee: string;
}

/** Result of a dry-run simulation for pay. */
export interface SimulatePayResult {
  /** Estimated fee in stroops. */
  fee: string;
}

/** Result of SDK/contract version negotiation. */
export interface VersionInfo {
  contractVersion: string;
  sdkVersion: string;
  compatible: boolean;
}

/** Optional lifecycle hooks fired by StellarSplitClient methods. */
export interface InvoiceLifecycleHooks {
  onCreated?: (invoice: Invoice) => void;
  onPaid?: (invoice: Invoice, payment: Payment) => void;
  onReleased?: (invoice: Invoice) => void;
  onRefunded?: (invoice: Invoice) => void;
  onCancelled?: (invoice: Invoice) => void;
}

/** Fee breakdown for a payment amount. */
export interface FeeBreakdown {
  /** Gross amount before fee deduction. */
  gross: bigint;
  /** Protocol fee amount. */
  fee: bigint;
  /** Net amount recipient receives. */
  net: bigint;
  /** Fee basis points (1 bps = 0.01%). */
  feeBps: number;
}

/** Token metadata information. */
export interface TokenInfo {
  /** Token contract address. */
  address: string;
  /** Token symbol (e.g., "USDC"). */
  symbol: string;
  /** Token name (e.g., "USD Coin"). */
  name: string;
  /** Number of decimal places. */
  decimals: number;
}

/** Event fired when an invoice is expiring or has expired. */
export interface ExpiryEvent {
  /** Invoice ID. */
  invoiceId: string;
  /** Unix timestamp deadline (seconds). */
  deadline: number;
  /** Seconds remaining until deadline. */
  secondsRemaining: number;
  /** True if deadline has passed. */
  expired: boolean;
}

/** Callback function for expiry events. */
export type ExpiryCallback = (event: ExpiryEvent) => void;

/** Cryptographic proof of a payment. */
export interface PaymentProof {
  /** Transaction hash. */
  txHash: string;
  /** Payer's Stellar address. */
  payer: string;
  /** Invoice ID. */
  invoiceId: string;
  /** Amount paid in stroops. */
  amount: bigint;
  /** Ledger sequence number. */
  ledger: number;
  /** SHA-256 hash of proof fields. */
  proofHash: string;
}

/** Result of resolving a batch of invoices. */
export interface BatchResolveResult {
  invoiceId: string;
  success: boolean;
  error?: string;
}

export type BulkResult =
  | ({ invoiceId: string } & { success: true })
  | ({ invoiceId: string } & { success: false; error: string });

export interface PaymentValidation {
  valid: boolean;
  errors: string[];
}

/** Result of a sync operation. */
export interface SyncResult {
  synced: number;
  failed: number;
  errors: string[];
}

/** Strategy for resolving conflicting invoice states. */
export type ConflictStrategy = "remote-wins" | "local-wins" | "latest-ledger";

/** Memory usage report from the memory profiler. */
export interface MemoryReport {
  cacheEntries: number;
  listenerCount: number;
  estimatedKB: number;
  warnings: string[];
}

/** Overflow behavior for cloned invoices when payment exceeds remaining. */
export type OverflowBehavior = "refund" | "rollback" | "escalate";

/** Overrides for cloning an invoice. All fields are optional. */
export interface CloneOverrides {
  newDeadline?: number;
  newAmounts?: bigint[];
  newRecipients?: string[];
  newOverflowBehavior?: OverflowBehavior;
}

/** Extended invoice data from get_invoice_ext. */
export interface InvoiceExt {
  parentInvoiceId: string | null;
  cloneDepth: number;
}

/** Relationships between invoices (clones, groups, prerequisites). */
export interface InvoiceRelationships {
  invoiceId: string;
  clones: string[];
  groupId: string | null;
  prerequisites: string[];
}

/** A discovered Soroban RPC node with latency info. */
export interface RPCNode {
  url: string;
  latencyMs: number;
  healthy: boolean;
}

/** Circuit breaker state */
export type CircuitState = "closed" | "open" | "half-open";

/** Status of a named circuit breaker */
export interface CircuitBreakerStatus {
  endpoint: string;
  state: CircuitState;
  failureCount: number;
  lastFailure: number | null;
}

/** Historical reconstruction of an invoice at a specific time */
export interface HistoricalInvoice {
  reconstructedAt: number;
}

/** Vesting schedule for an invoice with cliff and drip. */
export interface VestingSchedule {
  cliffDate: number;
  fullyVestedDate: number;
  claimableAt: (timestamp: number) => bigint;
}

/** Revenue breakdown after protocol fees. */
export interface RevenueBreakdown {
  invoiceId: string;
  gross: bigint;
  protocolFee: bigint;
  net: bigint;
  perRecipient: { address: string; amount: bigint }[];
}

/** Fee estimate with congestion indicator. */
export interface FeeEstimate {
  fee: bigint;
  congestion: "low" | "medium" | "high";
}

/** A co-signature collected from one signer. */
export interface CoSignature {
  signer: string;
  signedXdr: string;
}

/**
 * Feature detection result indicating which contract features are available.
 * Each field is true if the deployed contract supports the corresponding method.
 */
export interface ContractFeatures {
  batchPay: boolean;
  cloneInvoice: boolean;
  invoiceGroups: boolean;
  templates: boolean;
  archival: boolean;
}

/**
 * Weighted endpoint configuration for load balancing.
 */
export interface WeightedEndpoint {
  /** RPC endpoint URL */
  url: string;
  /** Weight for this endpoint (higher = more requests) */
  weight: number;
}

/** Result of rolling over an expired invoice into a new one. */
export interface RolloverResult {
  /** The ID of the newly created invoice. */
  newInvoiceId: string;
  /** Transaction hash of the rollover submission. */
  txHash: string;
}

/** Cooldown status for a payer on a given invoice. */
export interface PaymentCooldown {
  /** Whether the payer is currently in their cooldown period. */
  inCooldown: boolean;
  /** Unix timestamp (seconds) when the cooldown ends, or null if no cooldown is active. */
  cooldownEndsAt: number | null;
}

/** A structured cross-chain reference attached to an invoice. */
export interface CrossChainRef {
  /** Source chain identifier (e.g. "ethereum", "solana"). */
  chain: string;
  /** Transaction hash on the source chain. */
  transactionHash: string;
  /** Optional block number on the source chain. */
  blockNumber?: string;
}

/** Parameters for setting a cross-chain reference on an invoice. */
export interface SetCrossChainRefParams {
  /** Invoice ID to attach the reference to. */
  invoiceId: string;
  /** Stellar address of the invoice creator (must sign). */
  creator: string;
  /** Cross-chain reference data. */
  ref: CrossChainRef;
}
