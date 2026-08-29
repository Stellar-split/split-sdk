import { RpcUnavailableError } from "./errors.js";

export interface DegradedRead<T> {
  data: T;
  stale: boolean;
}

export type PendingResult<T> = Promise<T>;

export interface DegradationConfig {
  enabled: boolean;
}

export interface ServiceDegradationConfig {
  failureThreshold: number;
  recoveryWindowMs: number;
  now?: () => number;
}

export type ServiceState = "healthy" | "degraded";

interface PendingEntry {
  fn: () => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

export class ServiceDegradationTracker {
  private readonly failureThreshold: number;
  private readonly recoveryWindowMs: number;
  private readonly now: () => number;
  private failureCount = 0;
  private degradedAt: number | null = null;

  constructor(config: ServiceDegradationConfig) {
    this.failureThreshold = config.failureThreshold;
    this.recoveryWindowMs = config.recoveryWindowMs;
    this.now = config.now ?? Date.now;
  }

  recordFailure(): void {
    this.refreshState();
    this.failureCount++;
    if (this.failureCount >= this.failureThreshold && this.degradedAt === null) {
      this.degradedAt = this.now();
    }
  }

  recordSuccess(): void {
    this.refreshState();
    if (this.degradedAt === null) {
      this.failureCount = 0;
    }
  }

  getState(): ServiceState {
    this.refreshState();
    return this.degradedAt === null ? "healthy" : "degraded";
  }

  private refreshState(): void {
    if (this.degradedAt === null) {
      return;
    }

    if (this.now() - this.degradedAt >= this.recoveryWindowMs) {
      this.degradedAt = null;
      this.failureCount = 0;
    }
  }
}

export class DegradationManager {
  private _cache = new Map<string, unknown>();
  private _queue: PendingEntry[] = [];
  private _draining = false;

  async wrapRead<T>(key: string, fn: () => Promise<T>): Promise<DegradedRead<T>> {
    try {
      const data = await fn();
      this._cache.set(key, data);
      return { data, stale: false };
    } catch {
      const cached = this._cache.get(key);
      if (cached !== undefined) {
        return { data: cached as T, stale: true };
      }
      throw new RpcUnavailableError(key);
    }
  }

  wrapWrite<T>(fn: () => Promise<T>): PendingResult<T> {
    return new Promise<T>((resolve, reject) => {
      this._queue.push({
        fn: fn as () => Promise<unknown>,
        resolve: resolve as (v: unknown) => void,
        reject,
      });
      void this._drain();
    });
  }

  private async _drain(): Promise<void> {
    if (this._draining) return;
    this._draining = true;
    while (this._queue.length > 0) {
      const entry = this._queue[0];
      if (!entry) break;
      try {
        const result = await entry.fn();
        this._queue.shift();
        entry.resolve(result);
      } catch {
        this._draining = false;
        setTimeout(() => void this._drain(), 5000);
        return;
      }
    }
    this._draining = false;
  }
}
