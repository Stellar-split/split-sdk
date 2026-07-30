/**
 * Cursor tracker for persisting Horizon paging tokens.
 *
 * Provides an in-memory and pluggable storage-backed cursor store so that
 * the horizon paginator can resume from the last-seen position across
 * restarts or page walks.
 */

import type { CursorStore } from "./types.js";

export type CursorPersistence = CursorStore;

/**
 * In-memory cursor store suitable for session-scoped pagination.
 * Cursors are lost when the process exits.
 */
export class InMemoryCursorStore implements CursorStore {
  private store = new Map<string, string>();

  async save(key: string, cursor: string): Promise<void> {
    this.store.set(key, cursor);
  }

  async load(key: string): Promise<string | null> {
    return this.store.get(key) ?? null;
  }

  async delete(key: string): Promise<void> {
    this.store.delete(key);
  }

  /** Remove all saved cursors. */
  clear(): void {
    this.store.clear();
  }
}

/** Singleton in-memory store shared across the module. */
let defaultStore: CursorStore = new InMemoryCursorStore();
const syncCursorStore = new Map<string, string>();

/**
 * Override the default cursor store.
 * Useful for plugging in localStorage, IndexedDB, or a remote store.
 */
export function setDefaultCursorStore(store: CursorStore): void {
  defaultStore = store;
}

/** Alias retained for public API compatibility. */
export function configureCursorStore(store: CursorStore): void {
  setDefaultCursorStore(store);
}

/**
 * Get the current default cursor store.
 */
export function getDefaultCursorStore(): CursorStore {
  return defaultStore;
}

/** Persist a cursor in the default in-memory stream cursor cache. */
export function setCursor(key: string, cursor: string): void {
  syncCursorStore.set(key, cursor);
  void defaultStore.save(key, cursor);
}

/** Read a cursor from the default in-memory stream cursor cache. */
export function getCursor(key: string): string | null {
  return syncCursorStore.get(key) ?? null;
}

/** Remove a persisted cursor from the default stream cursor cache. */
export function removeCursor(key: string): void {
  syncCursorStore.delete(key);
  void defaultStore.delete(key);
}

/** Persist a cursor from a snapshot-like object containing a cursor field. */
export function setCursorFromSnapshot(key: string, snapshot: { cursor?: string | number | null }): void {
  if (snapshot.cursor !== undefined && snapshot.cursor !== null) {
    setCursor(key, String(snapshot.cursor));
  }
}

/** Clear in-memory cursors for tests. */
export function _resetCursorTrackerForTesting(): void {
  syncCursorStore.clear();
}

/**
 * Build a namespaced cursor key from a base name and namespace.
 */
export function buildCursorKey(namespace: string, name: string): string {
  return `${namespace}:${name}`;
}
