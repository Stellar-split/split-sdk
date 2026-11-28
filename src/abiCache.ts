/**
 * Smart Contract ABI Caching Layer (#1054)
 *
 * Caches Soroban contract ABIs and interface specifications to eliminate redundant
 * network lookups, reduce RPC pressure, and improve invocation performance.
 */

import type { StorageAdapter } from "./storage/storageAdapter.js";
import { MemoryStorageAdapter } from "./storage/storageAdapter.js";
import { AbiNotFoundError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/** Input or output parameter in a contract function spec. */
export interface AbiParamSpec {
  name: string;
  type: string;
  doc?: string;
}

/** Function specification in a contract ABI. */
export interface AbiFunctionSpec {
  name: string;
  doc?: string;
  inputs: AbiParamSpec[];
  outputs?: Array<{ type: string; doc?: string }>;
}

/** Custom User-Defined Type in a contract ABI. */
export interface AbiTypeSpec {
  name: string;
  kind: "struct" | "union" | "enum";
  doc?: string;
  fields?: Array<{ name: string; type: string }>;
  cases?: Array<{ name: string; value?: unknown }>;
}

/** Parsed Smart Contract ABI specification. */
export interface ContractAbi {
  /** Target contract address. */
  contractId: string;
  /** SHA-256 hash of the contract WASM bytecode (if known). */
  wasmHash?: string;
  /** Exported callable functions. */
  functions: AbiFunctionSpec[];
  /** Exported UDTs (types, structs, enums). */
  types?: AbiTypeSpec[];
  /** Raw base64 or hex encoded ScSpecEntry byte representation. */
  rawSpec?: string[];
  /** Timestamp when this ABI was fetched / created (ms). */
  fetchedAt: number;
  /** Semantic contract version if declared. */
  version?: string;
}

/** Stored entry wrapped with cache metadata. */
export interface CachedAbiEntry {
  contractId: string;
  abi: ContractAbi;
  cachedAt: number;
  expiresAt: number;
  lastAccessedAt: number;
  accessCount: number;
  byteSize: number;
}

/** Cache performance and efficiency metrics. */
export interface AbiCacheStats {
  hits: number;
  misses: number;
  hitRate: number;
  entryCount: number;
  storageBytes: number;
  evictions: number;
}

/** Memory pool monitoring snapshot. */
export interface AbiMemoryStats {
  entryCount: number;
  storageBytes: number;
  maxEntries: number;
  maxBytes: number;
  utilization: number;
  evictions: number;
  collections: number;
  lastCollectedAt: number | null;
}

/** Storage backend for cached contract ABIs. */
export interface AbiStorage {
  get(key: string): Promise<CachedAbiEntry | null> | CachedAbiEntry | null;
  set(key: string, entry: CachedAbiEntry): Promise<void> | void;
  delete(key: string): Promise<boolean> | boolean;
  clear(): Promise<void> | void;
  keys(): Promise<string[]> | string[];
  size(): Promise<number> | number;
  getStorageBytes(): Promise<number> | number;
}

/** Contract ABI Fetcher interface. */
export interface ContractAbiFetcher {
  fetchAbi(contractId: string): Promise<ContractAbi>;
}

/** Configuration options for {@link ContractAbiCache}. */
export interface AbiCacheOptions {
  /** ABI fetcher implementation or function. */
  fetcher?: ContractAbiFetcher | ((contractId: string) => Promise<ContractAbi>);
  /** Storage backend (defaults to MemoryAbiStorage). */
  storage?: AbiStorage;
  /** Time-to-live for cached ABIs in milliseconds (defaults to 1 hour = 3,600,000ms). */
  ttlMs?: number;
  /** Maximum number of ABIs to store concurrently (defaults to 500). */
  maxEntries?: number;
  /** Maximum storage budget in bytes before LRU eviction (defaults to 5MB = 5,242,880). */
  maxStorageBytes?: number;
  /** If true, removes docstrings to save storage (defaults to false). */
  compact?: boolean;
}

// ---------------------------------------------------------------------------
// Lazy Module Registry (#1175)
// ---------------------------------------------------------------------------

/** Metrics captured for a lazily loaded SDK module. */
export interface LazyModuleMetrics {
  /** Number of times the module loader was invoked. */
  loads: number;
  /** Number of successful module resolutions. */
  successes: number;
  /** Number of failed module resolutions. */
  failures: number;
  /** Time spent resolving the module (ms), cumulative. */
  totalLoadMs: number;
  /** Timestamp of the last load attempt (ms), or null if never loaded. */
  lastLoadedAt: number | null;
}

/** A lazily loaded SDK module registration. */
export interface LazyModuleEntry<T = unknown> {
  /** Unique module name used as the registry key. */
  name: string;
  /** Names of other modules this module depends on. */
  dependencies: string[];
  /** Dynamic import factory resolving the module on demand. */
  loader: () => Promise<T>;
}

/** Error thrown when a lazy module fails to load. */
export class LazyModuleLoadError extends Error {
  readonly moduleName: string;
  readonly cause?: unknown;

  constructor(moduleName: string, cause?: unknown) {
    super(`Failed to load SDK module "${moduleName}"`);
    this.name = "LazyModuleLoadError";
    this.moduleName = moduleName;
    this.cause = cause;
  }
}

/**
 * Registry that resolves SDK modules on demand via dynamic imports.
 *
 * Modules are registered with a dynamic import factory and their dependency
 * names. Dependencies are resolved (and cached) before the requested module
 * is loaded, so startup only pays for modules that are actually used.
 */
export class LazyModuleRegistry {
  private readonly entries = new Map<string, LazyModuleEntry>();
  private readonly resolved = new Map<string, unknown>();
  private readonly pending = new Map<string, Promise<unknown>>();
  private readonly metrics = new Map<string, LazyModuleMetrics>();

  /** Registers a module with its dynamic import factory and dependencies. */
  register<T>(entry: LazyModuleEntry<T>): void {
    if (this.entries.has(entry.name)) {
      throw new Error(`SDK module "${entry.name}" is already registered`);
    }
    this.entries.set(entry.name, entry as LazyModuleEntry);
    this.metrics.set(entry.name, {
      loads: 0,
      successes: 0,
      failures: 0,
      totalLoadMs: 0,
      lastLoadedAt: null,
    });
  }

  /** Returns true if a module with the given name is registered. */
  has(name: string): boolean {
    return this.entries.has(name);
  }

  /** Returns the registered dependency names for a module. */
  getDependencies(name: string): string[] {
    return this.entries.get(name)?.dependencies.slice() ?? [];
  }

  /**
   * Loads a module (and its dependencies) on demand. Resolved modules are
   * cached; concurrent calls share the same in-flight promise.
   */
  async load<T = unknown>(name: string): Promise<T> {
    if (this.resolved.has(name)) {
      return this.resolved.get(name) as T;
    }

    const inFlight = this.pending.get(name);
    if (inFlight) {
      return inFlight as Promise<T>;
    }

    const entry = this.entries.get(name);
    if (!entry) {
      throw new LazyModuleLoadError(name, new Error("module not registered"));
    }

    const promise = this.resolve(entry);
    this.pending.set(name, promise);
    try {
      return (await promise) as T;
    } finally {
      this.pending.delete(name);
    }
  }

  /** Returns a snapshot of load metrics for all registered modules. */
  getMetrics(): Record<string, LazyModuleMetrics> {
    const snapshot: Record<string, LazyModuleMetrics> = {};
    for (const [name, m] of this.metrics) {
      snapshot[name] = { ...m };
    }
    return snapshot;
  }

  private async resolve(entry: LazyModuleEntry): Promise<unknown> {
    const metrics = this.metrics.get(entry.name)!;
    metrics.loads++;
    metrics.lastLoadedAt = Date.now();
    const startedAt = Date.now();

    try {
      // Resolve dependencies first so the module can rely on them.
      for (const dep of entry.dependencies) {
        await this.load(dep);
      }

      const mod = await entry.loader();
      this.resolved.set(entry.name, mod);
      metrics.successes++;
      metrics.totalLoadMs += Date.now() - startedAt;
      return mod;
    } catch (err) {
      metrics.failures++;
      metrics.totalLoadMs += Date.now() - startedAt;
      throw err instanceof LazyModuleLoadError
        ? err
        : new LazyModuleLoadError(entry.name, err);
    }
  }
}

// ---------------------------------------------------------------------------
// Storage Implementations
// ---------------------------------------------------------------------------

/**
 * Fast in-memory storage with LRU eviction and byte-size tracking.
 */
export class MemoryAbiStorage implements AbiStorage {
  private readonly store = new Map<string, CachedAbiEntry>();
  private totalBytes = 0;
  private readonly maxEntries: number;
  private readonly maxBytes: number;
  private evictions = 0;
  private collections = 0;
  private lastCollectedAt: number | null = null;
  private accessSeq = 0;

  constructor(options?: { maxEntries?: number; maxBytes?: number }) {
    this.maxEntries = options?.maxEntries ?? 500;
    this.maxBytes = options?.maxBytes ?? 5 * 1024 * 1024;
  }

  get(key: string): CachedAbiEntry | null {
    const entry = this.store.get(key);
    if (!entry) return null;
    entry.lastAccessedAt = ++this.accessSeq;
    entry.accessCount++;
    return entry;
  }

  set(key: string, entry: CachedAbiEntry): void {
    const existing = this.store.get(key);
    if (existing) {
      this.totalBytes -= existing.byteSize;
    }

    entry.lastAccessedAt = ++this.accessSeq;

    // Check capacity and evict LRU entries if needed
    while (
      (this.store.size >= this.maxEntries || this.totalBytes + entry.byteSize > this.maxBytes) &&
      this.store.size > 0
    ) {
      this.evictLru();
    }

    this.store.set(key, entry);
    this.totalBytes += entry.byteSize;
  }

  delete(key: string): boolean {
    const existing = this.store.get(key);
    if (existing) {
      this.totalBytes -= existing.byteSize;
      return this.store.delete(key);
    }
    return false;
  }

  clear(): void {
    this.store.clear();
    this.totalBytes = 0;
  }

  keys(): string[] {
    return Array.from(this.store.keys());
  }

  size(): number {
    return this.store.size;
  }

  getStorageBytes(): number {
    return this.totalBytes;
  }

  getEvictions(): number {
    return this.evictions;
  }

  /**
   * Garbage-collects entries that have expired (past their `expiresAt`).
   * Returns the number of entries removed.
   */
  collectGarbage(now: number = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this.store) {
      if (entry.expiresAt > 0 && entry.expiresAt <= now) {
        this.delete(key);
        removed++;
      }
    }
    this.collections++;
    this.lastCollectedAt = now;
    return removed;
  }

  /** Returns a snapshot of current memory pool usage. */
  getMemoryStats(): AbiMemoryStats {
    const utilization =
      this.maxBytes > 0 ? Math.min(1, this.totalBytes / this.maxBytes) : 0;
    return {
      entryCount: this.store.size,
      storageBytes: this.totalBytes,
      maxEntries: this.maxEntries,
      maxBytes: this.maxBytes,
      utilization,
      evictions: this.evictions,
      collections: this.collections,
      lastCollectedAt: this.lastCollectedAt,
    };
  }

  private evictLru(): void {
    let oldestKey: string | null = null;
    let oldestAccess = Infinity;

    for (const [key, entry] of this.store) {
      if (entry.lastAccessedAt < oldestAccess) {
        oldestAccess = entry.lastAccessedAt;
        oldestKey = key;
      }
    }

    if (oldestKey) {
      this.delete(oldestKey);
      this.evictions++;
    }
  }
}

/**
 * Storage adapter backed by {@link StorageAdapter} (e.g. localStorage/sessionStorage/MemoryStorageAdapter).
 */
export class AdapterAbiStorage implements AbiStorage {
  private readonly adapter: StorageAdapter;
  private readonly prefix: string;
  private readonly knownKeys: Set<string>;

  constructor(adapter: StorageAdapter = new MemoryStorageAdapter(), prefix = "stellar_abi_cache:") {
    this.adapter = adapter;
    this.prefix = prefix;
    this.knownKeys = new Set(
      adapter.keys?.().filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length)) ?? [],
    );
  }

  get(key: string): CachedAbiEntry | null {
    const raw = this.adapter.getItem(this.prefix + key);
    if (!raw) return null;
    let entry: CachedAbiEntry;
    try {
      entry = JSON.parse(raw) as CachedAbiEntry;
    } catch {
      return null;
    }
    this.knownKeys.add(key);
    entry.lastAccessedAt = Date.now();
    entry.accessCount = (entry.accessCount || 0) + 1;
    this.adapter.setItem(this.prefix + key, JSON.stringify(entry));
    return entry;
  }

  set(key: string, entry: CachedAbiEntry): void {
    this.adapter.setItem(this.prefix + key, JSON.stringify(entry));
    this.knownKeys.add(key);
  }

  delete(key: string): boolean {
    const storageKey = this.prefix + key;
    if (this.adapter.getItem(storageKey) === null) return false;
    this.adapter.removeItem(storageKey);
    this.knownKeys.delete(key);
    return true;
  }

  clear(): void {
    for (const key of this.keys()) this.adapter.removeItem(this.prefix + key);
    this.knownKeys.clear();
  }

  keys(): string[] {
    if (this.adapter.keys) {
      const currentKeys = this.adapter.keys()
        .filter((key) => key.startsWith(this.prefix))
        .map((key) => key.slice(this.prefix.length));
      this.knownKeys.clear();
      for (const key of currentKeys) this.knownKeys.add(key);
    }
    return Array.from(this.knownKeys);
  }

  size(): number {
    return this.keys().length;
  }

  getStorageBytes(): number {
    return this.keys().reduce((total, key) => {
      const storageKey = this.prefix + key;
      const value = this.adapter.getItem(storageKey);
      return total + new TextEncoder().encode(storageKey + (value ?? '')).length;
    }, 0);
  }
}

// ---------------------------------------------------------------------------
// Static fetcher (test / offline use)
// ---------------------------------------------------------------------------

/** A {@link ContractAbiFetcher} backed by a static, in-memory registry of ABIs. */
export class StaticContractAbiFetcher implements ContractAbiFetcher {
  private readonly abis = new Map<string, ContractAbi>();

  /** Registers (or replaces) the ABI for a contract ID. */
  registerAbi(contractId: string, abi: ContractAbi): void {
    this.abis.set(contractId, abi);
  }

  async fetchAbi(contractId: string): Promise<ContractAbi> {
    const abi = this.abis.get(contractId);
    if (!abi) {
      throw new AbiNotFoundError(contractId);
    }
    return abi;
  }
}

// ---------------------------------------------------------------------------
// Contract ABI cache
// ---------------------------------------------------------------------------

function stripAbiDocs(abi: ContractAbi): ContractAbi {
  return {
    ...abi,
    functions: abi.functions.map((fn) => ({
      ...fn,
      doc: undefined,
      inputs: fn.inputs.map((input) => ({ ...input, doc: undefined })),
      outputs: fn.outputs?.map((output) => ({ ...output, doc: undefined })),
    })),
    types: abi.types?.map((type) => ({ ...type, doc: undefined })),
  };
}

function estimateAbiBytes(abi: ContractAbi): number {
  return new TextEncoder().encode(JSON.stringify(abi)).length;
}

/**
 * Caches Soroban contract ABIs, eliminating redundant network lookups for
 * repeated invocations against the same contract (#1054).
 */
export class ContractAbiCache {
  private readonly fetcher: ContractAbiFetcher | ((contractId: string) => Promise<ContractAbi>);
  private readonly storage: AbiStorage;
  private readonly ttlMs: number;
  private readonly compact: boolean;
  private hits = 0;
  private misses = 0;

  constructor(options: AbiCacheOptions) {
    this.fetcher =
      options.fetcher ??
      (() => {
        throw new Error("ContractAbiCache requires a fetcher");
      });
    this.storage =
      options.storage ??
      new MemoryAbiStorage({ maxEntries: options.maxEntries, maxBytes: options.maxStorageBytes });
    this.ttlMs = options.ttlMs ?? 3_600_000;
    this.compact = options.compact ?? false;
  }

  private async fetch(contractId: string): Promise<ContractAbi> {
    return typeof this.fetcher === "function"
      ? this.fetcher(contractId)
      : this.fetcher.fetchAbi(contractId);
  }

  async get(contractId: string): Promise<ContractAbi> {
    const existing = await this.storage.get(contractId);
    if (existing && existing.expiresAt > Date.now()) {
      this.hits++;
      return existing.abi;
    }

    this.misses++;
    const fetched = await this.fetch(contractId);
    const abi = this.compact ? stripAbiDocs(fetched) : fetched;
    const now = Date.now();
    const entry: CachedAbiEntry = {
      contractId,
      abi,
      cachedAt: now,
      expiresAt: now + this.ttlMs,
      lastAccessedAt: now,
      accessCount: 1,
      byteSize: estimateAbiBytes(abi),
    };
    await this.storage.set(contractId, entry);
    return abi;
  }

  async has(contractId: string): Promise<boolean> {
    const entry = await this.storage.get(contractId);
    if (!entry) return false;
    return entry.expiresAt > Date.now();
  }

  async invalidate(contractId: string): Promise<boolean> {
    return this.storage.delete(contractId);
  }

  async invalidateByWasmHash(wasmHash: string): Promise<number> {
    let removed = 0;
    for (const key of await this.storage.keys()) {
      const entry = await this.storage.get(key);
      if (entry && entry.abi.wasmHash === wasmHash) {
        await this.storage.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async invalidateExpired(): Promise<number> {
    const now = Date.now();
    let removed = 0;
    for (const key of await this.storage.keys()) {
      const entry = await this.storage.get(key);
      if (entry && entry.expiresAt <= now) {
        await this.storage.delete(key);
        removed++;
      }
    }
    return removed;
  }

  async clear(): Promise<void> {
    await this.storage.clear();
  }

  async getStats(): Promise<AbiCacheStats> {
    const entryCount = await this.storage.size();
    const storageBytes = await this.storage.getStorageBytes();
    const total = this.hits + this.misses;
    const storageWithEvictions = this.storage as unknown as { getEvictions?: () => number };
    const evictions =
      typeof storageWithEvictions.getEvictions === "function"
        ? storageWithEvictions.getEvictions()
        : 0;
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate: total === 0 ? 0 : this.hits / total,
      entryCount,
      storageBytes,
      evictions,
    };
  }
}
