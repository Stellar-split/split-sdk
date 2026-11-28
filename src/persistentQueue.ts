/**
 * IndexedDB-backed persistent transaction queue.
 * Falls back to in-memory only when IndexedDB is unavailable (Node/SSR).
 */

const DB_NAME = "stellar-split-queue";
const STORE_NAME = "pending";
const DB_VERSION = 1;

export interface PendingItem {
  id: string;
  payload: unknown;
  enqueuedAt: number;
  /** Number of processing attempts made so far (for offline tx tracking). */
  attempts?: number;
  /** Timestamp of the last processing attempt, if any. */
  lastAttemptAt?: number;
  /** Last error message from a failed processing attempt, if any. */
  lastError?: string;
}

/** A serialized offline transaction package stored in the queue. */
export interface OfflineTxItem extends PendingItem {
  payload: {
    /** Serialized OfflineTxPackage (XDR envelope + metadata). */
    package: unknown;
    /** Optional network passphrase the package was built for. */
    networkPassphrase?: string;
  };
}

function openDB(): Promise<IDBDatabase> | null {
  if (typeof indexedDB === "undefined") return null;
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE_NAME, { keyPath: "id" });
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function idbPut(db: IDBDatabase, item: PendingItem): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).put(item);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbDelete(db: IDBDatabase, id: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE_NAME, "readwrite");
    tx.objectStore(STORE_NAME).delete(id);
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  });
}

async function idbGetAll(db: IDBDatabase): Promise<PendingItem[]> {
  return new Promise((resolve, reject) => {
    const req = db.transaction(STORE_NAME, "readonly").objectStore(STORE_NAME).getAll();
    req.onsuccess = () => resolve(req.result as PendingItem[]);
    req.onerror = () => reject(req.error);
  });
}

export type ProcessFn = (item: PendingItem) => Promise<void>;

/** Stable ordering: by enqueue time, then by id for deterministic ties. */
function compareItems(a: PendingItem, b: PendingItem): number {
  if (a.enqueuedAt !== b.enqueuedAt) return a.enqueuedAt - b.enqueuedAt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

function isOfflineTxItem(item: PendingItem): item is OfflineTxItem {
  const p = item.payload as { package?: unknown } | null | undefined;
  return !!p && typeof p === "object" && "package" in p;
}

export class PersistentTxQueue {
  private db: IDBDatabase | null = null;
  private memory: PendingItem[] = [];
  private chain: Promise<void> = Promise.resolve();

  private async getDb(): Promise<IDBDatabase | null> {
    if (this.db) return this.db;
    try {
      const p = openDB();
      if (!p) return null;
      this.db = await p;
      return this.db;
    } catch {
      return null;
    }
  }

  /**
   * Restore persisted items into memory; call once on startup.
   * Items are ordered by enqueue time (ties broken by id) so ordering is
   * stable across process restarts.
   */
  async hydrate(): Promise<PendingItem[]> {
    const db = await this.getDb();
    if (!db) {
      this.memory.sort(compareItems);
      return this.memory.slice();
    }
    const items = await idbGetAll(db);
    items.sort(compareItems);
    this.memory = items;
    return items.slice();
  }

  /** Add an item to the queue, persisting it to IndexedDB when available. */
  async enqueue(item: PendingItem): Promise<void> {
    this.memory.push(item);
    const db = await this.getDb();
    if (db) await idbPut(db, item);
  }

  /**
   * Enqueue a serialized offline transaction package for later submission.
   * Persists to IndexedDB when available so it survives a restart.
   */
  async enqueueOfflineTx(
    id: string,
    pkg: unknown,
    networkPassphrase?: string,
    enqueuedAt: number = Date.now(),
  ): Promise<OfflineTxItem> {
    const item: OfflineTxItem = {
      id,
      enqueuedAt,
      attempts: 0,
      payload: { package: pkg, networkPassphrase },
    };
    await this.enqueue(item);
    return item;
  }

  /** Return queued offline transaction items in stable processing order. */
  peekOfflineTxs(): OfflineTxItem[] {
    return this.memory
      .filter((i): i is OfflineTxItem => isOfflineTxItem(i))
      .sort(compareItems);
  }

  /** Remove a single offline transaction item by id. */
  async removeOfflineTx(id: string): Promise<void> {
    await this.remove(id);
  }

  /**
   * Record a failed processing attempt for an item, keeping it queued so it
   * can be resumed later. Persists the updated item when IndexedDB is present.
   */
  async markFailed(id: string, error: unknown): Promise<void> {
    const item = this.memory.find((i) => i.id === id);
    if (!item) return;
    item.attempts = (item.attempts ?? 0) + 1;
    item.lastAttemptAt = Date.now();
    item.lastError = error instanceof Error ? error.message : String(error);
    const db = await this.getDb();
    if (db) await idbPut(db, item);
  }

  /**
   * Process all queued items in order using the provided function.
   * Successfully processed items are removed from memory and IndexedDB.
   * Processing is serialized — concurrent calls chain onto the same promise.
   */
  process(fn: ProcessFn): Promise<void> {
    this.chain = this.chain.then(async () => {
      // Snapshot current items; new enqueues during processing will be next round
      const items = this.memory.slice().sort(compareItems);
      for (const item of items) {
        try {
          await fn(item);
        } catch (err) {
          // Keep failed items queued so they can be resumed; record the
          // failure and propagate it so the caller sees processing failed.
          await this.markFailed(item.id, err);
          throw err;
        }
        // Only remove after successful processing so no txns are lost.
        this.memory = this.memory.filter((i) => i.id !== item.id);
        const db = await this.getDb();
        if (db) await idbDelete(db, item.id);
      }
    });
    return this.chain;
  }

  /** Return current in-memory queue snapshot in stable processing order. */
  peek(): PendingItem[] {
    return this.memory.slice().sort(compareItems);
  }

  /** Remove a single item from the queue by id, without processing it. */
  async remove(id: string): Promise<void> {
    this.memory = this.memory.filter((i) => i.id !== id);
    const db = await this.getDb();
    if (db) await idbDelete(db, id);
  }

  /** Clear all items from memory and IndexedDB. */
  async clear(): Promise<void> {
    this.memory = [];
    const db = await this.getDb();
    if (db) {
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, "readwrite");
        tx.objectStore(STORE_NAME).clear();
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
    }
  }
}
