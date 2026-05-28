/** Result of a dispute-related transaction. */
export interface DisputeResult {
  disputeId: string;
  txHash: string;
}

/** Parameters for an arbiter's vote on a dispute. */
export interface ArbiterVote {
  invoiceId: string;
  arbiter: string;
  approve: boolean;
}
/** Lifecycle status of an invoice. */
export type InvoiceStatus = "Pending" | "Released" | "Refunded";

/** A single payment made toward an invoice. */
export interface Payment {
  /** Stellar address of the payer. */
  payer: string;
  /** Amount paid in stroops (1 XLM = 10_000_000 stroops). */
  amount: bigint;
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
}

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

/** Vesting schedule for an invoice with cliff and drip. */
export interface VestingSchedule {
  /** Unix timestamp of the cliff date. */
  cliffDate: number;
  /** Unix timestamp when fully vested. */
  fullyVestedDate: number;
  /** Returns the claimable amount at a given Unix timestamp. */
  claimableAt(timestamp: number): bigint;
}

/** Event emitted when a contract WASM upgrade is detected. */
export interface UpgradeEvent {
  previousHash: string;
  newHash: string;
  detectedAt: number;
}
