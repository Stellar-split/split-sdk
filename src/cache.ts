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
