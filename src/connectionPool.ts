/**
 * Issue #1136: Implement connection pooling
 *
 * Reuses RPC connections instead of creating new ones for each request,
 * providing connection lifecycle management, idle timeouts, health checks,
 * reconnection logic, and statistics monitoring.
 */

export interface ConnectionPoolConfig {
  minConnections?: number;
  maxConnections?: number;
  idleTimeoutMs?: number;
  healthCheckIntervalMs?: number;
}

export interface PoolStats {
  totalConnections: number;
  activeConnections: number;
  idleConnections: number;
  totalAcquired: number;
  totalReleased: number;
  failedHealthChecks: number;
}

export interface ManagedConnection {
  id: string;
  endpoint: string;
  createdAt: number;
  lastUsedAt: number;
  isHealthy: boolean;
  execute<T>(action: () => Promise<T>): Promise<T>;
}

export class RpcConnectionPool {
  private connections: Map<string, ManagedConnection> = new Map();
  private idleQueue: string[] = [];
  private activeSet: Set<string> = new Set();
  private stats: PoolStats = {
    totalConnections: 0,
    activeConnections: 0,
    idleConnections: 0,
    totalAcquired: 0,
    totalReleased: 0,
    failedHealthChecks: 0,
  };

  private minConnections: number;
  private maxConnections: number;
  private idleTimeoutMs: number;

  constructor(
    private readonly defaultEndpoint: string,
    config: ConnectionPoolConfig = {}
  ) {
    this.minConnections = config.minConnections ?? 1;
    this.maxConnections = config.maxConnections ?? 10;
    this.idleTimeoutMs = config.idleTimeoutMs ?? 30000;

    for (let i = 0; i < this.minConnections; i++) {
      this.createConnection();
    }
  }

  private createConnection(): ManagedConnection {
    const id = `conn_${Math.random().toString(36).substring(2, 9)}`;
    const conn: ManagedConnection = {
      id,
      endpoint: this.defaultEndpoint,
      createdAt: Date.now(),
      lastUsedAt: Date.now(),
      isHealthy: true,
      async execute<T>(action: () => Promise<T>): Promise<T> {
        try {
          return await action();
        } catch (err) {
          conn.isHealthy = false;
          throw err;
        }
      },
    };

    this.connections.set(id, conn);
    this.idleQueue.push(id);
    this.updateStats();
    return conn;
  }

  public async acquire(): Promise<ManagedConnection> {
    this.cleanupIdle();

    let connId = this.idleQueue.pop();
    if (!connId) {
      if (this.connections.size < this.maxConnections) {
        const newConn = this.createConnection();
        connId = this.idleQueue.pop()!;
      } else {
        // Wait or reuse oldest
        connId = Array.from(this.connections.keys())[0]!;
      }
    }

    const conn = this.connections.get(connId)!;
    conn.lastUsedAt = Date.now();
    this.activeSet.add(connId);
    this.stats.totalAcquired++;
    this.updateStats();
    return conn;
  }

  public release(conn: ManagedConnection): void {
    if (this.activeSet.has(conn.id)) {
      this.activeSet.delete(conn.id);
      conn.lastUsedAt = Date.now();
      if (conn.isHealthy) {
        this.idleQueue.push(conn.id);
      } else {
        this.connections.delete(conn.id);
        this.stats.failedHealthChecks++;
      }
      this.stats.totalReleased++;
      this.updateStats();
    }
  }

  public checkHealth(): void {
    for (const [id, conn] of this.connections.entries()) {
      if (!conn.isHealthy) {
        this.connections.delete(id);
        const idleIdx = this.idleQueue.indexOf(id);
        if (idleIdx >= 0) this.idleQueue.splice(idleIdx, 1);
        this.activeSet.delete(id);
        this.stats.failedHealthChecks++;
      }
    }
    while (this.connections.size < this.minConnections) {
      this.createConnection();
    }
    this.updateStats();
  }

  private cleanupIdle(): void {
    const now = Date.now();
    if (this.connections.size <= this.minConnections) return;

    this.idleQueue = this.idleQueue.filter((id) => {
      const conn = this.connections.get(id);
      if (!conn) return false;
      if (now - conn.lastUsedAt > this.idleTimeoutMs && this.connections.size > this.minConnections) {
        this.connections.delete(id);
        return false;
      }
      return true;
    });
    this.updateStats();
  }

  private updateStats(): void {
    this.stats.totalConnections = this.connections.size;
    this.stats.activeConnections = this.activeSet.size;
    this.stats.idleConnections = this.idleQueue.length;
  }

  public getStats(): PoolStats {
    return { ...this.stats };
  }

  public destroy(): void {
    this.connections.clear();
    this.idleQueue = [];
    this.activeSet.clear();
    this.updateStats();
  }
}

// ---------------------------------------------------------------------------
// RpcServerPool — a round-robin pool of SorobanRpc.Server instances against
// a single RPC endpoint. Distinct from RpcConnectionPool above (which pools
// generic, endpoint-agnostic ManagedConnection wrappers): this one exists so
// SplitClient can pick an actual `rpc.Server` to issue Soroban RPC calls
// through, spreading load across `poolSize` independent server instances.
// ---------------------------------------------------------------------------

import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { ConnectionPoolConfigError, ConnectionPoolDisposedError } from "./errors.js";

/** Configuration for {@link RpcServerPool}. */
export interface RpcServerPoolConfig {
  /** RPC endpoint URL shared by every server instance in the pool. */
  rpcUrl: string;
  /** Number of independent `SorobanRpc.Server` instances to round-robin across. */
  poolSize: number;
  /** Whether to allow a plain-HTTP (non-TLS) endpoint. Defaults to `false`. */
  allowHttp?: boolean;
}

/**
 * Round-robins Soroban RPC calls across `poolSize` server instances pointed
 * at the same endpoint, so concurrent requests aren't serialized behind a
 * single HTTP keep-alive connection.
 */
export class RpcServerPool {
  private readonly servers: SorobanRpc.Server[];
  private nextIndex = 0;

  constructor(config: RpcServerPoolConfig) {
    const size = Math.max(1, config.poolSize);
    this.servers = Array.from(
      { length: size },
      () => new SorobanRpc.Server(config.rpcUrl, { allowHttp: config.allowHttp ?? false }),
    );
  }

  /** Select the next server in rotation. */
  select(): SorobanRpc.Server {
    const server = this.servers[this.nextIndex % this.servers.length]!;
    this.nextIndex += 1;
    return server;
  }

  /** Snapshot of the pool's current size and rotation position. */
  getStats(): { poolSize: number; nextIndex: number } {
    return { poolSize: this.servers.length, nextIndex: this.nextIndex % this.servers.length };
  }

  /**
   * Release the pool. `SorobanRpc.Server` holds no closable resources of its
   * own (it wraps `fetch`), so this only drops the pool's references.
   */
  dispose(): void {
    this.servers.length = 0;
  }
}

// ---------------------------------------------------------------------------
// ConnectionPool (issue #360) — a load-balanced, self-recycling pool of
// SorobanRpc.Server instances with per-slot request/error/idle tracking.
// ---------------------------------------------------------------------------

export const DEFAULT_POOL_SIZE = 3;
export const MAX_POOL_SIZE = 10;
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

export interface ConnectionPoolOptions {
  rpcUrl: string;
  poolSize?: number;
  allowHttp?: boolean;
  idleTimeoutMs?: number;
  /** Injectable clock, primarily for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export interface ConnectionPoolSlotStats {
  totalRequests: number;
  totalErrors: number;
  inFlight: number;
  lastUsedAt: number | null;
}

export interface ConnectionPoolStats {
  poolSize: number;
  totalRequests: number;
  totalErrors: number;
  totalInFlight: number;
  availableCount: number;
  recycledCount: number;
  perSlot: ConnectionPoolSlotStats[];
}

export interface ConnectionLease {
  server: SorobanRpc.Server;
  release(hasError?: boolean): void;
}

interface PoolSlot {
  server: SorobanRpc.Server;
  inFlight: number;
  totalRequests: number;
  totalErrors: number;
  lastUsedAt: number | null;
  idleTimer: ReturnType<typeof setTimeout> | null;
}

/**
 * Round-robin, least-busy-first pool of `SorobanRpc.Server` instances with
 * idle-slot recycling, per-slot stats, and leased acquire/release semantics.
 */
export class ConnectionPool {
  private readonly rpcUrl: string;
  private readonly allowHttp: boolean;
  private readonly idleTimeoutMs: number;
  private readonly clock: () => number;
  private readonly isHttp: boolean;
  private readonly slots: PoolSlot[];
  private nextIndex = 0;
  private totalRequests = 0;
  private totalErrors = 0;
  private recycledCount = 0;
  private disposed = false;

  constructor(options: ConnectionPoolOptions | string, poolSizeArg?: number, allowHttpArg?: boolean) {
    const resolved: ConnectionPoolOptions =
      typeof options === "string"
        ? { rpcUrl: options, poolSize: poolSizeArg, allowHttp: allowHttpArg }
        : options;

    if (!resolved.rpcUrl) {
      throw new ConnectionPoolConfigError("rpcUrl is required");
    }

    const rawSize = resolved.poolSize ?? DEFAULT_POOL_SIZE;
    if (!Number.isFinite(rawSize)) {
      throw new ConnectionPoolConfigError("poolSize must be a finite number");
    }

    this.rpcUrl = resolved.rpcUrl;
    this.allowHttp = resolved.allowHttp ?? false;
    this.idleTimeoutMs = resolved.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    this.clock = resolved.now ?? (() => Date.now());
    this.isHttp = /^https?:\/\//i.test(this.rpcUrl);

    const size = this.isHttp ? Math.min(MAX_POOL_SIZE, Math.max(1, Math.floor(rawSize))) : 1;
    this.slots = Array.from({ length: size }, () => this.createSlot());
  }

  private createSlot(): PoolSlot {
    return {
      // Non-http schemes never get a real Server instance (the SDK itself
      // rejects insecure endpoints); select()/acquire() reject before this
      // slot's server is ever handed out.
      server: this.isHttp
        ? new SorobanRpc.Server(this.rpcUrl, { allowHttp: this.allowHttp })
        : (null as unknown as SorobanRpc.Server),
      inFlight: 0,
      totalRequests: 0,
      totalErrors: 0,
      lastUsedAt: null,
      idleTimer: null,
    };
  }

  get size(): number {
    return this.slots.length;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  get totalInFlight(): number {
    return this.slots.reduce((sum, slot) => sum + slot.inFlight, 0);
  }

  private assertUsable(): void {
    if (this.disposed) throw new ConnectionPoolDisposedError();
    if (!this.isHttp) {
      throw new ConnectionPoolConfigError(
        `non-http scheme is unsupported by ConnectionPool: ${this.rpcUrl}`,
      );
    }
  }

  private pickSlotIndex(): number {
    let minInFlight = Infinity;
    for (const slot of this.slots) {
      if (slot.inFlight < minInFlight) minInFlight = slot.inFlight;
    }
    for (let offset = 0; offset < this.slots.length; offset++) {
      const idx = (this.nextIndex + offset) % this.slots.length;
      if (this.slots[idx]!.inFlight === minInFlight) {
        this.nextIndex = (idx + 1) % this.slots.length;
        return idx;
      }
    }
    return 0;
  }

  private clearIdleTimer(slot: PoolSlot): void {
    if (slot.idleTimer) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
  }

  private recycleSlot(slot: PoolSlot): void {
    slot.server = new SorobanRpc.Server(this.rpcUrl, { allowHttp: this.allowHttp });
    slot.lastUsedAt = this.clock();
    this.recycledCount++;
  }

  private maybeRecycleForAge(slot: PoolSlot): void {
    if (slot.lastUsedAt !== null && this.clock() - slot.lastUsedAt > this.idleTimeoutMs) {
      this.clearIdleTimer(slot);
      this.recycleSlot(slot);
    }
  }

  private armIdleTimer(slot: PoolSlot): void {
    this.clearIdleTimer(slot);
    const timer = setTimeout(() => {
      slot.idleTimer = null;
      if (slot.inFlight === 0) {
        this.recycleSlot(slot);
      }
    }, this.idleTimeoutMs);
    const maybeNodeTimer = timer as unknown as { unref?: () => void };
    maybeNodeTimer.unref?.();
    slot.idleTimer = timer;
  }

  select(): SorobanRpc.Server {
    this.assertUsable();
    const idx = this.pickSlotIndex();
    const slot = this.slots[idx]!;
    this.maybeRecycleForAge(slot);
    slot.totalRequests++;
    this.totalRequests++;
    slot.lastUsedAt = this.clock();
    return slot.server;
  }

  acquire(): ConnectionLease {
    this.assertUsable();
    const idx = this.pickSlotIndex();
    const slot = this.slots[idx]!;
    this.maybeRecycleForAge(slot);
    this.clearIdleTimer(slot);
    slot.totalRequests++;
    this.totalRequests++;
    slot.lastUsedAt = this.clock();
    slot.inFlight++;

    let released = false;
    return {
      server: slot.server,
      release: (hasError = false) => {
        if (released) return;
        released = true;
        slot.inFlight = Math.max(0, slot.inFlight - 1);
        if (hasError) {
          slot.totalErrors++;
          this.totalErrors++;
        }
        if (slot.inFlight === 0 && !this.disposed) {
          this.armIdleTimer(slot);
        }
      },
    };
  }

  recordError(server: SorobanRpc.Server): void {
    const slot = this.slots.find((candidate) => candidate.server === server);
    if (!slot) return;
    slot.totalErrors++;
    this.totalErrors++;
  }

  getStats(): ConnectionPoolStats {
    return {
      poolSize: this.slots.length,
      totalRequests: this.totalRequests,
      totalErrors: this.totalErrors,
      totalInFlight: this.totalInFlight,
      availableCount: this.slots.filter((slot) => slot.inFlight === 0).length,
      recycledCount: this.recycledCount,
      perSlot: this.slots.map((slot) => ({
        totalRequests: slot.totalRequests,
        totalErrors: slot.totalErrors,
        inFlight: slot.inFlight,
        lastUsedAt: slot.lastUsedAt,
      })),
    };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const slot of this.slots) this.clearIdleTimer(slot);
  }
}
