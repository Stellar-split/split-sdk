/**
 * Simple in-memory cache with per-entry TTL.
 *
 * Used by StellarSplitClient to avoid redundant RPC calls for read-heavy
 * operations like getInvoice().
 */

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

export class SimpleCache<T> {
  private readonly store = new Map<string, CacheEntry<T>>();
  private readonly ttlMs: number;

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /** Return the cached value if present and not expired, otherwise undefined. */
  get(key: string): T | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /** Store a value under the given key with the configured TTL. */
  set(key: string, value: T): void {
    this.store.set(key, { value, expiresAt: Date.now() + this.ttlMs });
  }

  /** Remove a specific entry (e.g. after a write operation). */
  invalidate(key: string): void {
    this.store.delete(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.store.clear();
  }
}
