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
        connId = Array.from(this.connections.keys())[0];
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

export { RpcConnectionPool as ConnectionPool };
