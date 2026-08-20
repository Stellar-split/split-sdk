import { createHash } from "node:crypto";

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

/** @internal In-memory set of known idempotency keys. */
const _knownKeys = new Set<string>();

/**
 * Parameters for building a canonical idempotency key.
 */
export interface GenerateIdempotencyKeyParams {
  /** The invoice or resource identifier. */
  invoiceId: string;
  /** The payer account address. */
  payer: string;
  /** The payment amount as a bigint to avoid floating-point ambiguity. */
  amount: bigint;
  /** Optional nonce to force a distinct key for otherwise identical submissions. */
  nonce?: string;
}

/**
 * Build a deterministic idempotency key from the given parameters.
 *
 * The key is a SHA-256 hex digest of the canonical string
 * `"{invoiceId}:{payer}:{amount}"` with an optional `:{nonce}` suffix.
 * Same inputs always produce the same output; different inputs produce
 * different outputs with high probability.
 */
export function generateIdempotencyKey(params: GenerateIdempotencyKeyParams): string {
  const { invoiceId, payer, amount, nonce } = params;
  const base = `${invoiceId}:${payer}:${amount}`;
  const input = nonce !== undefined ? `${base}:${nonce}` : base;
  return createHash("sha256").update(input, "utf-8").digest("hex");
}

/**
 * Check whether `key` has already been registered.
 */
export function isKnownKey(key: string): boolean {
  return _knownKeys.has(key);
}

/**
 * Register `key` in the in-memory known-key set.
 */
export function registerKey(key: string): void {
  _knownKeys.add(key);
}

/**
 * Clear all known keys — intended for test teardown.
 */
export function clearKeys(): void {
  _knownKeys.clear();
}
