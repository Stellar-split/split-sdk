import type { StellarSplitClient } from "./client.js";
import type { ConflictStrategy } from "./types.js";

export interface QueuedOperation {
  id: string;
  method: string;
  args: any[];
  timestamp: number;
}

export type OfflineTransactionStatus = "pending" | "submitting" | "submitted" | "failed";

export interface OfflineTransaction {
  id: string;
  /** Serialized offline transaction package (bigint-safe). */
  payload: string;
  status: OfflineTransactionStatus;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  lastError?: string;
}

export interface OfflineTransactionTracking {
  id: string;
  status: OfflineTransactionStatus;
  createdAt: number;
  updatedAt: number;
  attempts: number;
  lastError?: string;
}

export interface OfflineTransactionSyncResult {
  submitted: number;
  failed: number;
  transactions: OfflineTransactionTracking[];
}

export interface OfflineQueueConfig {
  enabled: boolean;
  maxQueueSize: number;
  persistToStorage: boolean;
  conflictStrategy?: ConflictStrategy;
}

export interface SyncResult {
  synced: number;
  failed: number;
  conflicts: number;
  operations: QueuedOperation[];
}

function serializeQueue(queue: QueuedOperation[]): string {
  return JSON.stringify(queue, (_key, value) =>
    typeof value === "bigint" ? { __type: "bigint", value: value.toString() } : value
  );
}

function deserializeQueue(raw: string): QueuedOperation[] {
  return JSON.parse(raw, (_key, value) => {
    if (value && typeof value === "object" && value.__type === "bigint") {
      return BigInt(value.value);
    }
    return value;
  });
}

function serializeOfflineTransactions(txs: OfflineTransaction[]): string {
  return JSON.stringify(txs);
}

function deserializeOfflineTransactions(raw: string): OfflineTransaction[] {
  const parsed = JSON.parse(raw);
  if (!Array.isArray(parsed)) return [];
  return parsed.filter(
    (tx): tx is OfflineTransaction =>
      tx && typeof tx === "object" && typeof tx.id === "string" && typeof tx.payload === "string"
  );
}

function generateId(): string {
  return typeof crypto !== "undefined" && crypto.randomUUID
    ? crypto.randomUUID()
    : Math.random().toString(36).substring(2);
}

export class OfflineQueue {
  private queue: QueuedOperation[] = [];
  private offlineTransactions: OfflineTransaction[] = [];
  public readonly config: OfflineQueueConfig;
  private client: StellarSplitClient;
  private readonly storageKey = "stellar_split_offline_queue";
  private readonly txStorageKey = "stellar_split_offline_transactions";
  private isDraining = false;
  private isSyncingTransactions = false;

  constructor(client: StellarSplitClient, config: OfflineQueueConfig) {
    this.client = client;
    this.config = config;
    if (this.config.persistToStorage) {
      this.loadFromStorage();
      this.loadTransactionsFromStorage();
    }
  }

  public enqueue(method: string, args: any[]): void {
    if (!this.config.enabled) return;

    if (this.queue.length >= this.config.maxQueueSize) {
      this.queue.shift();
    }

    const operation: QueuedOperation = {
      id: generateId(),
      method,
      args,
      timestamp: Date.now(),
    };

    this.queue.push(operation);

    if (this.config.persistToStorage) {
      this.saveToStorage();
    }
  }

  /**
   * Enqueue a serialized offline transaction package for later submission.
   * Returns the tracking id of the queued transaction.
   */
  public enqueueTransaction(payload: string): string {
    const now = Date.now();
    const tx: OfflineTransaction = {
      id: generateId(),
      payload,
      status: "pending",
      createdAt: now,
      updatedAt: now,
      attempts: 0,
    };
    this.offlineTransactions.push(tx);
    if (this.config.persistToStorage) {
      this.saveTransactionsToStorage();
    }
    return tx.id;
  }

  public getQueue(): QueuedOperation[] {
    return [...this.queue];
  }

  public getOfflineTransactions(): OfflineTransactionTracking[] {
    return this.offlineTransactions.map((tx) => ({
      id: tx.id,
      status: tx.status,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
      attempts: tx.attempts,
      lastError: tx.lastError,
    }));
  }

  public getOfflineTransaction(id: string): OfflineTransactionTracking | undefined {
    const tx = this.offlineTransactions.find((t) => t.id === id);
    if (!tx) return undefined;
    return {
      id: tx.id,
      status: tx.status,
      createdAt: tx.createdAt,
      updatedAt: tx.updatedAt,
      attempts: tx.attempts,
      lastError: tx.lastError,
    };
  }

  public clear(): void {
    this.queue = [];
    this.offlineTransactions = [];
    if (this.config.persistToStorage) {
      this.saveToStorage();
      this.saveTransactionsToStorage();
    }
  }

  public recoverState(): QueuedOperation[] {
    this.loadFromStorage();
    this.loadTransactionsFromStorage();
    return this.getQueue();
  }

  /**
   * Replay queued offline transactions once connectivity returns.
   * Transactions that fail remain queued (status "failed") so nothing is lost.
   */
  public async syncOfflineTransactions(): Promise<OfflineTransactionSyncResult> {
    if (this.isSyncingTransactions || this.offlineTransactions.length === 0) {
      return { submitted: 0, failed: 0, transactions: this.getOfflineTransactions() };
    }

    this.isSyncingTransactions = true;
    const result: OfflineTransactionSyncResult = { submitted: 0, failed: 0, transactions: [] };

    for (const tx of this.offlineTransactions) {
      if (tx.status === "submitted") continue;

      tx.attempts++;
      tx.status = "submitting";
      tx.updatedAt = Date.now();

      try {
        // @ts-ignore - submitTransaction is provided by the client when available.
        if (typeof this.client.submitTransaction === "function") {
          // @ts-ignore
          await this.client.submitTransaction(tx.payload);
        } else {
          // @ts-ignore
          await this.client.submitOfflineTransaction(tx.payload);
        }
        tx.status = "submitted";
        tx.lastError = undefined;
        result.submitted++;
      } catch (error) {
        tx.status = "failed";
        tx.lastError = error instanceof Error ? error.message : String(error);
        result.failed++;
        this.client.emit("queue:transaction:failed", { transaction: tx, error });
      } finally {
        tx.updatedAt = Date.now();
      }
    }

    // Retain submitted transactions for tracking; drop nothing on failure.
    if (this.config.persistToStorage) {
      this.saveTransactionsToStorage();
    }

    result.transactions = this.getOfflineTransactions();
    this.client.emit("queue:transactions:synced", result);
    this.isSyncingTransactions = false;
    return result;
  }

  public async drain(): Promise<void> {
    await this.sync();
  }

  public async sync(conflictStrategy?: ConflictStrategy): Promise<SyncResult> {
    if (this.isDraining || this.queue.length === 0) {
      return { synced: 0, failed: 0, conflicts: 0, operations: [] };
    }

    this.isDraining = true;
    const strategy = conflictStrategy ?? this.config.conflictStrategy ?? "remote-wins";
    const operationsToDrain = [...this.queue];
    this.clear();

    const result: SyncResult = {
      synced: 0,
      failed: 0,
      conflicts: 0,
      operations: operationsToDrain,
    };

    for (const op of operationsToDrain) {
      try {
        if (op.method === "pay" && op.args.length > 0 && typeof this.client.getInvoice === "function") {
          const invoiceId = op.args[0]?.invoiceId;
          if (invoiceId) {
            try {
              const remoteInvoice = await this.client.getInvoice(invoiceId);
              if (remoteInvoice && remoteInvoice.status !== "pending") {
                result.conflicts++;
                if (strategy === "remote-wins") {
                  this.client.emit("queue:conflict:resolved", {
                    operation: op,
                    strategy,
                    remoteState: remoteInvoice,
                  });
                  continue;
                }
              }
            } catch {
              // Proceed if remote fetch fails
            }
          }
        }

        // @ts-ignore
        await this.client[op.method](...op.args);
        result.synced++;
      } catch (error) {
        result.failed++;
        this.client.emit("queue:operation:failed", { operation: op, error });
      }
    }

    this.client.emit("queue:drained", undefined);
    this.isDraining = false;
    return result;
  }

  public loadFromStorage(): void {
    if (typeof localStorage !== "undefined") {
      try {
        const stored = localStorage.getItem(this.storageKey);
        if (stored) {
          this.queue = deserializeQueue(stored);
        }
      } catch (e) {
        console.warn("Failed to load offline queue from storage", e);
      }
    }
  }

  public saveToStorage(): void {
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(this.storageKey, serializeQueue(this.queue));
      } catch (e) {
        console.warn("Failed to save offline queue to storage", e);
      }
    }
  }

  public loadTransactionsFromStorage(): void {
    if (typeof localStorage !== "undefined") {
      try {
        const stored = localStorage.getItem(this.txStorageKey);
        if (stored) {
          this.offlineTransactions = deserializeOfflineTransactions(stored);
        }
      } catch (e) {
        console.warn("Failed to load offline transactions from storage", e);
      }
    }
  }

  public saveTransactionsToStorage(): void {
    if (typeof localStorage !== "undefined") {
      try {
        localStorage.setItem(this.txStorageKey, serializeOfflineTransactions(this.offlineTransactions));
      } catch (e) {
        console.warn("Failed to save offline transactions to storage", e);
      }
    }
  }
}

