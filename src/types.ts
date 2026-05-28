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

/** An invoice template for reuse. */
export interface InvoiceTemplate {
  /** Template name. */
  name: string;
  /** Recipients and their owed amounts. */
  recipients: Recipient[];
  /** USDC token contract address. */
  token: string;
}
