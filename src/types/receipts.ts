/** Types for {@link ../receipts/ReceiptChain.js | ReceiptChain}'s tamper-evident payment history. */

/**
 * A single payment record hashed into a {@link ReceiptChain}.
 *
 * `amount` is a decimal stroop string rather than `bigint` because chain
 * entries are hashed via `JSON.stringify`, which cannot serialize `bigint`.
 */
export interface PaymentReceipt {
  invoiceId: string;
  paymentId: string;
  /** Amount in stroops, as a decimal string. */
  amount: string;
  recipientId: string;
  txHash: string;
  ledger: number;
  /** Unix timestamp (milliseconds). */
  timestamp: number;
  /**
   * Network fee paid for this transaction, in stroops (1 XLM = 10,000,000 stroops).
   * Optional for backward compatibility with existing serialised receipts.
   */
  networkFeeStroops?: number;
}

/** One SHA-256-linked entry in a {@link ReceiptChain}. */
export interface ReceiptChainEntry {
  receipt: PaymentReceipt;
  /** Hash of the previous entry, or `"0".repeat(64)` for the genesis entry. */
  prevHash: string;
  /** SHA-256 of `{ ...receipt, prevHash }`, hex-encoded. */
  hash: string;
}

/** Result of walking a {@link ReceiptChain} to check for tampering. */
export interface ChainVerificationResult {
  valid: boolean;
  /** Number of entries in the chain. */
  length: number;
  /** Index of the first entry that fails verification, if `valid` is `false`. */
  brokenAt?: number;
  /** Human-readable explanation of why verification failed, if `valid` is `false`. */
  reason?: string;
}
