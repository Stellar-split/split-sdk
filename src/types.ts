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

/** Result of an NFT gate status check for a creator address. */
export interface NftGateResult {
  /** Whether an NFT gate is configured for this creator. */
  gated: boolean;
  /** Whether the creator holds a qualifying NFT (only meaningful when gated is true). */
  hasNft: boolean;
  /** Address of the NFT contract used for gating, or null when not gated. */
  contractAddress: string | null;
}

/** Parameters for an arbiter's vote on a dispute. */
export interface ArbiterVote {
  invoiceId: string;
  arbiter: string;
  approve: boolean;
}
/** Lifecycle status of an invoice. */
export type InvoiceStatus = "Pending" | "Released" | "Refunded" | "Cancelled";

/** One recorded status change in an invoice's lifecycle. */
export interface TransitionRecord {
  from: InvoiceStatus;
  to: InvoiceStatus;
  /** Unix timestamp in seconds when the transition was applied. */
  at: number;
}

/** Error thrown for invalid invoice state transitions. */
export class InvalidTransitionError extends StellarSplitError {
  readonly from: InvoiceStatus;
  readonly to: InvoiceStatus;
  /** The set of statuses `from` was allowed to transition to. */
  readonly allowed: InvoiceStatus[];

  constructor(from: InvoiceStatus, to: InvoiceStatus, allowed: InvoiceStatus[] = []) {
    super(
      `Invalid transition from "${from}" to "${to}"`,
      "INVALID_TRANSITION",
      { from, to, allowed },
    );
    this.name = "InvalidTransitionError";
    this.from = from;
    this.to = to;
    this.allowed = allowed;
    Object.setPrototypeOf(this, new.target.prototype);
  }
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

import { StellarSplitError } from "./errors.js";

// ---------------------------------------------------------------------------
// Split Rollback Coordinator Types
// ---------------------------------------------------------------------------

/** Lifecycle state of a single leg tracked by the rollback coordinator. */
export type SplitLegState = "pending" | "succeeded" | "failed";

/** A single recipient leg within a multi-recipient split payment. */
export interface SplitLeg {
  /** Stellar address of this leg's recipient. */
  recipient: string;
  /** Amount owed to this recipient, in stroops. */
  amount: bigint;
  /** Current reconciliation state of this leg. */
  state: SplitLegState;
}

/** Result of submitting a multi-recipient split payment. */
export interface SplitResult {
  /** Identifier grouping the legs of this split (typically the tx hash). */
  splitId: string;
  /** Invoice this split payment was submitted for. */
  invoiceId: string;
  /** Transaction hash of the on-chain submission. */
  txHash: string;
  /** Per-recipient legs included in the split. */
  legs: SplitLeg[];
}

/** A persistent checkpoint recording the intended legs of a split payment. */
export interface SplitRollbackCheckpoint {
  /** Identifier grouping the legs of this split. */
  splitId: string;
  /** Invoice this split payment was submitted for. */
  invoiceId: string;
  /** Unix epoch ms when the checkpoint was created. */
  createdAt: number;
  /** Per-recipient legs, in submission order. */
  legs: SplitLeg[];
}

// ---------------------------------------------------------------------------
// AMM Calculator Types
// ---------------------------------------------------------------------------

/** Estimated output and price impact for a pool swap. */
export interface PoolSwapEstimate {
  /** Expected output amount in stroops. */
  outputAmount: string;
  /** Price impact as a percentage string (e.g. "1.23"). */
  priceImpactPercent: string;
  /** Asset being sold into the pool. */
  inputAsset: string;
  /** Asset being received from the pool. */
  outputAsset: string;
  /** Effective swap price (output / input). */
  effectivePrice: string;
  /** Current spot price (reserveOut / reserveIn). */
  spotPrice: string;
}

/** Proportional pool share for a given number of LP shares. */
export interface PoolShareResult {
  /** Proportional share of the first reserve asset in stroops. */
  shareOfAssetA: string;
  /** Proportional share of the second reserve asset in stroops. */
  shareOfAssetB: string;
  /** Asset identifier for the first reserve. */
  assetA: string;
  /** Asset identifier for the second reserve. */
  assetB: string;
  /** Total pool shares outstanding. */
  totalShares: string;
  /** Number of shares owned by the user. */
  sharesOwned: string;
  /** Ownership percentage (e.g. "5.50"). */
  ownershipPercent: string;
}

// ---------------------------------------------------------------------------
// Timeout Escalation Types
// ---------------------------------------------------------------------------

/** An escalation step that fires before the final payment deadline. */
export interface EscalationStep {
  /** Milliseconds before the deadline when this step triggers. */
  triggerAtMs: number;
  /** The action to take at this threshold. */
  action: "warn" | "retryHigherFee" | "switchEndpoint" | "abort";
  /** Fee multiplier for `retryHigherFee` action (default 1.5). */
  feeMultiplier?: number;
}

/** Policy controlling timeout escalation behaviour. */
export interface TimeoutPolicy {
  /** Total deadline in milliseconds. */
  deadlineMs: number;
  /** Ordered escalation steps (closest to deadline first). */
  escalations: EscalationStep[];
}



export interface HealthCheckResult {
  rpcReachable: boolean;
  latencyMs: number;
  network: string;
  contractDeployed: boolean;
  error?: string;
}

export class HealthCheckTimeoutError extends StellarSplitError {
  constructor(message: string) {
    super(message, "HEALTH_CHECK_TIMEOUT", {}, message);
    this.name = "HealthCheckTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Basic invoice data structure mirroring the Soroban contract.
 */
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
  /**
   * When the invoice was created. Accepted as a Unix timestamp in either
   * seconds or milliseconds; helpers such as `getInvoiceAge` and
   * `getFundingVelocity` detect the unit automatically by magnitude (values
   * greater than 1e12 are treated as milliseconds). `0`, negative, and
   * non-finite values are treated as "unknown" rather than as epoch 1970.
   *
   * Note: `hashInvoice()` canonicalises every key present on the invoice
   * object, so populating this field changes an invoice's `contentHash`.
   * Recompute any stored hashes before relying on `verifyInvoice()` or
   * `submitPayment({ expectedContentHash })` for invoices that gain it.
   */
  createdAt?: number;
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
  /** Optional scheduled release date timestamp. */
  scheduledReleaseDate?: number;
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
  /** Ordered record of status transitions applied via InvoiceStateMachine. */
  statusHistory?: TransitionRecord[];
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
  /** Configured split rules governing how released funds are distributed. */
  split_rules?: SplitRule[];
  /** Rules evaluated by auto_resolve() to decide Release/Refund automatically. */
  auto_resolve_rules?: AutoResolveRule[];
  /** ID of the single prerequisite invoice in this invoice's dependency chain. */
  prerequisite_id?: string;
  /**
   * Optional token-gate policy. When set, callers must hold the specified
   * asset balance to read or interact with this invoice.
   */
  accessPolicy?: TokenGatePolicy;
}

/**
 * A rule describing how a single recipient's share is computed when an
 * invoice is released. The active variant is selected by `kind`.
 */
export type SplitRule =
  | {
      /** Recipient receives a fixed amount in stroops (capped at remaining funds). */
      kind: "Fixed";
      recipient: string;
      amount: bigint;
    }
  | {
      /** Recipient receives `bps` basis points of the funded amount. */
      kind: "Percentage";
      recipient: string;
      bps: number;
    }
  | {
      /**
       * Recipient receives a marginal-band share: for each tier, `bps` is
       * applied to the portion of funds falling between the previous tier's
       * `upTo` and this tier's `upTo`.
       */
      kind: "Tiered";
      recipient: string;
      tiers: { upTo: bigint; bps: number }[];
    };

/** A single recipient's previewed payout under the configured split rules. */
export interface SplitPreviewEntry {
  recipient: string;
  amount: bigint;
}

/**
 * An auto-resolve rule evaluated against the invoice's current funded amount.
 * The first rule (in order) whose condition holds determines the action.
 */
export interface AutoResolveRule {
  /** Action that fires when this rule matches. */
  action: "Release" | "Refund";
  /** Funded-amount threshold in stroops the rule is compared against. */
  threshold: bigint;
  /**
   * Comparison applied between `funded` and `threshold`. Defaults to "gte"
   * (funded >= threshold). "lt" matches when funded < threshold.
   */
  comparator?: "gte" | "lt";
}

/** Result of simulating auto_resolve() against an invoice's current state. */
export interface AutoResolveSimulation {
  /** Whether auto_resolve() would take an action right now. */
  wouldResolve: boolean;
  /** The action that would fire, or null if no rule matched. */
  action: "Release" | "Refund" | null;
  /** The first rule that matched, or null if none did. */
  matchedRule: AutoResolveRule | null;
}

/** Rich analytics computed from an invoice's on-chain payment history. */
export interface InvoiceStats {
  /** Number of distinct payer addresses. */
  totalPayers: number;
  /** Mean payment size in stroops (0 when there are no payments). */
  avgPayment: bigint;
  /**
   * Stroops funded per day across the payment window, i.e. the sum of payment
   * amounts divided by the span between the first and last payment.
   *
   * This is deliberately different from the exported `getFundingVelocity()`,
   * which is a lifetime average over the whole age of the invoice (`funded`
   * since `createdAt`). Expect the two to disagree for the same invoice.
   */
  fundingVelocity: number;
  /** Seconds from first to last payment once completed, else null. */
  timeToCompletion: number | null;
  /** Funded share of total owed, in basis points (capped at 10000). */
  completionBps: number;
}

/** One entry in a resolved prerequisite dependency chain. */
export interface PrerequisiteChainEntry {
  /** Invoice ID of this prerequisite. */
  id: string;
  /** Current lifecycle status of the prerequisite. */
  status: InvoiceStatus;
  /** True while the prerequisite is not yet Released (still blocking). */
  isBlocking: boolean;
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
  /** Optional memo / description. */
  memo?: string;
  /**
   * When `true`, skip the `RecipientBalancePreCheck` that normally runs
   * before the invoice is submitted. Use only for advanced flows where you
   * have already validated recipients independently.
   * @default false
   */
  skipPreCheck?: boolean;
  /**
   * Horizon API URL used by the pre-check to load recipient accounts.
   * Falls back to "https://horizon.stellar.org" when omitted.
   */
  horizonUrl?: string;
}

/** Generic hardware/software wallet adapter interface. */
export interface WalletAdapter {
  /** Unique wallet name (e.g., "Freighter", "LOBSTR", "xBull") */
  name: string;
  /** Connect to the wallet and return the Stellar public key */
  connect(): Promise<string>;
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
  /** Disconnect from the wallet */
  disconnect(): void;
  /** Register a handler for account change events. Returns an unsubscribe function. */
  onAccountChange(handler: (address: string) => void): () => void;
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

/** Result of a dry-run transaction simulation. */
export interface SimulationResult {
  /** Whether the simulation succeeded. */
  success: boolean;
  /** Error message if simulation failed. */
  error?: string;
  /** Estimated fee in stroops. */
  fee: bigint;
  /** CPU instructions used. */
  cpuInsns: bigint;
  /** Memory bytes used. */
  memBytes: bigint;
  /** Ledger footprint. */
  footprint: LedgerFootprint;
}

/** Ledger footprint representing storage requirements. */
export interface LedgerFootprint {
  /** Read footprint in bytes. */
  readBytes: bigint;
  /** Write footprint in bytes. */
  writeBytes: bigint;
  /** Read ledger entries. */
  readLedgerEntries: bigint;
  /** Write ledger entries. */
  writeLedgerEntries: bigint;
}

/** Lifecycle hooks for invoice events. */
export interface InvoiceLifecycleHooks {
  onCreated?: (invoice: Invoice) => void;
  onPaid?: (invoice: Invoice, payment: Payment) => void;
  onReleased?: (invoice: Invoice) => void;
  onRefunded?: (invoice: Invoice) => void;
  onCancelled?: (invoice: Invoice) => void;
}

/** Result of previewing a token swap via DEX contract. */
export interface PreviewTokenSwapResult {
  /** Estimated output amount from the swap in stroops. */
  estimatedOutput: bigint;
  /** Price impact in basis points (1 bps = 0.01%). */
  priceImpactBps: number;
  /** Route taken through the DEX (list of token addresses). */
  route: string[];
}

/** Result of SDK/contract version negotiation. */
export interface VersionInfo {
  contractVersion: string;
  sdkVersion: string;
  compatible: boolean;
}

/** Optional lifecycle hooks fired by StellarSplitClient methods. */

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
  /**
   * When `true`, skip the `InvoiceCloneabilityValidator` that normally runs
   * before the clone is submitted. For advanced users who have already
   * validated the source invoice independently.
   * @default false
   */
  skipValidation?: boolean;
  /**
   * Horizon URL passed through to `InvoiceCloneabilityValidator` for
   * recipient account lookups.
   */
  horizonUrl?: string;
}

/** Field names supported by read methods that can return partial objects. */
export type InvoiceField = keyof Invoice;

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

// ---------------------------------------------------------------------------
// Invoice Event Subscription Types (Issue #417)
// ---------------------------------------------------------------------------

/** Invoice event types emitted by the StellarSplit contract. */
export type InvoiceEventType =
  | "created"
  | "payment"
  | "released"
  | "refunded"
  | "cancelled"
  | "frozen"
  | "unfrozen"
  | "dispute_opened"
  | "dispute_resolved"
  | "split_rules_updated"
  | "auto_resolve_rules_updated"
  | "velocity_limit_updated"
  | "prerequisite_added"
  | "prerequisite_removed"
  | "forward_chain_created"
  | "scheduled_release_set"
  | "penalty_tiers_updated"
  | "allowed_callers_updated"
  | "nft_gate_set"
  | "nft_gate_removed";

/** Base invoice event structure. */
export interface BaseInvoiceEvent {
  /** Invoice ID this event belongs to. */
  invoiceId: string;
  /** Ledger sequence number where event was emitted. */
  ledger: number;
  /** Unix timestamp when event was emitted. */
  timestamp: number;
  /** Unique event identifier for deduplication (ledger + topic hash). */
  eventId: string;
}

/** Invoice created event. */
export interface InvoiceCreatedEvent extends BaseInvoiceEvent {
  type: "created";
  creator: string;
  recipients: Recipient[];
  token: string;
  deadline: number;
}

/** Payment received event. */
export interface InvoicePaymentEvent extends BaseInvoiceEvent {
  type: "payment";
  payer: string;
  amount: bigint;
  donateOnFailure?: boolean;
  payment?: Payment & { ledger: number; timestamp: number };
}

/** Invoice released event. */
export interface InvoiceReleasedEvent extends BaseInvoiceEvent {
  type: "released";
  releasedBy: string;
  amount: bigint;
  totalAmount?: bigint;
}

/** Invoice refunded event. */
export interface InvoiceRefundedEvent extends BaseInvoiceEvent {
  type: "refunded";
  refundedBy?: string;
  refundedTo: string;
  amount: bigint;
  totalAmount?: bigint;
}

/** Invoice cancelled event. */
export interface InvoiceCancelledEvent extends BaseInvoiceEvent {
  type: "cancelled";
  cancelledBy: string;
}

/** Invoice frozen event. */
export interface InvoiceFrozenEvent extends BaseInvoiceEvent {
  type: "frozen";
  frozenBy: string;
  reason: string;
}

/** Invoice unfrozen event. */
export interface InvoiceUnfrozenEvent extends BaseInvoiceEvent {
  type: "unfrozen";
  unfrozenBy: string;
}

/** Dispute opened event. */
export interface DisputeOpenedEvent extends BaseInvoiceEvent {
  type: "dispute_opened";
  disputeId: string;
  openedBy: string;
  reason: string;
}

/** Dispute resolved event. */
export interface DisputeResolvedEvent extends BaseInvoiceEvent {
  type: "dispute_resolved";
  disputeId: string;
  resolvedBy: string;
  resolution: string;
}

/** Split rules updated event. */
export interface SplitRulesUpdatedEvent extends BaseInvoiceEvent {
  type: "split_rules_updated";
  updatedBy: string;
}

/** Auto-resolve rules updated event. */
export interface AutoResolveRulesUpdatedEvent extends BaseInvoiceEvent {
  type: "auto_resolve_rules_updated";
  updatedBy: string;
}

/** Velocity limit updated event. */
export interface VelocityLimitUpdatedEvent extends BaseInvoiceEvent {
  type: "velocity_limit_updated";
  updatedBy: string;
  limitPerWindow: bigint;
  windowDuration: number;
}

/** Prerequisite added event. */
export interface PrerequisiteAddedEvent extends BaseInvoiceEvent {
  type: "prerequisite_added";
  prerequisiteId: string;
}

/** Prerequisite removed event. */
export interface PrerequisiteRemovedEvent extends BaseInvoiceEvent {
  type: "prerequisite_removed";
  prerequisiteId: string;
}

/** Forward chain created event. */
export interface ForwardChainCreatedEvent extends BaseInvoiceEvent {
  type: "forward_chain_created";
  forwardInvoiceId: string;
}

/** Scheduled release set event. */
export interface ScheduledReleaseSetEvent extends BaseInvoiceEvent {
  type: "scheduled_release_set";
  scheduledAt: number;
}

/** Penalty tiers updated event. */
export interface PenaltyTiersUpdatedEvent extends BaseInvoiceEvent {
  type: "penalty_tiers_updated";
  updatedBy: string;
}

/** Allowed callers updated event. */
export interface AllowedCallersUpdatedEvent extends BaseInvoiceEvent {
  type: "allowed_callers_updated";
  updatedBy: string;
}

/** NFT gate set event. */
export interface NftGateSetEvent extends BaseInvoiceEvent {
  type: "nft_gate_set";
  contractAddress: string;
}

/** NFT gate removed event. */
export interface NftGateRemovedEvent extends BaseInvoiceEvent {
  type: "nft_gate_removed";
}

/** Union type of all possible invoice events. */
export type InvoiceEvent =
  | InvoiceCreatedEvent
  | InvoicePaymentEvent
  | InvoiceReleasedEvent
  | InvoiceRefundedEvent
  | InvoiceCancelledEvent
  | InvoiceFrozenEvent
  | InvoiceUnfrozenEvent
  | DisputeOpenedEvent
  | DisputeResolvedEvent
  | SplitRulesUpdatedEvent
  | AutoResolveRulesUpdatedEvent
  | VelocityLimitUpdatedEvent
  | PrerequisiteAddedEvent
  | PrerequisiteRemovedEvent
  | ForwardChainCreatedEvent
  | ScheduledReleaseSetEvent
  | PenaltyTiersUpdatedEvent
  | AllowedCallersUpdatedEvent
  | NftGateSetEvent
  | NftGateRemovedEvent;

/** Subscription configuration options. */
export interface SubscriptionOptions {
  /** Polling interval in milliseconds. Default: 3000. */
  pollIntervalMs?: number;
  /** Maximum number of reconnection retries. Default: 5. */
  maxRetries?: number;
  /** Initial backoff in milliseconds. Default: 1000. */
  initialBackoffMs?: number;
  /** Maximum backoff in milliseconds. Default: 30000. */
  maxBackoffMs?: number;
  /** Backoff multiplier for exponential backoff. Default: 2. */
  backoffMultiplier?: number;
  /** Optional callback for subscription lifecycle events. */
  onLifecycleEvent?: (event: SubscriptionLifecycleEvent) => void;
}

/** Subscription lifecycle event types. */
export interface SubscriptionErrorEvent {
  type: "error";
  invoiceId: string;
  error: Error;
  retryCount: number;
  maxRetries: number;
}

export interface SubscriptionCloseEvent {
  type: "close";
  invoiceId: string;
  reason: "unsubscribed" | "max_retries" | "error";
}

export interface SubscriptionReconnectEvent {
  type: "reconnect";
  invoiceId: string;
  retryCount: number;
  nextRetryMs: number;
}

export type SubscriptionLifecycleEvent =
  | SubscriptionErrorEvent
  | SubscriptionCloseEvent
  | SubscriptionReconnectEvent;

/** Subscription interface returned by subscribeInvoice. */
export interface Subscription {
  /** Cancel the subscription and stop polling. */
  unsubscribe(): void;
  /** Pause polling without unsubscribing. */
  pause(): void;
  /** Resume polling after pause. */
  resume(): void;
  /** Get the invoice ID this subscription is for. */
  getInvoiceId(): string;
  /** Check if subscription is active (not stopped). */
  isActive(): boolean;
  /** Check if subscription is paused. */
  isPaused(): boolean;
}

/** Result of rolling over an expired invoice into a new one. */
export interface RolloverResult {
  /** The ID of the newly created invoice. */
  newInvoiceId: string;
  /** Transaction hash of the rollover submission. */
  txHash: string;
}

/** Countdown until a scheduled release fires. */
export interface ScheduledReleaseCountdown {
  /** Total seconds remaining (0 when overdue). */
  total_seconds: number;
  days: number;
  hours: number;
  minutes: number;
  seconds: number;
  overdue: boolean;
}

/** Dispute status returned from the contract. */
export interface DisputeStatus {
  invoiceId: string;
  disputed: boolean;
  arbiter: string;
  resolved: boolean;
  resolution: "approved" | "rejected" | null;
  /** Reason for the dispute */
  reason?: string;
  /** Address that opened the dispute */
  openedBy?: string;
  /** Unix timestamp when dispute was opened */
  openedAt?: number;
}

/** A single auction bid. */
export interface AuctionBid {
  bidder: string;
  amount: bigint;
  timestamp: number;
}

/** Auction state for an invoice. */
export interface AuctionInfo {
  invoiceId: string;
  active: boolean;
  highestBid: AuctionBid | null;
  endTime: number;
}

/** Parameters for queuing a timelock action. */
export interface QueueActionParams {
  caller: string;
  actionType: string;
  target: string;
  value: bigint;
  eta: number;
}

/** A queued timelock action. */
export interface TimelockAction {
  actionId: string;
  actionType: string;
  target: string;
  value: bigint;
  eta: number;
  executed: boolean;
  cancelled: boolean;
}

/** Result of an admin freeze operation. */
export interface AdminFreezeResult {
  /** Transaction hash of the freeze submission. */
  txHash: string;
  /** Invoice ID that was frozen. */
  invoiceId: string;
  /** Stellar address of the admin that performed the freeze. */
  adminAddress: string;
  /** Reason provided for the freeze. */
  reason: string;
  /** Unix timestamp (ms) when the freeze was submitted. */
  timestamp: number;
}

/** Result of an admin unfreeze operation. */
export interface AdminUnfreezeResult {
  /** Transaction hash of the unfreeze submission. */
  txHash: string;
  /** Invoice ID that was unfrozen. */
  invoiceId: string;
  /** Stellar address of the admin that performed the unfreeze. */
  adminAddress: string;
  /** Unix timestamp (ms) when the unfreeze was submitted. */
  timestamp: number;
}

/** Cryptographic completion proof returned by get_completion_proof. */
export interface CompletionProof {
  /** Invoice ID. */
  invoiceId: string;
  /** Address that released the invoice. */
  releasedBy: string;
  /** Unix timestamp of the release. */
  releasedAt: number;
  /** Total amount released in stroops. */
  totalAmount: bigint;
  /** On-chain cert hash to verify against. */
  cert_hash: string;
}
/** Current velocity-window state for a payer on a velocity-limited invoice. */
export interface VelocityWindowStatus {
  /** Unix timestamp (seconds) when the current window opened. */
  windowStart: number;
  /** Unix timestamp (seconds) when the current window closes. */
  windowEnd: number;
  /** Amount already paid by the payer in the current window, in stroops. */
  amountUsed: bigint;
  /** Amount the payer may still pay in the current window, in stroops. */
  amountRemaining: bigint;
  /** Maximum amount payable per window, in stroops. */
  limitPerWindow: bigint;
}

/**
 * Result of {@link StellarSplitClient.getVelocityStatus}. Either the active
 * window state, or `{ limited: false }` when the invoice has no velocity limit.
 */
export type VelocityStatus = VelocityWindowStatus | { limited: false };
/** Result of claiming a pending payout. */
export interface ClaimPayoutResult {
  /** Transaction hash of the claim submission. */
  txHash: string;
  /** Invoice ID the payout was claimed from. */
  invoiceId: string;
  /** Recipient address that received the payout. */
  recipient: string;
}

/** Parameters for payWithAttestation. */
export interface PayWithAttestationParams {
  /** Stellar address of the payer (must sign). */
  payer: string;
  /** Invoice ID to pay toward. */
  invoiceId: string;
  /** Amount to pay in stroops. */
  amount: bigint;
  /** 32-byte hash of the off-chain attestation document. */
  attestationHash: Uint8Array;
  /** 64-byte Ed25519 signature over the attestation hash. */
  signature: Uint8Array;
  /** Stellar public key of the attestation signer. */
  signerPubkey: string;
}

/** Payment receipt returned after a successful payWithAttestation. */
export interface AttestationPaymentReceipt {
  /** Transaction hash. */
  txHash: string;
  /** Invoice ID paid. */
  invoiceId: string;
  /** Amount paid in stroops. */
  amount: bigint;
  /** Hex-encoded attestation hash included in the receipt. */
  attestationHash: string;
}

/** Creator volume cap information. */
export interface CreatorVolumeCap {
  /** Volume cap in token units, or null if uncapped. */
  cap: bigint | null;
  /** Lifetime volume used in token units. */
  used: bigint;
  /** Remaining volume (cap - used), or Infinity if uncapped. */
  remaining: bigint | typeof Infinity;
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

// ---------------------------------------------------------------------------
// Sponsorship Configuration
// ---------------------------------------------------------------------------

/** Configuration for sponsored-reserve onboarding flows. */
export interface SponsorshipConfig {
  /** Stellar address of the sponsoring account. */
  sponsorAddress: string;
  /** Stellar address of the account being onboarded / sponsored. */
  sponsoredAddress: string;
  /** Number of new ledger entries the sponsor will cover. */
  entryCount: number;
  /** Optional Horizon URL override for balance checks. */
  horizonUrl?: string;
}

/** Result of a pre-submission sponsor reserve check. */
export interface SponsorReserveCheckResult {
  /** Whether the sponsor has sufficient XLM reserve. */
  sufficient: boolean;
  /** Sponsor's available XLM balance in stroops. */
  availableStroops: bigint;
  /** Required XLM reserve in stroops for the new entries. */
  requiredStroops: bigint;
  /** Shortfall in stroops (0 if sufficient). */
  shortfallStroops: bigint;
}

// ---------------------------------------------------------------------------
// Invoice Record (expanded with expiresAt for timebounds)
// ---------------------------------------------------------------------------

/**
 * Expanded invoice record that includes the expiry timestamp
 * used for transaction timebounds enforcement.
 */
export interface InvoiceRecord {
  /** Invoice ID. */
  invoiceId: string;
  /** Creator address. */
  creator: string;
  /** Unix timestamp (seconds) when the invoice expires. */
  expiresAt: number;
  /** Current lifecycle status. */
  status: InvoiceStatus;
  /** Total amount required. */
  totalOwed: bigint;
  /** Unix timestamp (milliseconds) when payment is due. Used by {@link InvoiceReminderScheduler}. */
  dueAt?: number;
}

// ---------------------------------------------------------------------------
// Invoice Reminder Scheduler Types
// ---------------------------------------------------------------------------

/** Lifecycle status of a single scheduled reminder. */
export type ReminderStatus = "pending" | "fired" | "cancelled" | "expired";

/** A single reminder scheduled to fire before an invoice's due date. */
export interface ReminderSchedule {
  /** Unique ID for this reminder entry. */
  id: string;
  /** Invoice this reminder is associated with. */
  invoiceId: string;
  /** Milliseconds before `dueAt` that this reminder should fire. */
  offsetMs: number;
  /** Unix timestamp (milliseconds) the invoice is due. */
  dueAt: number;
  /** Unix timestamp (milliseconds) this reminder is scheduled to fire (`dueAt - offsetMs`). */
  fireAt: number;
  /** Current lifecycle status of this reminder. */
  status: ReminderStatus;
}

/** Payload emitted when a reminder fires. */
export interface ReminderEvent {
  /** Invoice the reminder is for. */
  invoiceId: string;
  /** Offset (ms before due date) that triggered this reminder. */
  offsetMs: number;
  /** Unix timestamp (milliseconds) the invoice is due. */
  dueAt: number;
}

/** Pending reminder descriptor returned by getPendingReminders. */
export interface PendingReminder {
  /** Unique identifier of the scheduled reminder. */
  reminderId: string;
  /** Invoice the reminder is associated with. */
  invoiceId: string;
  /** Unix timestamp (milliseconds) when the reminder is scheduled to fire. */
  remindAt: number;
}

// ---------------------------------------------------------------------------
// XDR Decoder Types
// ---------------------------------------------------------------------------

/** Supported XDR types for decoding. */
export type XDRType =
  | "TransactionEnvelope"
  | "TransactionResult"
  | "TransactionMeta"
  | "LedgerEntry"
  | "TransactionV1Envelope"
  | "FeeBumpTransaction";

/** Decoded TransactionEnvelope as a structured JSON-safe object. */
export interface DecodedTransactionEnvelope {
  type: "TransactionEnvelope";
  tx: {
    sourceAccount: string;
    fee: string;
    seqNum: string;
    memo?: string;
    operations: DecodedOperation[];
    timeBounds?: { minTime: string; maxTime: string };
  };
}

/** A single decoded operation within a transaction. */
export interface DecodedOperation {
  type: string;
  sourceAccount?: string;
  body: Record<string, unknown>;
}

/** A single decoded per-operation result within a DecodedTransactionResult. */
export interface DecodedOperationResult {
  /** OperationResultCode switch name (e.g. "opInner", "opBadAuth", "opNoAccount"). */
  code: string;
  /** Operation type name when `code === "opInner"` (e.g. "payment", "createClaimableBalance"). */
  operationType?: string;
  /** The operation-specific result code (e.g. "paymentSuccess", "paymentUnderfunded"). */
  resultCode?: string;
}

/** Decoded TransactionResult as a structured JSON-safe object. */
export interface DecodedTransactionResult {
  type: "TransactionResult";
  feeCharged: string;
  result: {
    code: string;
    innerResult?: Record<string, unknown>;
  };
  /** Per-operation results, in the same order as the submitted transaction's operations. */
  operationResults?: DecodedOperationResult[];
  /** Present only for fee-bump transactions: the outer fee-bump result plus the nested inner transaction result. */
  feeBump?: {
    outer: { feeCharged: string; code: string };
    inner: DecodedTransactionResult;
  };
}

/** Decoded TransactionMeta as a structured JSON-safe object. */
export interface DecodedTransactionMeta {
  type: "TransactionMeta";
  operations: Array<{
    changes: Array<{
      type: string;
      key: string;
      before?: Record<string, unknown>;
      after?: Record<string, unknown>;
    }>;
  }>;
}

/** Decoded LedgerEntry as a structured JSON-safe object. */
export interface DecodedLedgerEntry {
  type: "LedgerEntry";
  lastModifiedLedgerSeq: number;
  data: {
    type: string;
    accountId?: string;
    balance?: string;
    flags?: number;
    signers?: Array<{ key: string; weight: number }>;
    thresholds?: { low: number; med: number; high: number };
    [key: string]: unknown;
  };
}

/** Decoded AUTH_* flags for a Stellar account, with operation-compatibility checks. */
export interface AccountFlagSet {
  /** AUTH_REQUIRED — the issuer must approve an account before it can hold this asset. */
  authRequired: boolean;
  /** AUTH_REVOCABLE — the issuer can revoke an account's authorization to hold this asset. */
  authRevocable: boolean;
  /** AUTH_IMMUTABLE — this account's flags can never be changed again. */
  authImmutable: boolean;
  /** AUTH_CLAWBACK_ENABLED — the issuer can claw back this asset from holders. */
  authClawbackEnabled: boolean;
  /** Returns `false` when this account's flags make `operation` impossible without prior authorization. */
  isCompatibleWith(operation: string): boolean;
}

/** Declarative description of a claimable-balance claim predicate, buildable via `PredicateBuilder.build()`. */
export type PredicateConfig =
  | { type: "unconditional" }
  | { type: "absoluteWindow"; start: number; end: number }
  | { type: "relativeWindow"; secondsFromNow: number }
  | { type: "and"; predicates: [PredicateConfig, PredicateConfig] }
  | { type: "or"; predicates: [PredicateConfig, PredicateConfig] };

/** Union type of all decoded XDR variants. */
export type DecodedXDR =
  | DecodedTransactionEnvelope
  | DecodedTransactionResult
  | DecodedTransactionMeta
  | DecodedLedgerEntry;

// ---------------------------------------------------------------------------
// Confidential Payment Types (Pedersen Commitments)
// ---------------------------------------------------------------------------

/** Result of generating a Pedersen commitment for a payment amount. */
export interface PedersenCommitment {
  /** The commitment point C = aH + vG, serialized as 33-byte compressed point. */
  commitment: Buffer;
  /** The random blinding factor 'a' used in the commitment (32 bytes). */
  blindingFactor: Buffer;
}

/** Configuration for blinding factor storage. */
export interface BlindingFactorStorageConfig {
  /** Storage key prefix. Defaults to "stellarsplit:bf:". */
  keyPrefix?: string;
}

/** Stored blinding factor entry with metadata. */
export interface StoredBlindingFactor {
  /** The encrypted blinding factor. */
  encryptedData: Uint8Array;
  /** AES-GCM initialization vector (12 bytes). */
  iv: Uint8Array;
  /** Invoice ID this blinding factor belongs to. */
  invoiceId: string;
  /** Unix timestamp when stored. */
  storedAt: number;
}

/** Options for building a reveal payment transaction. */
export interface RevealPaymentOptions {
  /** Invoice ID to reveal payment for. */
  invoiceId: bigint;
  /** The actual payment value that was committed. */
  value: bigint;
  /** The blinding factor used in the original commitment. */
  blindingFactor: Buffer;
  /** Payer's Stellar address. */
  payer: string;
}

// IPFS Invoice Metadata Types
// ---------------------------------------------------------------------------

/** A single line item in an invoice. */
export interface LineItem {
  /** Description of the item or service. */
  description: string;
  /** Quantity of items. */
  quantity: number;
  /** Unit price in stroops. */
  unitPrice: bigint;
  /** Optional total override (defaults to quantity * unitPrice). */
  total?: bigint;
}

/** Structured metadata for an invoice stored on IPFS. */
export interface InvoiceMetadata {
  /** Human-readable title for the invoice. */
  title: string;
  /** Detailed description of the invoice. */
  description: string;
  /** Itemized line items. */
  lineItems: LineItem[];
  /** CIDs of attachment files (documents, images, etc.). */
  attachmentCIDs: string[];
}

// ---------------------------------------------------------------------------
// Multi-Asset Line Item Normalizer Types
// ---------------------------------------------------------------------------

/** A line item denominated in its own asset, prior to settlement normalisation. */
export interface InvoiceLineItem {
  /** Description of the item or service. */
  description: string;
  /** Quantity of items. */
  quantity: number;
  /** Unit price in stroops, denominated in `asset`. */
  unitPrice: bigint;
  /** Optional total override (defaults to quantity * unitPrice), denominated in `asset`. */
  total?: bigint;
  /** Asset identifier this line item is priced in: "native" or "CODE:ISSUER" or a contract address. */
  asset: string;
}

/** A line item after conversion to the invoice's settlement asset. */
export interface NormalizedLineItem {
  /** Description of the item or service. */
  description: string;
  /** Original amount in stroops, denominated in `originalAsset`. */
  originalAmount: bigint;
  /** Asset identifier the line item was originally denominated in. */
  originalAsset: string;
  /** Amount in stroops after conversion to the settlement asset. */
  convertedAmount: bigint;
  /** Fixed-point rate (1e18 = 1.0) used for the conversion; 1e18 when no conversion was needed. */
  conversionRate: bigint;
}

/** Aggregate result of normalising an invoice's line items to a single settlement asset. */
export interface NormalizedInvoiceTotal {
  /** Asset identifier all amounts were normalised to. */
  settlementAsset: string;
  /** Sum of all `convertedAmount` values, in stroops. */
  total: bigint;
  /** Per-item normalised amounts, in the same order as the input. */
  items: NormalizedLineItem[];
}

// ---------------------------------------------------------------------------
// Contract Retry Queue Types
// ---------------------------------------------------------------------------

/** A single Soroban contract invocation to be submitted (with retry on failure). */
export interface ContractInvocation {
  /** Contract address being invoked. */
  contractId: string;
  /** Contract method name. */
  method: string;
  /** Method arguments, in the order the contract expects them. */
  args: unknown[];
  /** Stellar address the invocation is submitted on behalf of. */
  source: string;
}

/** Result of a successfully submitted contract invocation. */
export interface ContractResult {
  /** Hash of the submitted transaction. */
  txHash: string;
  /** Decoded return value from the contract call, if any. */
  returnValue?: unknown;
}

/** Configuration for IPFS backend. */
export interface IPFSConfig {
  /** Backend type: 'gateway' for HTTP gateway or 'kubo' for Kubo RPC API. */
  backend: "gateway" | "kubo";
  /** Base URL for the IPFS endpoint. */
  url: string;
  /** Optional timeout in milliseconds. Defaults to 30000. */
  timeout?: number;
  /** Optional authorization header for authenticated endpoints. */
  authorization?: string;
}

/** Result of a CID verification operation. */
export interface CIDVerificationResult {
  /** Whether the content matches the CID. */
  valid: boolean;
  /** The expected CID. */
  expectedCID: string;
  /** The computed CID from the fetched content, if available. */
  computedCID?: string;
  /** Error message if verification failed. */
  error?: string;
}

// ---------------------------------------------------------------------------
// Cross-Chain Bridge Payment Types
// ---------------------------------------------------------------------------

/**
 * Supported source chain identifiers for cross-chain bridge payments.
 * Ethereum mainnet and Solana mainnet are the minimum required chains.
 */
export type ChainId = "ethereum" | "solana";

/**
 * Fee estimate returned by the bridge for routing a payment from a foreign chain
 * to a StellarSplit invoice on Stellar Soroban.
 */
export interface BridgeFeeEstimate {
  /** Bridge relay fee in source-chain native units (e.g. wei for ETH, lamports for SOL). */
  bridgeFee: bigint;
  /** Net amount that will arrive on Stellar after fee deduction, in stroops. */
  netAmount: bigint;
  /** Estimated bridging time in seconds. */
  estimatedTimeSeconds: number;
}

/**
 * Parameters required to build an unsigned bridge payment relay proof struct.
 */
export interface BridgePaymentParams {
  /** Source chain identifier. */
  sourceChain: ChainId;
  /** Stellar address of the payer (used as the Stellar recipient identity). */
  payer: string;
  /** StellarSplit invoice ID to pay toward. */
  invoiceId: string;
  /** Amount to send from the source chain (in source-chain atomic units). */
  amount: bigint;
  /** Token contract/mint address on the source chain. */
  sourceToken: string;
  /** Deadline timestamp (Unix seconds) for this bridge payment. */
  deadline: number;
}

/**
 * Unsigned relay proof struct built by buildBridgePayment.
 * This must be signed by the payer's source-chain wallet before submission.
 */
export interface BridgePaymentRequest {
  /** Source chain identifier. */
  sourceChain: ChainId;
  /** Stellar invoice ID. */
  invoiceId: string;
  /** Stellar payer address. */
  payer: string;
  /** Amount in source-chain atomic units. */
  amount: bigint;
  /** Source-chain token identifier. */
  sourceToken: string;
  /** Deadline for the bridge payment (Unix seconds). */
  deadline: number;
  /** Unique nonce preventing replay attacks. */
  nonce: string;
  /** SHA-256 hex digest of the canonical relay payload. */
  payloadHash: string;
}

/**
 * A bridge payment request that has been signed by the source-chain wallet.
 * Passed to submitBridgePayment to relay to the Stellar contract.
 */
export interface SignedBridgeProof {
  /** The original unsigned payment request. */
  request: BridgePaymentRequest;
  /** Source-chain signature over the payloadHash (hex-encoded). */
  signature: string;
  /** Source-chain address of the signer. */
  signerAddress: string;
}

// ---------------------------------------------------------------------------
// Memo Builder Types
// ---------------------------------------------------------------------------

/**
 * Configuration for the split memo builder, defining the version of the split
 * protocol used when encoding memo data.
 */
export interface SplitConfig {
  /** Protocol version number for the split memo format. */
  version: number;
}

/**
 * Parsed representation of a canonical StellarSplit memo.
 */
export interface ParsedMemo {
  /** The invoice ID extracted from the memo. */
  invoiceId: string;
  /** The split protocol version encoded in the memo. */
  version: number;
  /** The payer's Stellar address suffix (last 8 chars) used for identification. */
  payerId: string;
}

// ---------------------------------------------------------------------------
// Asset Issuer Verification Types
// ---------------------------------------------------------------------------

/** Result of verifying an asset issuer's on-chain identity and metadata. */
export interface IssuerVerificationResult {
  /** Whether the issuer passed all verification checks. */
  verified: boolean;
  /** The issuer account ID that was checked. */
  issuerId: string;
  /** Whether the issuer account exists on the network. */
  accountExists: boolean;
  /** The home domain claimed by the issuer account, if any. */
  homeDomain: string | null;
  /** Whether a valid stellar.toml was found at the home domain. */
  tomlFound: boolean;
  /** Whether the asset code was listed in the CURRENCIES section of the toml. */
  assetInToml: boolean;
  /** The asset code that was verified against the toml. */
  assetCode: string | null;
  /** List of human-readable failure reasons when verified is false. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// SEP-24 Interactive Transfer Types
// ---------------------------------------------------------------------------

/** Lifecycle status of a SEP-24 interactive transfer. */
export type Sep24Status =
  | "incomplete"
  | "pending_user_transfer_start"
  | "pending_anchor"
  | "pending_stellar"
  | "pending_external"
  | "completed"
  | "error"
  | "refunded";

/** A record tracking a single SEP-24 interactive deposit or withdrawal. */
export interface Sep24TransactionRecord {
  /** SEP-24 transaction ID returned by the anchor. */
  id: string;
  /** Type of transfer: deposit or withdrawal. */
  kind: "deposit" | "withdrawal";
  /** Current lifecycle status. */
  status: Sep24Status;
  /** Amount requested in the transfer (in stroops). */
  amount: bigint;
  /** Asset code (e.g., "USDC"). */
  assetCode: string;
  /** The anchor's Stellar address for the asset issuer. */
  assetIssuer: string;
  /** The interactive IFRAME URL the user should visit. */
  interactiveUrl: string | null;
  /** Stellar transaction ID once the transfer completes on-chain. */
  stellarTxId: string | null;
  /** Unix timestamp when the transaction was initiated. */
  startedAt: number;
  /** Unix timestamp of the last status update. */
  updatedAt: number;
  /** Anchor service endpoint used for this transfer. */
  anchorUrl: string;
  /** Optional KYC/verification URL if required by the anchor. */
  kycUrl: string | null;
  /** Optional human-readable error message when status is "error". */
  errorMessage: string | null;
}

/** Event emitted when a SEP-24 transaction status changes. */
export interface Sep24StatusChangedEvent {
  /** The transaction record with updated status. */
  transaction: Sep24TransactionRecord;
  /** The previous status before this change. */
  previousStatus: Sep24Status;
}

// ---------------------------------------------------------------------------
// Auth-Required Trustline Handler Types
// ---------------------------------------------------------------------------

/** Lifecycle status of an auth-required trustline approval. */
export type TrustlineAuthStatus = "required" | "not_required" | "granted";

/** Stellar operation used to grant trustline authorization. */
export type TrustlineAuthOperationType = "setTrustLineFlags" | "allowTrust";

/** A request to authorize a recipient's trustline for an AUTH_REQUIRED asset. */
export interface TrustlineAuthRequest {
  /** Stellar address of the recipient whose trustline needs authorization. */
  recipientId: string;
  /** Asset code (e.g. "USDC"). */
  assetCode: string;
  /** Asset issuer's Stellar address. */
  assetIssuer: string;
  /** Whether the issuer account has the AUTH_REQUIRED flag set. */
  authRequired: boolean;
  /** Current status of this authorization request. */
  status: TrustlineAuthStatus;
  /** Unix timestamp (milliseconds) this request/grant was recorded. */
  requestedAt: number;
  /** Operation type used to grant authorization, set once `status` is "granted". */
  operationType?: TrustlineAuthOperationType;
  /** Submission transaction hash, set once `status` is "granted". */
  txHash?: string;
}

// ---------------------------------------------------------------------------
// SEP-31 Cross-Border Direct Payment Types
// ---------------------------------------------------------------------------

/** Lifecycle status of a SEP-31 direct payment, per the SEP-31 spec. */
export type Sep31Status =
  | "pending_sender"
  | "pending_receiver"
  | "pending_transaction_info_update"
  | "pending_stellar"
  | "pending_external"
  | "completed"
  | "error";

/** Description of a single field required by the receiving anchor's /send endpoint. */
export interface Sep31FieldSpec {
  /** Human-readable description of the field. */
  description: string;
  /** Allowed values, when the field is an enum. */
  choices?: string[];
  /** Whether the field may be omitted. */
  optional?: boolean;
}

/** Typed field schema returned by the receiving anchor's /info endpoint for one asset. */
export interface Sep31RequiredFields {
  /** Minimum payment amount the anchor will accept, if published. */
  minAmount?: number;
  /** Maximum payment amount the anchor will accept, if published. */
  maxAmount?: number;
  /** Additional transaction-level fields the anchor requires (e.g. routing_number). */
  transactionFields: Record<string, Sep31FieldSpec>;
}

/** A record tracking a single SEP-31 cross-border direct payment. */
export interface Sep31PaymentRecord {
  /** Transaction ID returned by the receiving anchor. */
  id: string;
  /** Current lifecycle status. */
  status: Sep31Status;
  /** Asset code (e.g. "USDC"). */
  assetCode: string;
  /** Asset issuer's Stellar address. */
  assetIssuer: string;
  /** Payment amount as a decimal string. */
  amount: string;
  /** Home domain of the receiving anchor. */
  anchorDomain: string;
  /** Stellar transaction ID once the payment settles on-chain. */
  stellarTxId: string | null;
  /** Unix timestamp (milliseconds) the payment was initiated. */
  startedAt: number;
  /** Unix timestamp (milliseconds) of the last status update. */
  updatedAt: number;
  /** Anchor-supplied message describing what additional info is needed, if any. */
  requiredInfoMessage: string | null;
  /** Human-readable error message when status is "error". */
  errorMessage: string | null;
}

/** Event emitted when a SEP-31 payment's status changes. */
export interface Sep31StatusChangedEvent {
  /** The payment record with updated status. */
  payment: Sep31PaymentRecord;
  /** The previous status before this change, or null for the initial creation. */
  previousStatus: Sep31Status | null;
}

// ---------------------------------------------------------------------------
// Horizon Paginator Types
// ---------------------------------------------------------------------------

/**
 * Minimal interface for a Horizon collection page that supports
 * cursor-based pagination via a .next() method.
 */
export interface CollectionPage<T> {
  /** Records in the current page. */
  records: T[];
  /** Fetch the next page, or return null when exhausted. */
  next(): Promise<CollectionPage<T> | null>;
}

/** Configuration options for the horizon paginator. */
export interface HorizonPaginatorOptions {
  /** Maximum number of records to yield across all pages. Default: unlimited. */
  maxRecords?: number;
  /** Optional cursor store for persisting the last-seen paging token. */
  cursorStore?: CursorStore;
  /** Optional namespace for cursor storage keys (default: "horizon"). */
  cursorNamespace?: string;
}

/** Persistence interface for cursor tracking. */
export interface CursorStore {
  /** Save a cursor value under a named key. */
  save(key: string, cursor: string): Promise<void>;
  /** Load a previously saved cursor value, or null if not found. */
  load(key: string): Promise<string | null>;
  /** Delete a saved cursor. */
  delete(key: string): Promise<void>;
}

// ---------------------------------------------------------------------------
// Account Data Entry Types (Issue #528)
// ---------------------------------------------------------------------------

/** A single decoded key-value data entry stored on a Stellar account. */
export interface AccountDataEntry {
  /** Data entry key (max 64 bytes). */
  key: string;
  /** Decoded (UTF-8) value, or null when the entry has been cleared. */
  value: string | null;
}

/** All data entries currently stored on an account, keyed by entry name. */
export type AccountDataMap = Record<string, string>;

// ---------------------------------------------------------------------------
// Soroban Feature Detection Types (Issue #529)
// ---------------------------------------------------------------------------

/**
 * Typed flags for protocol-version-gated Soroban features, plus the raw
 * resource limits pulled from the network's `ConfigSettingEntry` ledger
 * entries.
 */
export interface SorobanFeatureFlags {
  /** Current Stellar protocol version integer. */
  protocolVersion: number;
  /** Whether the network supports the `ExtendFootprintTtl` operation (protocol >= 20). */
  supportsExtendFootprint: boolean;
  /** Whether the network supports archived-entry restoration (protocol >= 20). */
  supportsRestoreFootprint: boolean;
  /** Maximum Soroban instructions allowed per transaction. */
  maxInstructionsPerTx: number;
  /** Maximum Soroban instructions allowed per ledger. */
  maxInstructionsPerLedger: number;
  /** Unix timestamp (ms) when these flags were detected. */
  detectedAt: number;
}

// ---------------------------------------------------------------------------
// Per-Split Audit Log Types (Issue #531)
// ---------------------------------------------------------------------------

/** A granular audit record for a single settled leg of a multi-recipient split payment. */
export interface SplitAuditEntry {
  /** Invoice the split payment belongs to. */
  invoiceId: string;
  /** Zero-based index of this leg within the split. */
  legIndex: number;
  /** Stellar address of the recipient for this leg. */
  recipientId: string;
  /** Asset code paid out for this leg. */
  assetCode: string;
  /** Amount paid to this recipient, in stroops. */
  amount: bigint;
  /** Operation ID of the settlement operation. */
  operationId: string;
  /** Ledger sequence number at which the leg settled. */
  ledgerSequence: number;
  /** Unix timestamp (seconds) when the leg settled. */
  settledAt: number;
}

// ---------------------------------------------------------------------------
// Subentry Capacity Guard Types (Issue #591)
// ---------------------------------------------------------------------------

/**
 * Result of a subentry capacity check for a Stellar account.
 *
 * Derived from live Horizon account data using the protocol reserve formula:
 *   (2 + numSubentries + numSponsoring − numSponsored) × baseReserve
 */
export interface SubentryCapacityResult {
  /** Number of subentry slots currently consumed by the account. */
  used: number;
  /** Number of subentry slots available for new entries. */
  available: number;
  /**
   * Protocol maximum for subentries derived from the account's free XLM
   * balance (i.e., how many more subentries the balance can support beyond
   * the base reserve).
   */
  limit: number;
  /** Whether the account can accommodate the requested number of additional slots. */
  canAccommodate: boolean;
}

/**
 * Describes a subentry capacity shortfall.
 *
 * Thrown by splitExecutor when an account cannot accommodate new subentries
 * (trustlines, data entries, signers, offers) due to insufficient XLM reserve.
 */
export interface SubentryCapacityError {
  /** Stellar address of the account that lacks capacity. */
  accountId: string;
  /** Number of additional XLM (in stroops) required to satisfy the reserve. */
  additionalReserveNeededStroops: bigint;
  /** Number of additional XLM (as decimal string, e.g. "1.5000000") required. */
  additionalReserveNeededXlm: string;
  /** The capacity result that triggered this error. */
  capacityResult: SubentryCapacityResult;
}
