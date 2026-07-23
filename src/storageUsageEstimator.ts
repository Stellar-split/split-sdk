/**
 * Contract storage usage estimator for StellarSplit invoices.
 *
 * Computes the projected ledger byte footprint of batch invoices based on
 * known Soroban data-type sizes, so callers can forecast storage rent before
 * executing transactions.
 */

/** Options controlling which optional invoice features are included. */
export interface StorageEstimationOptions {
  /** Number of recipients per invoice (default: 1). */
  recipientsPerInvoice?: number;
  /** Number of payment tranches per invoice (default: 0). */
  tranches?: number;
  /** Number of additional co-signer public keys per invoice (default: 0). */
  coSigners?: number;
  /** Number of split-rule entries per invoice (default: 0). */
  splitRules?: number;
}

/** Breakdown of the estimated storage footprint. */
export interface StorageEstimationResult {
  /** Byte footprint for a single invoice. */
  bytesPerInvoice: number;
  /** Total byte footprint across all invoices. */
  totalBytes: number;
  /** Rough projected XLM cost for storage rent (in stroops). */
  estimatedRentStroops: number;
}

// ---------------------------------------------------------------------------
// Soroban / Stellar type-size constants
// ---------------------------------------------------------------------------

/** u64 (invoice id, deadline) */
const U64_BYTES = 8;
/** i128 (amounts: funded, per-recipient amount) */
const I128_BYTES = 16;
/** Stellar G-address (56-char base32, stored as 32-byte raw key on ledger) */
const ADDRESS_BYTES = 32;
/** InvoiceStatus enum (u32) */
const STATUS_BYTES = 4;
/** Base ledger-entry envelope overhead Stellar adds per unique key/entry */
const LEDGER_ENTRY_OVERHEAD = 40;

// ---------------------------------------------------------------------------
// Optional-feature incremental sizes
// ---------------------------------------------------------------------------

/** Each tranche: amount (i128) + index (u32) */
const BYTES_PER_TRANCHE = I128_BYTES + 4;
/** Each co-signer: one public key */
const BYTES_PER_COSIGNER = ADDRESS_BYTES;
/** Each split-rule entry: two addresses + a weight (u32) */
const BYTES_PER_SPLIT_RULE = ADDRESS_BYTES * 2 + 4;

// ---------------------------------------------------------------------------
// Rent conversion constant
// ---------------------------------------------------------------------------

/**
 * Approximate Soroban storage-rent rate: ~1 stroop per byte per 1 000 ledgers
 * at a ledger close time of ~5 s, normalised to a 1-year horizon (~6 307 200
 * ledgers).  This is intentionally rough and deterministic.
 */
const STROOPS_PER_BYTE_PER_YEAR = 6_307;

// ---------------------------------------------------------------------------
// Core estimator
// ---------------------------------------------------------------------------

/**
 * Estimate the ledger storage footprint for a batch of invoices.
 *
 * @param invoiceCount  - Number of invoices in the batch (must be ≥ 1).
 * @param optionsUsed   - Optional feature flags and per-invoice counts.
 * @returns             Byte breakdown and rough XLM rent estimate.
 */
export function estimateStorageFootprint(
  invoiceCount: number,
  optionsUsed: StorageEstimationOptions = {}
): StorageEstimationResult {
  if (invoiceCount < 1) {
    throw new RangeError("invoiceCount must be at least 1");
  }

  const {
    recipientsPerInvoice = 1,
    tranches = 0,
    coSigners = 0,
    splitRules = 0,
  } = optionsUsed;

  // --- Baseline core fields ---
  // id (u64) + creator (address) + token (address) + deadline (u64) +
  // funded (i128) + status (u32)
  const coreBytes =
    U64_BYTES +          // id
    ADDRESS_BYTES +      // creator
    ADDRESS_BYTES +      // token
    U64_BYTES +          // deadline
    I128_BYTES +         // funded
    STATUS_BYTES;        // status

  // --- Recipients vector ---
  // Each Recipient: address (32 bytes) + amount i128 (16 bytes)
  const recipientBytes = recipientsPerInvoice * (ADDRESS_BYTES + I128_BYTES);

  // --- Optional features ---
  const trancheBytes = tranches * BYTES_PER_TRANCHE;
  const coSignerBytes = coSigners * BYTES_PER_COSIGNER;
  const splitRuleBytes = splitRules * BYTES_PER_SPLIT_RULE;

  const bytesPerInvoice =
    LEDGER_ENTRY_OVERHEAD +
    coreBytes +
    recipientBytes +
    trancheBytes +
    coSignerBytes +
    splitRuleBytes;

  const totalBytes = bytesPerInvoice * invoiceCount;
  const estimatedRentStroops = totalBytes * STROOPS_PER_BYTE_PER_YEAR;

  return { bytesPerInvoice, totalBytes, estimatedRentStroops };
}
