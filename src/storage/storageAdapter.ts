/**
 * Minimal key/value storage abstraction shared by SDK features that need to
 * persist small bits of state across page reloads and browser tabs (e.g.
 * SubscriptionManager's event cursor). Falls back to an in-memory store in
 * non-browser environments (Node, React Native) or when the Web Storage API
 * is unavailable (privacy mode, quota exceeded).
 */

export interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  keys?(): string[];
}

export type StorageKind = "localStorage" | "sessionStorage" | "memory";

export class MemoryStorageAdapter implements StorageAdapter {
  private readonly store = new Map<string, string>();

  getItem(key: string): string | null {
    return this.store.has(key) ? this.store.get(key)! : null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }

  keys(): string[] {
    return Array.from(this.store.keys());
  }
}

function resolveWebStorage(kind: "localStorage" | "sessionStorage"): StorageAdapter | null {
  try {
    const candidate =
      kind === "localStorage"
        ? (globalThis as { localStorage?: Storage }).localStorage
        : (globalThis as { sessionStorage?: Storage }).sessionStorage;
    if (!candidate) return null;

    const probeKey = "__stellar_split_storage_probe__";
    candidate.setItem(probeKey, "1");
    candidate.removeItem(probeKey);
    return {
      getItem: (key) => candidate.getItem(key),
      setItem: (key, value) => candidate.setItem(key, value),
      removeItem: (key) => candidate.removeItem(key),
      keys: () => Array.from({ length: candidate.length }, (_, index) => candidate.key(index)).filter(
        (key): key is string => key !== null,
      ),
    };
  } catch {
    return null;
  }
}

/**
 * Create a storage adapter. Defaults to `localStorage`, transparently
 * falling back to an in-memory store when unavailable, so callers never
 * need to branch on environment.
 */
export function createStorageAdapter(kind: StorageKind = "localStorage"): StorageAdapter {
  if (kind === "memory") return new MemoryStorageAdapter();
  return resolveWebStorage(kind) ?? new MemoryStorageAdapter();
}
