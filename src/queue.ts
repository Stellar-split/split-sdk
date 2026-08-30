import {
  TransactionBuilder,
  BASE_FEE,
  rpc as SorobanRpc,
  Account,
} from "@stellar/stellar-sdk";
import { signTransaction } from "./wallet.js";
import type { TxResult } from "./client.js";
import { QueueFailedError } from "./errors.js";

/** An item waiting in the priority queue. */
interface QueueItem {
  /** Higher priority items are dequeued first. Default is 0. */
  priority: number;
  /** Insertion order index, used to preserve FIFO among equal-priority items. */
  seq: number;
  operation: (account: Account) => Promise<{ txHash: string; returnValue: unknown }>;
  resolve: (result: TxResult) => void;
  reject: (error: unknown) => void;
}

/** Transaction queue for serialized submission with optional priority ordering. */
export class TxQueue {
  private server: SorobanRpc.Server;
  private networkPassphrase: string;
  private sourceAddress: string;
  private failed = false;

  /** Pending items sorted by priority (desc) then insertion order (asc). */
  private items: QueueItem[] = [];
  /** Monotonically increasing sequence counter for FIFO tie-breaking. */
  private _seq = 0;
  /** Whether the drain loop is currently running. */
  private _draining = false;

  constructor(
    server: SorobanRpc.Server,
    networkPassphrase: string,
    sourceAddress: string
  ) {
    this.server = server;
    this.networkPassphrase = networkPassphrase;
    this.sourceAddress = sourceAddress;
  }

  /**
   * Enqueue an operation for sequential execution.
   *
   * @param operation - The operation to execute.
   * @param priority  - Higher values are processed first; equal-priority items
   *                    are processed FIFO.  Default: 0.
   * @returns Promise resolving to transaction result.
   */
  async enqueue(
    operation: (
      account: Account
    ) => Promise<{ txHash: string; returnValue: unknown }>,
    priority = 0
  ): Promise<TxResult> {
    if (this.failed) {
      throw new QueueFailedError();
    }

    return new Promise<TxResult>((resolve, reject) => {
      const item: QueueItem = {
        priority,
        seq: this._seq++,
        operation,
        resolve,
        reject,
      };
      this._insert(item);
      // Kick off the drain loop if it isn't already running.
      void this._drain();
    });
  }

  /**
   * Return the next item that would be dequeued without removing it.
   * Returns `undefined` when the queue is empty.
   */
  peek(): { priority: number } | undefined {
    const head = this.items[0];
    if (!head) return undefined;
    return { priority: head.priority };
  }

  /** Clear the queue, reject all pending items, and reset state. */
  clear(): void {
    const pending = this.items.splice(0);
    for (const item of pending) {
      item.reject(new QueueFailedError());
    }
    this.failed = false;
    this._draining = false;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /** Insert an item in sorted order: higher priority first, FIFO on tie. */
  private _insert(item: QueueItem): void {
    let lo = 0;
    let hi = this.items.length;
    while (lo < hi) {
      const mid = (lo + hi) >>> 1;
      const cand = this.items[mid]!;
      // Sorted descending by priority, then ascending by seq
      if (
        cand.priority > item.priority ||
        (cand.priority === item.priority && cand.seq < item.seq)
      ) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    this.items.splice(lo, 0, item);
  }

  /** Sequential drain loop — processes items one at a time. */
  private async _drain(): Promise<void> {
    if (this._draining) return;
    this._draining = true;

    while (this.items.length > 0 && !this.failed) {
      const item = this.items.shift()!;
      try {
        const account = await this.server.getAccount(this.sourceAddress);
        const result = await item.operation(account);
        item.resolve({ txHash: result.txHash });
      } catch (error) {
        this.failed = true;
        item.reject(error);
        // Reject all remaining items
        const remaining = this.items.splice(0);
        for (const r of remaining) {
          r.reject(new QueueFailedError());
        }
      }
    }

    this._draining = false;
  }
}
