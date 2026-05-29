type QueuedOperation = {
  id: string;
  method: string;
  args: unknown[];
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  executor: (args: unknown[]) => Promise<unknown>;
};

let _nextId = 0;

export class OperationQueue {
  private _queue: QueuedOperation[] = [];
  private _online = true;
  private _timer: ReturnType<typeof setInterval> | null = null;
  private _healthCheck: () => Promise<boolean>;
  private _intervalMs: number;

  constructor(healthCheck: () => Promise<boolean>, intervalMs = 5000) {
    this._healthCheck = healthCheck;
    this._intervalMs = intervalMs;
  }

  /** Begin periodic connectivity polling. */
  start(): void {
    if (this._timer !== null) return;
    this._timer = setInterval(() => void this._poll(), this._intervalMs);
  }

  /** Stop periodic connectivity polling. */
  stop(): void {
    if (this._timer !== null) {
      clearInterval(this._timer);
      this._timer = null;
    }
  }

  /**
   * Enqueue an operation. Executes immediately when online; buffers when offline.
   * The returned promise resolves/rejects once the operation completes.
   */
  enqueue<T>(
    method: string,
    args: unknown[],
    executor: (args: unknown[]) => Promise<T>
  ): Promise<T> {
    if (this._online) {
      return executor(args);
    }
    return new Promise<T>((resolve, reject) => {
      this._queue.push({
        id: String(++_nextId),
        method,
        args,
        resolve: resolve as (v: unknown) => void,
        reject,
        executor: executor as (args: unknown[]) => Promise<unknown>,
      });
    });
  }

  /** Manually update online state; drains the queue when transitioning to online. */
  setOnline(online: boolean): void {
    const wasOffline = !this._online;
    this._online = online;
    if (online && wasOffline) {
      void this._drain();
    }
  }

  get queueSize(): number {
    return this._queue.length;
  }

  private async _poll(): Promise<void> {
    const reachable = await this._healthCheck().catch(() => false);
    this.setOnline(reachable);
  }

  private async _drain(): Promise<void> {
    while (this._queue.length > 0) {
      const op = this._queue.shift();
      if (!op) break;
      try {
        const result = await op.executor(op.args);
        op.resolve(result);
      } catch (err) {
        op.reject(err);
      }
    }
  }
}
