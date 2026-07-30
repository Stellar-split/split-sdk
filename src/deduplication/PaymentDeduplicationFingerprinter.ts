/**
 * PaymentDeduplicationFingerprinter — content-based payment deduplication.
 *
 * Computes a SHA-256 fingerprint for each payment (invoiceId + payerId +
 * amount + sorted recipientIds + time-window bucket) and rejects any
 * submission whose fingerprint matches a recently recorded payment within
 * a configurable sliding window.
 *
 * Issue #478
 */

import { DuplicatePaymentError } from "../errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

export interface DeduplicationPayment {
  invoiceId: string;
  payerId: string;
  /** Amount as a string or number (stroops). */
  amount: string | number | bigint;
  /** List of recipient addresses. Order does not matter — sorted internally. */
  recipientIds: string[];
  /** Optional explicit timestamp (ms). Defaults to Date.now(). */
  timestamp?: number;
}

export interface CheckResult {
  isDuplicate: boolean;
  /** Present when isDuplicate is true. */
  existingTxHash?: string;
  fingerprint: string;
}

// ---------------------------------------------------------------------------
// Internal store entry
// ---------------------------------------------------------------------------

interface FingerprintEntry {
  txHash: string;
  submittedAt: number;
}

// ---------------------------------------------------------------------------
// PaymentDeduplicationFingerprinter
// ---------------------------------------------------------------------------

export class PaymentDeduplicationFingerprinter {
  /** Deduplication window in milliseconds. Default: 300 000 ms (5 min). */
  private readonly windowMs: number;
  /** Map from fingerprint hex → entry. */
  private readonly store = new Map<string, FingerprintEntry>();

  constructor(windowMs = 300_000) {
    this.windowMs = windowMs;
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Computes the fingerprint for a payment and checks whether a duplicate
   * exists within the current time window.
   *
   * Evicts expired entries before checking.
   */
  async check(payment: DeduplicationPayment): Promise<CheckResult> {
    const now = payment.timestamp ?? Date.now();
    this._evict(now);

    const fingerprint = await this._fingerprint(payment, now);
    const entry = this.store.get(fingerprint);

    if (entry) {
      return { isDuplicate: true, existingTxHash: entry.txHash, fingerprint };
    }

    return { isDuplicate: false, fingerprint };
  }

  /**
   * Records a successfully submitted payment fingerprint.
   * Call this after a payment has been accepted by the network.
   */
  async record(payment: DeduplicationPayment, txHash: string): Promise<void> {
    const now = payment.timestamp ?? Date.now();
    const fingerprint = await this._fingerprint(payment, now);
    this.store.set(fingerprint, { txHash, submittedAt: now });
  }

  /**
   * Checks for duplicate and throws DuplicatePaymentError if one is found.
   *
   * @throws {DuplicatePaymentError}
   */
  async assertNotDuplicate(payment: DeduplicationPayment): Promise<string> {
    const result = await this.check(payment);
    if (result.isDuplicate) {
      const entry = this.store.get(result.fingerprint)!;
      throw new DuplicatePaymentError(
        result.fingerprint,
        result.existingTxHash!,
        entry.submittedAt,
      );
    }
    return result.fingerprint;
  }

  /** Returns the number of active (non-expired) entries in the store. */
  get size(): number {
    const now = Date.now();
    this._evict(now);
    return this.store.size;
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * SHA-256(invoiceId + payerId + amount + sortedRecipients + windowBucket)
   *
   * The window bucket is computed as Math.floor(timestamp / windowMs), which
   * means every payment within the same window maps to the same bucket.
   */
  private async _fingerprint(
    payment: DeduplicationPayment,
    now: number,
  ): Promise<string> {
    const windowBucket = Math.floor(now / this.windowMs);
    const sortedRecipients = [...payment.recipientIds].sort().join(",");
    const raw = [
      payment.invoiceId,
      payment.payerId,
      String(payment.amount),
      sortedRecipients,
      String(windowBucket),
    ].join("|");

    const encoder = new TextEncoder();
    const data = encoder.encode(raw);
    const hashBuffer = await crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  /**
   * Evicts store entries whose submittedAt is older than the window.
   */
  private _evict(now: number): void {
    for (const [key, entry] of this.store) {
      if (now - entry.submittedAt >= this.windowMs) {
        this.store.delete(key);
      }
    }
  }
}
