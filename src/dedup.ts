import { createHash } from "crypto";

export class Deduplicator<T> {
  private _inflight = new Map<string, Promise<T>>();
  private _hits = 0;
  private _misses = 0;

  dedupe(key: string, fn: () => Promise<T>): Promise<T> {
    const existing = this._inflight.get(key);
    if (existing) {
      this._hits++;
      return existing;
    }
    this._misses++;
    const promise = fn().finally(() => this._inflight.delete(key));
    this._inflight.set(key, promise);
    return promise;
  }

  get cacheHitRate(): number {
    const total = this._hits + this._misses;
    return total === 0 ? 0 : this._hits / total;
  }

  getDedupStats(): { deduped: number; total: number } {
    return { deduped: this._hits, total: this._hits + this._misses };
  }
}

/**
 * Parameters used to derive a deterministic idempotency key for payments.
 */
export interface IdempotencyParams {
  /** Unique identifier of the invoice being paid. */
  invoiceId: string;
  /** Stellar address of the payer. */
  payer: string;
  /** Payment amount in stroops/smallest unit. */
  amount: bigint;
  /** Optional client-provided nonce or entropy token. */
  nonce?: string;
}

const registeredKeys = new Set<string>();

/**
 * Generates a canonical, deterministic idempotency key for payment deduplication.
 *
 * Computes the SHA-256 hex digest of `"{invoiceId}:{payer}:{amount}"`
 * or `"{invoiceId}:{payer}:{amount}:{nonce}"` if a nonce is provided.
 *
 * @param params - The payment parameters: invoiceId, payer, amount, and optional nonce.
 * @returns Deterministic 64-character hex SHA-256 hash.
 */
export function generateIdempotencyKey(params: IdempotencyParams): string {
  const { invoiceId, payer, amount, nonce } = params;
  const canonical =
    nonce !== undefined && nonce !== null && nonce !== ""
      ? `${invoiceId}:${payer}:${amount.toString()}:${nonce}`
      : `${invoiceId}:${payer}:${amount.toString()}`;

  return createHash("sha256").update(canonical).digest("hex");
}

/**
 * Returns `true` if the idempotency key has already been registered in memory.
 *
 * @param key - The 64-char hex idempotency key to check.
 */
export function isKnownKey(key: string): boolean {
  return registeredKeys.has(key);
}

/**
 * Registers an idempotency key in memory to prevent duplicate executions.
 *
 * @param key - The 64-char hex idempotency key to register.
 */
export function registerKey(key: string): void {
  registeredKeys.add(key);
}

/**
 * Clears all registered idempotency keys from memory (useful for test teardown).
 */
export function clearKeys(): void {
  registeredKeys.clear();
}

