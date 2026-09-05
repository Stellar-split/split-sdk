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

// In-memory key registry for idempotency tracking (#612)
const _knownKeys = new Set<string>();

/**
 * Generates a deterministic idempotency key from payment parameters.
 * The key is a SHA-256 hex digest of `"{invoiceId}:{payer}:{amount}"`
 * with an optional `:{nonce}` suffix when provided.
 */
export function generateIdempotencyKey(params: {
  invoiceId: string;
  payer: string;
  amount: bigint;
  nonce?: string;
}): string {
  const payload = params.nonce
    ? `${params.invoiceId}:${params.payer}:${params.amount}:${params.nonce}`
    : `${params.invoiceId}:${params.payer}:${params.amount}`;
  return createHash("sha256").update(payload).digest("hex");
}

/** Returns true if the key has already been registered. */
export function isKnownKey(key: string): boolean {
  return _knownKeys.has(key);
}

/** Registers a key as known (idempotent). */
export function registerKey(key: string): void {
  _knownKeys.add(key);
}

/** Clears the in-memory key registry. Intended for test teardown. */
export function clearKeys(): void {
  _knownKeys.clear();
}
