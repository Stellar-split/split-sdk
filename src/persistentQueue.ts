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

  /** Restore persisted items into memory; call once on startup. */
  async hydrate(): Promise<PendingItem[]> {
    const db = await this.getDb();
    if (!db) return [];
    const items = await idbGetAll(db);
    items.sort((a, b) => a.enqueuedAt - b.enqueuedAt);
    this.memory = items;
    return items;
  }

  /** Add an item to the queue, persisting it to IndexedDB when available. */
  async enqueue(item: PendingItem): Promise<void> {
    this.memory.push(item);
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
      const items = this.memory.slice();
      for (const item of items) {
        await fn(item);
        this.memory = this.memory.filter((i) => i.id !== item.id);
        const db = await this.getDb();
        if (db) await idbDelete(db, item.id);
      }
    });
    return this.chain;
  }

  /** Return current in-memory queue snapshot. */
  peek(): PendingItem[] {
    return this.memory.slice();
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
