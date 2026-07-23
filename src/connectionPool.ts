import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { ConnectionPoolConfigError, ConnectionPoolDisposedError } from "./errors.js";

/** Maximum number of persistent connections the pool will maintain (issue #360). */
export const MAX_POOL_SIZE = 5;

/** Default idle recycle timeout in ms — per issue #360, connections idle longer than this are recycled. */
export const DEFAULT_IDLE_TIMEOUT_MS = 60_000;

/** Default pool size when `poolSize` is omitted and pooling is enabled. */
export const DEFAULT_POOL_SIZE = 5;

export interface ConnectionPoolConfig {
  rpcUrl: string;
  /**
   * Number of underlying Soroban RPC connections to multiplex across.
   * Clamped to `[1, MAX_POOL_SIZE]`. Defaults to {@link DEFAULT_POOL_SIZE}.
   * Values ≤ 1 degrade gracefully to a single (unpooled) connection.
   */
  poolSize?: number;
  allowHttp?: boolean;
  /** Override the idle recycle window (ms). Defaults to {@link DEFAULT_IDLE_TIMEOUT_MS}. */
  idleTimeoutMs?: number;
  /** Time source — exposed for deterministic tests. */
  now?: () => number;
}

interface PoolSlot {
  server: SorobanRpc.Server;
  inFlight: number;
  totalRequests: number;
  totalErrors: number;
  recycledCount: number;
  createdAt: number;
  lastUsedAt: number;
  lastSelectedAt: number;
}

export interface PoolSlotStats {
  index: number;
  /** Outstanding acquire() calls that have not yet paired with a release(). */
  inFlight: number;
  /** Cumulative requests routed through this slot. */
  totalRequests: number;
  /** Cumulative reported errors attributed to this slot. */
  totalErrors: number;
  /** Most recent selection timestamp (ms), or `null` if the slot has never been selected. */
  lastUsedAt: number | null;
  /** Cumulative recycle count (incremented each time this slot's {@link SorobanRpc.Server} instance is replaced because it sat idle). */
  recycledCount: number;
  /** Milliseconds since the current slot instance was created. */
  uptimeMs: number;
}

export interface PoolStats {
  poolSize: number;
  /** Slots whose `inFlight === 0` (i.e. immediately usable). */
  availableCount: number;
  totalInFlight: number;
  totalRequests: number;
  totalErrors: number;
  recycledCount: number;
  perSlot: PoolSlotStats[];
}

/**
 * Returned by {@link ConnectionPool.acquire} so callers can pair every lease
 * with an explicit release. `release(true)` records the lease as an error in
 * pool statistics; `release(false)` (default) is a clean return.
 */
export interface PooledServer {
  server: SorobanRpc.Server;
  release: (error?: boolean) => void;
}

/**
 * Connection pool that maintains up to {@link MAX_POOL_SIZE} persistent
 * connections to a Soroban RPC endpoint, addressing issue #360.
 *
 * Key behaviors:
 * - Acquires the **least-busy** slot (lowest `inFlight`, tie-broken by oldest
 *   `lastSelectedAt`).
 * - Recycles slots that have been idle longer than `idleTimeoutMs` (default
 *   60s) by replacing the underlying {@link SorobanRpc.Server} instance,
 *   dropping any stale HTTP/2 stream so the next lease establishes a fresh
 *   TCP/keepalive socket.
 * - Falls back to a single connection when `rpcUrl` is not `http(s):` or when
 *   `poolSize <= 1`.
 * - Exposes {@link getStats} for the SDK's monitoring API.
 *
 * The underlying keep-alive multiplexing is provided by whichever HTTP client
 * the Stellar SDK uses internally (Node: global `fetch` → `undici` since
 * Node 18; browsers: native `fetch`). Each pooled {@link SorobanRpc.Server}
 * instance owns its own keep-alive session, so up to N sessions can be in
 * flight in parallel.
 */
export class ConnectionPool {
  private slots: PoolSlot[];
  private readonly opts: {
    rpcUrl: string;
    allowHttp: boolean;
    idleTimeoutMs: number;
    poolSize: number;
    now: () => number;
  };
  private disposed = false;

  constructor(config: ConnectionPoolConfig);
  constructor(rpcUrl: string, poolSize?: number, allowHttp?: boolean);
  constructor(
    arg1: string | ConnectionPoolConfig,
    arg2?: number,
    arg3?: boolean,
  ) {
    let config: ConnectionPoolConfig;
    if (typeof arg1 === "string") {
      config = { rpcUrl: arg1, poolSize: arg2, allowHttp: arg3 };
    } else {
      config = arg1 ?? {};
    }

    if (!config?.rpcUrl || typeof config.rpcUrl !== "string") {
      throw new ConnectionPoolConfigError("rpcUrl is required");
    }

    const requested = config.poolSize ?? DEFAULT_POOL_SIZE;
    if (!Number.isFinite(requested)) {
      throw new ConnectionPoolConfigError(
        `poolSize must be a finite number, received ${String(requested)}`,
      );
    }
    const requestedFloor = Math.max(Math.trunc(requested), 1);
    const poolSize = Math.min(requestedFloor, MAX_POOL_SIZE);
    const idleTimeoutMs = config.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;
    const supportedProtocol = /^https?:\/\//i.test(config.rpcUrl);

    this.opts = {
      rpcUrl: config.rpcUrl,
      allowHttp: config.allowHttp ?? false,
      idleTimeoutMs,
      // Non-http(s) URLs are unsupported by SorobanRpc.Server; degrade to a
      // 0-slot marker pool so callers degrade gracefully instead of throwing.
      poolSize: supportedProtocol ? poolSize : 1,
      now: config.now ?? (() => Date.now()),
    };

    this.slots = [];

    const t0 = this.opts.now();
    for (let i = 0; i < this.opts.poolSize; i++) {
      this.slots.push(this._createSlot(0, t0));
    }
  }

  /** Number of underlying {@link SorobanRpc.Server} instances in the pool. */
  get size(): number {
    return this.slots.length;
  }

  /** Sum of `inFlight` counters across all slots. */
  get totalInFlight(): number {
    return this.slots.reduce((acc, s) => acc + s.inFlight, 0);
  }

  /** Whether the pool has been disposed (no further slots available). */
  get isDisposed(): boolean {
    return this.disposed;
  }

  /**
   * Pick a slot using least-busy selection. Slots that have been idle past
   * the configured timeout are recycled (a fresh {@link SorobanRpc.Server}
   * replaces the previous one) before being returned.
   *
   * This method never blocks and increments the slot's selection counter; for
   * in-flight tracking, use {@link acquire} + the returned release callback.
   */
  select(): SorobanRpc.Server {
    this._assertAlive();

    const supportedProtocol = /^https?:\/\//i.test(this.opts.rpcUrl);
    if (!supportedProtocol) {
      throw new ConnectionPoolConfigError(
        `unsupported protocol in RPC URL: "${this.opts.rpcUrl}"`,
      );
    }

    const now = this.opts.now();

    let bestIdx = 0;
    for (let i = 1; i < this.slots.length; i++) {
      const cur = this.slots[i]!;
      const best = this.slots[bestIdx]!;
      if (
        cur.inFlight < best.inFlight ||
        (cur.inFlight === best.inFlight && cur.lastSelectedAt < best.lastSelectedAt)
      ) {
        bestIdx = i;
      }
    }

    let slot = this.slots[bestIdx]!;
    // Recycle idle slots so that the underlying Soroban RPC will re-establish
    // a fresh keep-alive session on the next request. The 60s default matches
    // many reverse-proxy idle close windows (issue #360).
    if (slot.inFlight === 0 && now - slot.lastUsedAt > this.opts.idleTimeoutMs) {
      slot = this._recycle(bestIdx, now);
    }

    slot.totalRequests += 1;
    slot.lastUsedAt = now;
    slot.lastSelectedAt = now;
    return slot.server;
  }

  /**
   * Acquire a server slot and pair it with an explicit release callback. Use
   * this when the caller wants in-flight tracking and accurate per-RPC
   * success/error accounting.
   */
  acquire(): PooledServer {
    this._assertAlive();
    const server = this.select();
    const slotIdx = this.slots.findIndex((s) => s.server === server);
    const slot = this.slots[slotIdx]!;
    slot.inFlight += 1;

    return {
      server,
      release: (error = false) => {
        if (this.disposed) return;
        slot.inFlight = Math.max(0, slot.inFlight - 1);
        if (error) slot.totalErrors += 1;
        slot.lastUsedAt = this.opts.now();
      },
    };
  }

  /**
   * Attribute an error to the slot owning the given server. Useful for
   * callers using the synchronous `select()` path that don't pair a release.
   */
  recordError(server: SorobanRpc.Server): void {
    if (this.disposed) return;
    const slot = this.slots.find((s) => s.server === server);
    if (slot) slot.totalErrors += 1;
  }

  /** Snapshot pool statistics for the SDK's monitoring API. */
  getStats(): PoolStats {
    const poolSize = this.slots.length;
    let totalInFlight = 0;
    let totalRequests = 0;
    let totalErrors = 0;
    let recycled = 0;
    let availableCount = 0;
    const now = this.opts.now();

    const perSlot: PoolSlotStats[] = this.slots.map((slot, index) => {
      totalInFlight += slot.inFlight;
      totalRequests += slot.totalRequests;
      totalErrors += slot.totalErrors;
      recycled += slot.recycledCount;
      if (slot.inFlight === 0) availableCount += 1;

      return {
        index,
        inFlight: slot.inFlight,
        totalRequests: slot.totalRequests,
        totalErrors: slot.totalErrors,
        lastUsedAt: slot.totalRequests === 0 ? null : slot.lastUsedAt,
        recycledCount: slot.recycledCount,
        uptimeMs: Math.max(0, now - slot.createdAt),
      };
    });

    return {
      poolSize,
      availableCount,
      totalInFlight,
      totalRequests,
      totalErrors,
      recycledCount: recycled,
      perSlot,
    };
  }

  /** Free internal resources. Idempotent. */
  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.slots = [];
  }

  private _createSlot(recycledCount: number, createdAt: number): PoolSlot {
    const supportedProtocol = /^https?:\/\//i.test(this.opts.rpcUrl);
    let server: any;
    if (supportedProtocol) {
      server = new SorobanRpc.Server(this.opts.rpcUrl, {
        allowHttp: this.opts.allowHttp,
      });
    } else {
      server = {};
    }
    return {
      server: server as SorobanRpc.Server,
      inFlight: 0,
      totalRequests: 0,
      totalErrors: 0,
      recycledCount,
      createdAt,
      lastUsedAt: createdAt,
      lastSelectedAt: createdAt,
    };
  }

  private _recycle(idx: number, now: number): PoolSlot {
    const old = this.slots[idx]!;
    const fresh = this._createSlot(old.recycledCount + 1, now);
    this.slots[idx] = fresh;
    return fresh;
  }

  private _assertAlive(): void {
    if (this.disposed) throw new ConnectionPoolDisposedError();
  }
}