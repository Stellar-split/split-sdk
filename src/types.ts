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

/** Parameters for paying toward an invoice. */
export interface PayParams {
  /** Stellar address of the payer (must sign). */
  payer: string;
  /** Invoice ID to pay toward. */
  invoiceId: string;
  /** Amount to pay in stroops. */
  amount: bigint;
}

/** Result of a USDC approval check/submission. */
export interface ApprovalResult {
  /** Whether the allowance was already sufficient (no tx) or approval was submitted. */
  approved: boolean;
  /** Transaction hash, present only when an approval tx was submitted. */
  txHash?: string;
}

/** Aggregate analytics for an address across all invoices. */
export interface InvoiceAnalytics {
  /** Number of invoices created by this address. */
  totalCreated: number;
  /** Number of invoices where this address is a recipient. */
  totalReceived: number;
  /** Total funded volume across created invoices in stroops. */
  totalVolumeCreated: bigint;
  /** Total funded volume across received invoices in stroops. */
  totalVolumeReceived: bigint;
  /** Ratio of Released / (Released + Refunded) across created invoices (0 if none settled). */
  successRate: number;
  /** Average funded amount across created invoices in stroops (0n if none). */
  avgAmount: bigint;
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
