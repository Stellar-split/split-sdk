import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type { StellarSplitClientConfig } from "./client.js";
import { StellarSplitClient } from "./client.js";

// ---------------------------------------------------------------------------
// Disposable helpers (unchanged from original)
// ---------------------------------------------------------------------------

interface Disposable {
  close(): void;
}

interface DisposableWithDispose {
  dispose(): void;
}

function isDisposable(value: unknown): value is Disposable {
  return (
    typeof value === "object" &&
    value !== null &&
    "close" in value &&
    typeof (value as { close?: unknown }).close === "function"
  );
}

function isDisposableWithDispose(value: unknown): value is DisposableWithDispose {
  return (
    typeof value === "object" &&
    value !== null &&
    "dispose" in value &&
    typeof (value as { dispose?: unknown }).dispose === "function"
  );
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Options for the connection pool. */
export interface PoolOptions {
  /**
   * Maximum number of tenant clients kept alive simultaneously.
   * When exceeded the least-recently-used client is evicted.
   * Default: `Infinity` (no limit).
   */
  maxClients?: number;

  /**
   * Time-to-live in milliseconds for each client.
   * A client that was created more than `ttlMs` ago is evicted on next access.
   * Default: `Infinity` (no TTL).
   */
  ttlMs?: number;

  /**
   * Interval in milliseconds between background health-check sweeps.
   * Each sweep pings every live client's RPC; unhealthy ones are evicted.
   * Set to `0` or omit to disable background checks.
   * Default: `0` (disabled).
   */
  healthCheckIntervalMs?: number;
}

/** Snapshot of pool operational metrics. */
export interface PoolStats {
  /** Number of clients currently in the pool. */
  size: number;
  /** Number of `getClient` calls that returned an existing client. */
  hits: number;
  /** Number of `getClient` calls that created a new client. */
  misses: number;
  /** Total number of clients evicted (LRU + TTL + health-check). */
  evictions: number;
  /** Number of clients evicted specifically due to health-check failure. */
  healthCheckFailures: number;
}

// ---------------------------------------------------------------------------
// Internal pool entry
// ---------------------------------------------------------------------------

interface PoolEntry {
  client: StellarSplitClient;
  /** Unix timestamp (ms) when this entry was created. */
  createdAt: number;
  /** The RPC URL used by this client — needed for health pings. */
  rpcUrl: string;
}

// ---------------------------------------------------------------------------
// MultiTenantClient
// ---------------------------------------------------------------------------

/**
 * Manages a pool of `StellarSplitClient` instances keyed by tenant ID.
 *
 * Features:
 * - **LRU eviction** — when `maxClients` is reached, the least-recently-used
 *   client is evicted before a new one is created.
 * - **TTL eviction** — clients older than `ttlMs` are evicted on next access.
 * - **Background health checks** — a timer pings each client's RPC endpoint
 *   every `healthCheckIntervalMs`; unhealthy clients are removed from the pool.
 * - **`pool.stats()`** — returns a {@link PoolStats} snapshot.
 *
 * @example
 * ```ts
 * const pool = new MultiTenantClient(
 *   (id) => ({ rpcUrl: `https://rpc.example.com/${id}`, … }),
 *   { maxClients: 50, ttlMs: 60_000, healthCheckIntervalMs: 30_000 }
 * );
 *
 * const client = pool.getClient("tenant-xyz");
 * console.log(pool.stats()); // { size: 1, hits: 0, misses: 1, … }
 *
 * pool.destroy(); // stop background timer before process exit
 * ```
 */
export class MultiTenantClient {
  // LRU order: the Map iteration order reflects insertion order; we re-insert
  // on every hit so the most-recently-used entry is always at the end.
  private readonly pool = new Map<string, PoolEntry>();

  private readonly clientFactory: (tenantId: string) => StellarSplitClientConfig;
  private readonly maxClients: number;
  private readonly ttlMs: number;
  private readonly healthCheckIntervalMs: number;

  // Stats counters
  private _hits = 0;
  private _misses = 0;
  private _evictions = 0;
  private _healthCheckFailures = 0;

  // Background health-check timer
  private _healthTimer: ReturnType<typeof setInterval> | null = null;

  constructor(
    clientFactory: (tenantId: string) => StellarSplitClientConfig,
    options: PoolOptions = {}
  ) {
    this.clientFactory = clientFactory;
    this.maxClients = options.maxClients ?? Infinity;
    this.ttlMs = options.ttlMs ?? Infinity;
    this.healthCheckIntervalMs = options.healthCheckIntervalMs ?? 0;

    if (this.healthCheckIntervalMs > 0) {
      this._healthTimer = setInterval(
        () => void this._runHealthChecks(),
        this.healthCheckIntervalMs
      );
      // Allow the Node.js process to exit even if this timer is still active.
      if (this._healthTimer.unref) {
        this._healthTimer.unref();
      }
    }
  }

  // -------------------------------------------------------------------------
  // getClient
  // -------------------------------------------------------------------------

  /**
   * Return the pooled client for `tenantId`, or create a new one.
   *
   * TTL is checked on every access; an expired client is evicted and a fresh
   * one created in its place. LRU order is updated on every hit.
   *
   * @param tenantId - Unique identifier for the tenant.
   * @param config   - Optional config override; only used when creating a new
   *                   client (ignored for cache hits).
   */
  getClient(tenantId: string, config?: StellarSplitClientConfig): StellarSplitClient {
    const existing = this.pool.get(tenantId);

    if (existing) {
      // TTL check
      if (this.ttlMs !== Infinity && Date.now() - existing.createdAt > this.ttlMs) {
        this._evict(tenantId, existing);
        // fall through to create a new one
      } else {
        // LRU refresh: re-insert at end of Map
        this.pool.delete(tenantId);
        this.pool.set(tenantId, existing);
        this._hits++;
        return existing.client;
      }
    }

    // Cache miss — create a new client
    this._misses++;

    // Enforce maxClients: evict LRU (first entry in the Map)
    if (this.pool.size >= this.maxClients) {
      const lruKey = this.pool.keys().next().value as string;
      const lruEntry = this.pool.get(lruKey)!;
      this._evict(lruKey, lruEntry);
    }

    const resolvedConfig = config ?? this.clientFactory(tenantId);
    const client = new StellarSplitClient(resolvedConfig);
    const rpcUrl = Array.isArray(resolvedConfig.rpcUrl)
      ? resolvedConfig.rpcUrl[0] ?? ""
      : resolvedConfig.rpcUrl;

    this.pool.set(tenantId, { client, createdAt: Date.now(), rpcUrl });
    return client;
  }

  // -------------------------------------------------------------------------
  // evict / evictAll
  // -------------------------------------------------------------------------

  /**
   * Evict the client for a specific tenant.
   * @returns `true` if a client was evicted, `false` if not found.
   */
  evict(tenantId: string): boolean {
    const entry = this.pool.get(tenantId);
    if (!entry) return false;
    this._evict(tenantId, entry);
    return true;
  }

  /** Evict all pooled clients and reset stats. */
  evictAll(): void {
    for (const [tenantId, entry] of Array.from(this.pool.entries())) {
      this._evict(tenantId, entry);
    }
  }

  // -------------------------------------------------------------------------
  // stats
  // -------------------------------------------------------------------------

  /** Return a snapshot of pool operational metrics. */
  stats(): PoolStats {
    return {
      size: this.pool.size,
      hits: this._hits,
      misses: this._misses,
      evictions: this._evictions,
      healthCheckFailures: this._healthCheckFailures,
    };
  }

  // -------------------------------------------------------------------------
  // destroy
  // -------------------------------------------------------------------------

  /**
   * Stop the background health-check timer and evict all clients.
   * Call this before process exit to avoid resource leaks.
   */
  destroy(): void {
    if (this._healthTimer !== null) {
      clearInterval(this._healthTimer);
      this._healthTimer = null;
    }
    this.evictAll();
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  /** Dispose a client and remove it from the pool, incrementing the counter. */
  private _evict(tenantId: string, entry: PoolEntry): void {
    this.pool.delete(tenantId);
    this._evictions++;

    const { client } = entry;
    if (isDisposable(client)) {
      client.close();
    } else if (isDisposableWithDispose(client)) {
      client.dispose();
    }
  }

  /**
   * Background health-check sweep.
   * Pings every pooled client's RPC endpoint; evicts those that return
   * status "down".
   */
  private async _runHealthChecks(): Promise<void> {
    const entries = Array.from(this.pool.entries());

    await Promise.all(
      entries.map(async ([tenantId, entry]) => {
        try {
          const server = new SorobanRpc.Server(entry.rpcUrl, {
            allowHttp: entry.rpcUrl.startsWith("http://"),
          });
          const ledger = await server.getLatestLedger();
          // Any truthy response is healthy
          if (!ledger) {
            throw new Error("No ledger response");
          }
        } catch {
          // Health check failed — evict the client
          const current = this.pool.get(tenantId);
          if (current === entry) {
            this._healthCheckFailures++;
            this._evict(tenantId, entry);
          }
        }
      })
    );
  }
}
