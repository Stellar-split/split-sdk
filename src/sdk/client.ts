/**
 * SDK client with request deduplication, response caching, and timeouts.
 */

export interface RequestOptions {
  method?: string;
  path: string;
  params?: Record<string, unknown>;
  body?: unknown;
  /** Per-request timeout in ms. Overrides client default. */
  timeoutMs?: number;
  /** Skip dedup/cache for this request. */
  noDedup?: boolean;
}

export interface DedupConfig {
  /** Enable request deduplication. Default: true. */
  enabled?: boolean;
  /** Cache TTL in ms for resolved responses. 0 disables caching. Default: 0. */
  cacheTtlMs?: number;
  /** Default timeout in ms for deduped/cached requests. Default: 30000. */
  timeoutMs?: number;
}

export interface DedupStats {
  /** Requests served from an in-flight deduped promise. */
  deduped: number;
  /** Requests served from the response cache. */
  cached: number;
  /** Requests that actually hit the transport. */
  executed: number;
  /** Requests that timed out. */
  timedOut: number;
}

export type Transport = (req: RequestOptions) => Promise<unknown>;

interface CacheEntry {
  value: unknown;
  expiresAt: number;
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") +
    "}"
  );
}

function requestKey(req: RequestOptions): string {
  const method = (req.method ?? "GET").toUpperCase();
  return [
    method,
    req.path,
    stableStringify(req.params ?? {}),
    req.body === undefined ? "" : stableStringify(req.body),
  ].join("|");
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`Request timed out after ${timeoutMs}ms`));
    }, timeoutMs);
    promise.then(
      (v) => {
        clearTimeout(timer);
        resolve(v);
      },
      (e) => {
        clearTimeout(timer);
        reject(e);
      },
    );
  });
}

export class SdkClient {
  private readonly transport: Transport;
  private readonly config: Required<DedupConfig>;
  private readonly inflight = new Map<string, Promise<unknown>>();
  private readonly cache = new Map<string, CacheEntry>();
  private readonly stats: DedupStats = {
    deduped: 0,
    cached: 0,
    executed: 0,
    timedOut: 0,
  };

  constructor(transport: Transport, config: DedupConfig = {}) {
    this.transport = transport;
    this.config = {
      enabled: config.enabled ?? true,
      cacheTtlMs: config.cacheTtlMs ?? 0,
      timeoutMs: config.timeoutMs ?? 30000,
    };
  }

  /** Snapshot of dedup/cache tracking counters. */
  getStats(): DedupStats {
    return { ...this.stats };
  }

  /** Clear cached responses. */
  clearCache(): void {
    this.cache.clear();
  }

  async request<T = unknown>(req: RequestOptions): Promise<T> {
    const useDedup = this.config.enabled && !req.noDedup;
    const key = requestKey(req);
    const timeoutMs = req.timeoutMs ?? this.config.timeoutMs;

    if (useDedup) {
      const cached = this.cache.get(key);
      if (cached && cached.expiresAt > Date.now()) {
        this.stats.cached++;
        return cached.value as T;
      }
      if (cached) this.cache.delete(key);

      const existing = this.inflight.get(key);
      if (existing) {
        this.stats.deduped++;
        return withTimeout(existing, timeoutMs) as Promise<T>;
      }
    }

    this.stats.executed++;
    const promise = withTimeout(this.transport(req), timeoutMs).catch((err) => {
      if (err instanceof Error && /timed out/.test(err.message)) {
        this.stats.timedOut++;
      }
      throw err;
    });

    if (useDedup) {
      this.inflight.set(key, promise);
      promise.then(
        (value) => {
          this.inflight.delete(key);
          if (this.config.cacheTtlMs > 0) {
            this.cache.set(key, {
              value,
              expiresAt: Date.now() + this.config.cacheTtlMs,
            });
          }
        },
        () => {
          this.inflight.delete(key);
        },
      );
    }

    return promise as Promise<T>;
  }
}
