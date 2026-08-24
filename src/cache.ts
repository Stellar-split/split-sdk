/**
 * Simple in-memory cache with per-entry TTL.
 *
 * Used by StellarSplitClient to avoid redundant RPC calls for read-heavy
 * operations like getInvoice().
 */

export interface CacheStats {
  hits: number;
  misses: number;
  size: number;
  keys: string[];
  evictions: number;
}

export interface MethodCacheEntry {
  value: any;
  expiresAt: number;
}

export class SimpleCache<T> {
  private readonly store = new Map<string, MethodCacheEntry>();
  private readonly ttlConfig: Record<string, number>;
  private enabled: boolean;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private maxEntries: number;

  constructor(config?: number | { enabled?: boolean; ttl?: Record<string, number>; ttlMs?: number; maxEntries?: number }) {
    if (typeof config === "number") {
      this.enabled = true;
      this.maxEntries = 1000;
      this.ttlConfig = { default: config };
    } else {
      this.enabled = config?.enabled ?? (config?.ttl !== undefined || config?.ttlMs !== undefined);
      this.maxEntries = config?.maxEntries ?? (this.enabled ? 1000 : 0);
      this.ttlConfig = config?.ttl ?? {};
      if (config?.ttlMs !== undefined) {
        this.ttlConfig["default"] = config.ttlMs;
      }
    }
  }

  get(key: string): T | undefined {
    if (!this.enabled) return undefined;
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      return undefined;
    }
    
    // Update LRU order
    this.store.delete(key);
    this.store.set(key, entry);

    this.hits++;
    return entry.value;
  }

  set(key: string, value: T): void {
    if (!this.enabled) return;
    const method = key.split(":")[0] || key;
    const ttl = this.ttlConfig[method] ?? this.ttlConfig["default"] ?? 0;
    if (ttl <= 0) return;

    if (this.maxEntries > 0 && this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
        this.evictions++;
      }
    }

    this.store.set(key, { value, expiresAt: Date.now() + ttl });
  }

  invalidate(methodOrKey?: string, args?: any[]): void {
    if (!methodOrKey) {
      this.store.clear();
      return;
    }
    if (args) {
      const key = `${methodOrKey}:${JSON.stringify(args)}`;
      this.store.delete(key);
      return;
    }
    
    // Check if it's an exact key
    if (this.store.has(methodOrKey)) {
      this.store.delete(methodOrKey);
    }
    
    // Invalidate by method prefix
    const prefix = `${methodOrKey}:`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
      }
    }
  }

  clear(): void {
    this.store.clear();
  }

  getStats(): CacheStats {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
      }
    }
    return {
      hits: this.hits,
      misses: this.misses,
      size: this.store.size,
      keys: Array.from(this.store.keys()),
      evictions: this.evictions,
    };
  }

  entries(): Map<string, T> {
    const now = Date.now();
    const result = new Map<string, T>();
    for (const [key, entry] of this.store) {
      if (now <= entry.expiresAt) result.set(key, entry.value);
    }
    return result;
  }

  replaceAll(next: Map<string, T>): void {
    this.store.clear();
    for (const [key, value] of next) {
      this.set(key, value);
    }
  }
}

/**
 * A lightweight, generic in-memory cache with optional TTL-based entry expiry.
 *
 * When `ttlMs` is omitted entries never expire, preserving backward-compatible
 * behaviour.  When supplied, `get()` and `has()` silently evict stale entries
 * on access, and `purgeExpired()` sweeps the entire store in one pass.
 *
 * Usage:
 *   const cache = new Cache<Invoice>(30_000); // 30-second TTL
 *   cache.set("inv:1", invoice);
 *   cache.get("inv:1"); // undefined after 30 s
 */
interface CacheEntry<V> {
  value: V;
  /** Unix ms timestamp recorded at write time. */
  writtenAt: number;
}

export class Cache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly ttlMs: number | undefined;

  /**
   * @param ttlMs  Time-to-live in milliseconds.  Omit (or pass `undefined`)
   *               for no-expiry behaviour.
   */
  constructor(ttlMs?: number) {
    this.ttlMs = ttlMs;
  }

  /**
   * Store `value` under `key`, recording the current wall-clock time.
   */
  set(key: string, value: V): void {
    this.store.set(key, { value, writtenAt: Date.now() });
  }

  /**
   * Retrieve the value for `key`.
   *
   * Returns `undefined` and **deletes the entry** when the entry is expired
   * (i.e. `Date.now() - writtenAt > ttlMs`).  Returns `undefined` for
   * missing keys regardless of TTL configuration.
   */
  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) return undefined;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return undefined;
    }
    return entry.value;
  }

  /**
   * Returns `true` only when the key exists **and** is not expired.
   * Expired entries are deleted as a side-effect.
   */
  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      return false;
    }
    return true;
  }

  /**
   * Remove all entries whose TTL has elapsed in a single sweep.
   * No-op when no TTL is configured.
   */
  purgeExpired(): void {
    if (this.ttlMs === undefined) return;
    for (const [key, entry] of this.store) {
      if (this.isExpired(entry)) {
        this.store.delete(key);
      }
    }
  }

  /** Remove a specific entry by key. */
  delete(key: string): void {
    this.store.delete(key);
  }

  /** Remove all entries. */
  clear(): void {
    this.store.clear();
  }

  /** Number of entries currently in the store (including not-yet-evicted expired ones). */
  get size(): number {
    return this.store.size;
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private isExpired(entry: CacheEntry<V>): boolean {
    if (this.ttlMs === undefined) return false;
    return Date.now() - entry.writtenAt > this.ttlMs;
  }
}
