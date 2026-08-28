/**
 * Named priority levels for queued operations.
 *
 * Higher numeric value = higher urgency; the drain loop processes items in
 * descending priority order (HIGH before NORMAL before LOW).
 *
 * Export so callers can reference the constants without magic numbers.
 */
export const OperationPriority = {
  LOW: 1,
  NORMAL: 5,
  HIGH: 10,
} as const;

export type OperationPriorityValue = (typeof OperationPriority)[keyof typeof OperationPriority];

type QueuedOperation = {
  id: string;
  method: string;
  args: unknown[];
  priority: OperationPriorityValue;
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
   *
   * @param method    - Human-readable name for the operation (used for debugging).
   * @param args      - Arguments forwarded to `executor`.
   * @param executor  - Async function that performs the actual work.
   * @param priority  - Urgency level; defaults to {@link OperationPriority.NORMAL}.
   *                    Higher-priority operations are drained first.
   */
  enqueue<T>(
    method: string,
    args: unknown[],
    executor: (args: unknown[]) => Promise<T>,
    priority: OperationPriorityValue = OperationPriority.NORMAL,
  ): Promise<T> {
    if (this._online) {
      return executor(args);
    }
    return new Promise<T>((resolve, reject) => {
      this._queue.push({
        id: String(++_nextId),
        method,
        args,
        priority,
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
    // Sort descending by priority so HIGH (10) ops execute before NORMAL (5) and LOW (1).
    this._queue.sort((a, b) => b.priority - a.priority);

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
