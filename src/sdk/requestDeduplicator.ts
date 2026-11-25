/**
 * SDK request deduplication.
 *
 * Coalesces identical concurrent requests into a single in-flight promise,
 * caches resolved responses with a configurable TTL, enforces timeouts, and
 * tracks dedup/cache statistics.
 */

export interface RequestIdentity {
  method: string;
  path: string;
  params?: Record<string, unknown>;
}

export interface DeduplicatorOptions {
  /** Time-to-live for cached responses in ms. 0 disables caching. */
  cacheTtlMs?: number;
  /** Maximum time a request may take before rejecting, in ms. */
  timeoutMs?: number;
  /** Maximum number of cached entries. Oldest entries evicted first. */
  maxCacheSize?: number;
}

export interface DedupStats {
  /** Total requests submitted through the deduplicator. */
  total: number;
  /** Requests served from cache. */
  cacheHits: number;
  /** Requests coalesced onto an in-flight promise. */
  deduped: number;
  /** Requests that actually executed the underlying function. */
  executed: number;
  /** Requests that timed out. */
  timeouts: number;
}

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const DEFAULT_CACHE_TTL_MS = 30_000;
const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CACHE_SIZE = 500;

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'undefined';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableStringify).join(',')}]`;
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

/** Builds a stable cache key from a request identity. */
export function buildRequestKey(identity: RequestIdentity): string {
  const params = identity.params ? stableStringify(identity.params) : '';
  return `${identity.method.toUpperCase()} ${identity.path} ${params}`;
}

export class RequestDeduplicator {
  private readonly cacheTtlMs: number;
  private readonly timeoutMs: number;
  private readonly maxCacheSize: number;
  private readonly cache = new Map<string, CacheEntry<unknown>>();
  private readonly inFlight = new Map<string, Promise<unknown>>();
  private readonly stats: DedupStats = {
    total: 0,
    cacheHits: 0,
    deduped: 0,
    executed: 0,
    timeouts: 0,
  };

  constructor(options: DeduplicatorOptions = {}) {
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_CACHE_TTL_MS;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxCacheSize = options.maxCacheSize ?? DEFAULT_MAX_CACHE_SIZE;
  }

  /**
   * Executes `fn`, coalescing identical concurrent requests and serving
   * cached responses when available.
   */
  async execute<T>(
    identity: RequestIdentity,
    fn: () => Promise<T>,
  ): Promise<T> {
    const key = buildRequestKey(identity);
    this.stats.total += 1;

    const cached = this.getFromCache<T>(key);
    if (cached !== undefined) {
      this.stats.cacheHits += 1;
      return cached;
    }

    const existing = this.inFlight.get(key) as Promise<T> | undefined;
    if (existing) {
      this.stats.deduped += 1;
      return existing;
    }

    this.stats.executed += 1;
    const promise = this.runWithTimeout(fn)
      .then((value) => {
        this.setCache(key, value);
        return value;
      })
      .finally(() => {
        this.inFlight.delete(key);
      });

    this.inFlight.set(key, promise);
    return promise;
  }

  /** Returns a snapshot of dedup/cache statistics. */
  getStats(): DedupStats {
    return { ...this.stats };
  }

  /** Clears cached responses and in-flight tracking. */
  clear(): void {
    this.cache.clear();
    this.inFlight.clear();
  }

  private runWithTimeout<T>(fn: () => Promise<T>): Promise<T> {
    if (this.timeoutMs <= 0) {
      return fn();
    }
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stats.timeouts += 1;
        reject(new Error(`Request timed out after ${this.timeoutMs}ms`));
      }, this.timeoutMs);
      fn().then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }

  private getFromCache<T>(key: string): T | undefined {
    if (this.cacheTtlMs <= 0) {
      return undefined;
    }
    const entry = this.cache.get(key) as CacheEntry<T> | undefined;
    if (!entry) {
      return undefined;
    }
    if (entry.expiresAt <= Date.now()) {
      this.cache.delete(key);
      return undefined;
    }
    return entry.value;
  }

  private setCache<T>(key: string, value: T): void {
    if (this.cacheTtlMs <= 0) {
      return;
    }
    if (this.cache.size >= this.maxCacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, { value, expiresAt: Date.now() + this.cacheTtlMs });
  }
}
