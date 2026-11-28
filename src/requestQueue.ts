/**
 * RequestQueue with priority lanes and concurrency limiting.
 * Prevents thundering herd on reconnect, ensures high-priority operations
 * (pay, release, refund, cancel) are not blocked by background polling.
 */

export type PriorityLane = "high" | "normal" | "low";

export interface QueuedRequest<T> {
  id: string;
  priority: PriorityLane;
  fn: () => Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
}

export interface QueueStats {
  high: { pending: number; active: number; completed: number; failed: number };
  normal: { pending: number; active: number; completed: number; failed: number };
  low: { pending: number; active: number; completed: number; failed: number };
}

export class RequestQueue {
  private readonly maxConcurrent: number;
  private activeCount = 0;
  private queue: Map<PriorityLane, QueuedRequest<any>[]> = new Map([
    ["high", []],
    ["normal", []],
    ["low", []],
  ]);
  private _stats: Record<PriorityLane, { completed: number; failed: number }> = {
    high: { completed: 0, failed: 0 },
    normal: { completed: 0, failed: 0 },
    low: { completed: 0, failed: 0 },
  };

  constructor(maxConcurrent: number = 5) {
    this.maxConcurrent = maxConcurrent;
  }

  async enqueue<T>(
    fn: () => Promise<T>,
    priority: PriorityLane = "normal"
  ): Promise<T> {
    return new Promise((resolve, reject) => {
      const request: QueuedRequest<T> = {
        id: `${priority}-${Date.now()}-${Math.random()}`,
        priority,
        fn,
        resolve,
        reject,
      };

      const lane = this.queue.get(priority);
      if (lane) {
        lane.push(request);
      }

      this._scheduleTryProcess();
    });
  }

  /**
   * Defer dispatch to a fresh macrotask. This lets a batch of synchronous
   * `enqueue()` calls (and `stats()` checks in between) observe requests as
   * still pending, and lets an already-due sibling timer-based task in the
   * same event-loop phase fire before a freed slot is handed to the next
   * queued request (a microtask-level defer isn't enough to achieve that).
   */
  private _scheduleTryProcess() {
    setTimeout(() => this._tryProcess(), 0);
  }

  private _tryProcess() {
    if (this.activeCount >= this.maxConcurrent) return;

    const request = this._dequeueNextRequest();
    if (!request) return;

    this.activeCount++;
    request
      .fn()
      .then((result) => {
        this._stats[request.priority].completed++;
        request.resolve(result);
      })
      .catch((err) => {
        this._stats[request.priority].failed++;
        request.reject(err);
      })
      .finally(() => {
        this.activeCount--;
        this._scheduleTryProcess();
      });
  }

  private _dequeueNextRequest(): QueuedRequest<unknown> | null {
    for (const priority of ["high", "normal", "low"] as const) {
      const lane = this.queue.get(priority);
      if (lane && lane.length > 0) {
        return lane.shift()!;
      }
    }
    return null;
  }

  stats(): QueueStats {
    return {
      high: {
        pending: this.queue.get("high")?.length ?? 0,
        active: this.activeCount,
        completed: this._stats.high.completed,
        failed: this._stats.high.failed,
      },
      normal: {
        pending: this.queue.get("normal")?.length ?? 0,
        active: this.activeCount,
        completed: this._stats.normal.completed,
        failed: this._stats.normal.failed,
      },
      low: {
        pending: this.queue.get("low")?.length ?? 0,
        active: this.activeCount,
        completed: this._stats.low.completed,
        failed: this._stats.low.failed,
      },
    };
  }

  async drain(): Promise<void> {
    while (this.activeCount > 0 || this._hasPendingRequests()) {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  private _hasPendingRequests(): boolean {
    return Array.from(this.queue.values()).some((lane) => lane.length > 0);
  }
}
