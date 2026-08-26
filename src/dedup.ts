import { createHash } from "crypto";

const _knownKeys = new Set<string>();

export function generateIdempotencyKey(params: {
  invoiceId: string;
  payer: string;
  amount: bigint;
  nonce?: string;
}): string {
  const base = `${params.invoiceId}:${params.payer}:${params.amount.toString()}`;
  const input = params.nonce !== undefined ? `${base}:${params.nonce}` : base;
  return createHash("sha256").update(input).digest("hex");
}

export function isKnownKey(key: string): boolean {
  return _knownKeys.has(key);
}

export function registerKey(key: string): void {
  _knownKeys.add(key);
}

export function clearKeys(): void {
  _knownKeys.clear();
}

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
