/**
 * Simple in-memory cache with per-entry TTL.
 *
 * Used by StellarSplitClient to avoid redundant RPC calls for read-heavy
 * operations like getInvoice().
 */

export interface CacheStats {
  hits: number;
  misses: number;
  /** hits / (hits + misses); 0 when there have been no lookups. */
  hitRate: number;
  size: number;
  keys: string[];
  evictions: number;
  compressions: number;
  decompressions: number;
  bytesSaved: number;
}

export interface MethodCacheEntry {
  value: any;
  expiresAt: number;
}

export type CacheEventType =
  | "hit"
  | "miss"
  | "set"
  | "evict"
  | "invalidate"
  | "clear"
  | "compress"
  | "decompress"
  | "expire";

export interface CacheEvent {
  type: CacheEventType;
  key?: string;
  size?: number;
  bytesSaved?: number;
  timestamp?: number;
}

export type CacheEventListener = (event: CacheEvent) => void;

export interface CompressionOptions {
  /** Enable compression of cached values. Defaults to false. */
  enabled?: boolean;
  /** Minimum serialized byte length before a value is compressed. Defaults to 1024. */
  threshold?: number;
}

/**
 * Lightweight, dependency-free compression codec.
 */
export class CacheCompressor {
  private readonly threshold: number;

  constructor(threshold = 1024) {
    this.threshold = threshold;
  }

  shouldCompress(payload: string): boolean {
    return payload.length >= this.threshold;
  }

  compress(input: string): string {
    const dictionary: Record<string, string> = {
      '"': "\u0001",
      "{": "\u0002",
      "}": "\u0003",
      "[": "\u0004",
      "]": "\u0005",
      ",": "\u0006",
      ":": "\u0007",
      "true": "\u0008",
      "false": "\u0009",
      "null": "\u000a",
    };

    let out = input;
    for (const [token, code] of Object.entries(dictionary)) {
      out = out.split(token).join(code);
    }

    let rle = "";
    let i = 0;
    while (i < out.length) {
      const ch = out[i]!;
      let run = 1;
      while (i + run < out.length && out[i + run] === ch) run++;
      if (run > 3) {
        rle += `\u000b${run}${ch}`;
      } else {
        rle += ch.repeat(run);
      }
      i += run;
    }

    return `\u0000${rle}`;
  }

  decompress(input: string): string {
    if (!input.startsWith("\u0000")) return input;
    const body = input.slice(1);

    let expanded = "";
    let i = 0;
    while (i < body.length) {
      if (body[i] === "\u000b") {
        i++;
        let countStr = "";
        while (i < body.length && body[i]! >= "0" && body[i]! <= "9") {
          countStr += body[i]!;
          i++;
        }
        const ch = body[i] ?? "";
        i++;
        expanded += ch.repeat(parseInt(countStr, 10));
      } else {
        expanded += body[i]!;
        i++;
      }
    }

    const dictionary: Record<string, string> = {
      "\u0001": '"',
      "\u0002": "{",
      "\u0003": "}",
      "\u0004": "[",
      "\u0005": "]",
      "\u0006": ",",
      "\u0007": ":",
      "\u0008": "true",
      "\u0009": "false",
      "\u000a": "null",
    };

    let out = expanded;
    for (const [code, token] of Object.entries(dictionary)) {
      out = out.split(code).join(token);
    }

    return out;
  }
}

export interface DebugModeOptions {
  enabled?: boolean;
  logger?: (message: string, ...args: any[]) => void;
}

export class DebugMode {
  private enabled: boolean;
  private readonly logger: (message: string, ...args: any[]) => void;
  private readonly listeners = new Set<(enabled: boolean) => void>();

  constructor(options?: DebugModeOptions) {
    this.enabled = options?.enabled ?? false;
    this.logger =
      options?.logger ??
      ((message: string, ...args: any[]) => console.debug(message, ...args));
  }

  get isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    if (this.enabled === enabled) return;
    this.enabled = enabled;
    for (const listener of this.listeners) {
      listener(enabled);
    }
  }

  enable(): void {
    this.setEnabled(true);
  }

  disable(): void {
    this.setEnabled(false);
  }

  onChange(listener: (enabled: boolean) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  log(message: string, ...args: any[]): void {
    if (!this.enabled) return;
    this.logger(message, ...args);
  }
}

export class SimpleCache<T> {
  private readonly store = new Map<string, MethodCacheEntry>();
  private readonly ttlConfig: Record<string, number>;
  private enabled: boolean;
  private hits = 0;
  private misses = 0;
  private evictions = 0;
  private compressions = 0;
  private decompressions = 0;
  private bytesSaved = 0;
  private maxEntries: number;
  private readonly compressor?: CacheCompressor;
  private readonly listeners = new Set<CacheEventListener>();
  private readonly debug: DebugMode;

  constructor(
    config?:
      | number
      | {
          enabled?: boolean;
          ttl?: Record<string, number>;
          ttlMs?: number;
          maxEntries?: number;
          compression?: boolean | CompressionOptions;
          debug?: boolean | DebugModeOptions;
        },
  ) {
    if (typeof config === "number") {
      this.enabled = true;
      this.maxEntries = 1000;
      this.ttlConfig = { default: config };
      this.compressor = undefined;
    } else {
      this.enabled =
        config?.enabled ??
        (config?.ttl !== undefined || config?.ttlMs !== undefined);
      this.maxEntries = config?.maxEntries ?? (this.enabled ? 1000 : 0);
      this.ttlConfig = config?.ttl ?? {};
      if (config?.ttlMs !== undefined) {
        this.ttlConfig["default"] = config.ttlMs;
      }
      const compression = config?.compression;
      if (compression === true) {
        this.compressor = new CacheCompressor();
      } else if (
        compression &&
        typeof compression === "object" &&
        compression.enabled
      ) {
        this.compressor = new CacheCompressor(compression.threshold);
      } else {
        this.compressor = undefined;
      }
    }
    this.debug = new DebugMode(
      typeof config === "object" && config?.debug !== undefined
        ? typeof config.debug === "boolean"
          ? { enabled: config.debug }
          : config.debug
        : undefined,
    );
  }

  /** Register a listener for cache lifecycle events. */
  on(listener: CacheEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Remove a previously registered listener. */
  off(listener: CacheEventListener): void {
    this.listeners.delete(listener);
  }

  private emit(eventOrType: CacheEvent | CacheEventType, key?: string): void {
    if (this.listeners.size === 0) return;
    const event: CacheEvent =
      typeof eventOrType === "string"
        ? { type: eventOrType, key, timestamp: Date.now() }
        : eventOrType;
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /** Access the debug-mode controller for this cache instance. */
  getDebugMode(): DebugMode {
    return this.debug;
  }

  get(key: string): T | undefined {
    if (!this.enabled) return undefined;
    const entry = this.store.get(key);
    if (!entry) {
      this.misses++;
      this.emit("miss", key);
      return undefined;
    }
    if (Date.now() > entry.expiresAt) {
      this.store.delete(key);
      this.misses++;
      this.emit("expire", key);
      this.emit("miss", key);
      return undefined;
    }

    // Update LRU order
    this.store.delete(key);
    this.store.set(key, entry);

    this.hits++;
    this.emit("hit", key);
    return entry.value;
  }

  /**
   * Store a value. `ttlMs` overrides the configured per-method/default TTL
   * for this entry only.
   */
  set(key: string, value: T, ttlMs?: number): void {
    if (!this.enabled) return;
    const method = key.split(":")[0] || key;
    const ttl = ttlMs ?? this.ttlConfig[method] ?? this.ttlConfig["default"] ?? 0;
    if (ttl <= 0) return;

    if (this.maxEntries > 0 && this.store.size >= this.maxEntries && !this.store.has(key)) {
      const oldestKey = this.store.keys().next().value;
      if (oldestKey !== undefined) {
        this.store.delete(oldestKey);
        this.evictions++;
        this.emit("evict", oldestKey);
      }
    }

    this.store.set(key, { value, expiresAt: Date.now() + ttl });
    this.emit("set", key);
  }

  invalidate(methodOrKey?: string, args?: any[]): void {
    if (!methodOrKey) {
      const keys = Array.from(this.store.keys());
      this.store.clear();
      for (const key of keys) {
        this.emit("invalidate", key);
      }
      return;
    }
    if (args) {
      const key = `${methodOrKey}:${JSON.stringify(args)}`;
      if (this.store.delete(key)) {
        this.emit("invalidate", key);
      }
      return;
    }

    // Check if it's an exact key
    if (this.store.has(methodOrKey)) {
      this.store.delete(methodOrKey);
      this.emit("invalidate", methodOrKey);
    }

    // Invalidate by method prefix
    const prefix = `${methodOrKey}:`;
    for (const key of this.store.keys()) {
      if (key.startsWith(prefix)) {
        this.store.delete(key);
        this.emit("invalidate", key);
      }
    }
    this.debug.log(`[cache] invalidate ${methodOrKey}`);
  }

  /**
   * Invalidate every entry whose key matches the predicate or RegExp.
   * Returns the number of entries removed.
   */
  invalidateWhere(match: RegExp | ((key: string) => boolean)): number {
    const test = typeof match === "function" ? match : (k: string) => match.test(k);
    let removed = 0;
    for (const key of Array.from(this.store.keys())) {
      if (test(key)) {
        this.store.delete(key);
        this.emit("invalidate", key);
        removed++;
      }
    }
    return removed;
  }

  delete(key: string): void {
    this.invalidate(key);
  }

  clear(): void {
    this.store.clear();
    this.debug.log("[cache] clear");
  }

  getStats(): CacheStats {
    const now = Date.now();
    for (const [key, entry] of this.store.entries()) {
      if (now > entry.expiresAt) {
        this.store.delete(key);
        this.emit("expire", key);
      }
    }
    return {
      hits: this.hits,
      misses: this.misses,
      hitRate:
        this.hits + this.misses === 0 ? 0 : this.hits / (this.hits + this.misses),
      size: this.store.size,
      keys: Array.from(this.store.keys()),
      evictions: this.evictions,
      compressions: this.compressions,
      decompressions: this.decompressions,
      bytesSaved: this.bytesSaved,
    };
  }

  entries(): Map<string, T> {
    const now = Date.now();
    const result = new Map<string, T>();
    for (const [key, entry] of this.store) {
      if (now <= entry.expiresAt) result.set(key, this.decode(entry.value));
    }
    return result;
  }

  replaceAll(next: Map<string, T>): void {
    this.store.clear();
    for (const [key, value] of next) {
      this.set(key, value);
    }
  }

  // ── compression helpers ──────────────────────────────────────────────────

  private encode(value: T): any {
    if (!this.compressor) return value;
    let payload: string;
    try {
      payload = JSON.stringify(value);
    } catch {
      return value;
    }
    if (payload === undefined || !this.compressor.shouldCompress(payload)) {
      return value;
    }
    const compressed = this.compressor.compress(payload);
    if (compressed.length >= payload.length) return value;
    this.compressions++;
    this.bytesSaved += payload.length - compressed.length;
    this.emit({ type: "compress", size: compressed.length, bytesSaved: payload.length - compressed.length });
    return { __compressed: true, data: compressed };
  }

  private decode(value: any): T {
    if (!this.compressor || value === null || typeof value !== "object" || !(value as any).__compressed) {
      return value as T;
    }
    this.decompressions++;
    this.emit({ type: "decompress", size: (value as any).data?.length });
    try {
      return JSON.parse(this.compressor.decompress((value as any).data)) as T;
    } catch {
      return value as T;
    }
  }
}

/**
 * A lightweight, generic in-memory cache with optional TTL-based entry expiry.
 *
 * When `ttlMs` is omitted entries never expire, preserving backward-compatible
 * behaviour.  When supplied, `get()` and `has()` silently evict stale entries
 * on access, and `purgeExpired()` sweeps the entire store in one pass.
 *
 * Usage:
 *   const cache = new Cache<Invoice>(30_000); // 30-second TTL
 *   cache.set("inv:1", invoice);
 *   cache.get("inv:1"); // undefined after 30 s
 */
interface CacheEntry<V> {
  value: V;
  /** Unix ms timestamp recorded at write time. */
  writtenAt: number;
}

export class Cache<V> {
  private readonly store = new Map<string, CacheEntry<V>>();
  private readonly ttlMs: number | undefined;
  private readonly listeners = new Set<CacheEventListener>();
  private readonly debug: DebugMode;

  /**
   * @param ttlMs  Time-to-live in milliseconds.  Omit (or pass `undefined`)
   *               for no-expiry behaviour.
   * @param debug  Optional debug-mode configuration for verbose logging.
   */
  constructor(ttlMs?: number, debug?: boolean | DebugModeOptions) {
    this.ttlMs = ttlMs;
    this.debug = new DebugMode(
      typeof debug === "boolean" ? { enabled: debug } : debug
    );
  }

  /** Access the debug-mode controller for this cache instance. */
  getDebugMode(): DebugMode {
    return this.debug;
  }

  /**
   * Subscribe to cache lifecycle events (set, hit, miss, expire, invalidate).
   * Returns an unsubscribe function.
   */
  on(listener: CacheEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(type: CacheEventType, key: string): void {
    if (this.listeners.size === 0) return;
    const event: CacheEvent = { type, key, timestamp: Date.now() };
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  /**
   * Store `value` under `key`, recording the current wall-clock time.
   */
  set(key: string, value: V): void {
    this.store.set(key, { value, writtenAt: Date.now() });
    this.emit("set", key);
  }

  /**
   * Retrieve the value for `key`.
   *
   * Returns `undefined` and **deletes the entry** when the entry is expired
   * (i.e. `Date.now() - writtenAt > ttlMs`).  Returns `undefined` for
   * missing keys regardless of TTL configuration.
   */
  get(key: string): V | undefined {
    const entry = this.store.get(key);
    if (!entry) {
      this.emit("miss", key);
      return undefined;
    }
    if (this.isExpired(entry)) {
      this.store.delete(key);
      this.emit("expire", key);
      this.emit("miss", key);
      return undefined;
    }
    this.emit("hit", key);
    return entry.value;
  }

  /**
   * Returns `true` only when the key exists **and** is not expired.
   * Expired entries are deleted as a side-effect.
   */
  has(key: string): boolean {
    const entry = this.store.get(key);
    if (!entry) return false;
    if (this.isExpired(entry)) {
      this.store.delete(key);
      this.emit("expire", key);
      return false;
    }
    return true;
  }

  /**
   * Remove all entries whose TTL has elapsed in a single sweep.
   * No-op when no TTL is configured.
   */
  purgeExpired(): void {
    if (this.ttlMs === undefined) return;
    for (const [key, entry] of this.store) {
      if (this.isExpired(entry)) {
        this.store.delete(key);
        this.emit("expire", key);
      }
    }
  }

  /** Remove a specific entry by key. */
  delete(key: string): void {
    if (this.store.delete(key)) {
      this.emit("invalidate", key);
    }
  }

  /** Remove all entries. */
  clear(): void {
    const keys = Array.from(this.store.keys());
    this.store.clear();
    for (const key of keys) {
      this.emit("invalidate", key);
    }
  }

  /** Number of entries currently in the store (including not-yet-evicted expired ones). */
  get size(): number {
    return this.store.size;
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private isExpired(entry: CacheEntry<V>): boolean {
    if (this.ttlMs === undefined) return false;
    return Date.now() - entry.writtenAt > this.ttlMs;
  }
}

/**
 * Outcome of a nonce deduplication check.
 */
export type NonceDedupOutcome = "accepted" | "duplicate";

/**
 * Event payload emitted for every nonce deduplication decision.
 */
export interface NonceDedupEvent {
  /** The nonce that was evaluated. */
  nonce: string;
  /** Whether the request was accepted (first-seen) or rejected as a duplicate. */
  outcome: NonceDedupOutcome;
  /** Unix ms timestamp of the decision. */
  timestamp: number;
}

/**
 * Listener invoked whenever a nonce deduplication decision is made.
 */
export type NonceDedupListener = (event: NonceDedupEvent) => void;

/**
 * Configuration for {@link NonceDeduplicator}.
 *
 * Deduplication is **opt-in**: when `enabled` is omitted or `false` the
 * deduplicator is a transparent pass-through and every nonce is accepted,
 * preserving existing behaviour.
 */
export interface NonceDeduplicatorConfig {
  /** Enable deduplication. Defaults to `false` (pass-through). */
  enabled?: boolean;
  /** Time-to-live in ms for a seen nonce. Defaults to 300_000 (5 minutes). */
  ttlMs?: number;
  /** Maximum number of tracked nonces before oldest-first eviction. Defaults to 1000. */
  maxEntries?: number;
}

/**
 * Optional request deduplication keyed by nonce.
 *
 * Tracks recently seen nonces so that a repeated request (same nonce) can be
 * detected and rejected.  When disabled (the default) every nonce is accepted
 * and no state is retained, so callers can adopt it without changing behaviour.
 *
 * Usage:
 *   const dedup = new NonceDeduplicator({ enabled: true, ttlMs: 60_000 });
 *   dedup.on("dedup", (e) => console.log(e.outcome));
 *   if (dedup.check(nonce) === "duplicate") { ... }
 */
export class NonceDeduplicator {
  private readonly enabled: boolean;
  private readonly ttlMs: number;
  private readonly maxEntries: number;
  private readonly seen = new Map<string, number>();
  private readonly listeners = new Set<NonceDedupListener>();

  constructor(config?: NonceDeduplicatorConfig) {
    this.enabled = config?.enabled ?? false;
    this.ttlMs = config?.ttlMs ?? 300_000;
    this.maxEntries = config?.maxEntries ?? 1000;
  }

  /**
   * Evaluate `nonce` and record it when accepted.
   *
   * @returns `"duplicate"` when the nonce was seen within the TTL window,
   *          otherwise `"accepted"`.  Always `"accepted"` when disabled.
   */
  check(nonce: string): NonceDedupOutcome {
    if (!this.enabled) {
      this.emit({ nonce, outcome: "accepted", timestamp: Date.now() });
      return "accepted";
    }

    this.purgeExpired();

    if (this.seen.has(nonce)) {
      this.emit({ nonce, outcome: "duplicate", timestamp: Date.now() });
      return "duplicate";
    }

    if (this.maxEntries > 0 && this.seen.size >= this.maxEntries) {
      const oldest = this.seen.keys().next().value;
      if (oldest !== undefined) this.seen.delete(oldest);
    }

    this.seen.set(nonce, Date.now() + this.ttlMs);
    this.emit({ nonce, outcome: "accepted", timestamp: Date.now() });
    return "accepted";
  }

  /** Convenience predicate: `true` when `nonce` is a duplicate. */
  isDuplicate(nonce: string): boolean {
    return this.check(nonce) === "duplicate";
  }

  /** Register a listener for deduplication decisions. */
  on(_event: "dedup", listener: NonceDedupListener): void {
    this.listeners.add(listener);
  }

  /** Remove a previously registered listener. */
  off(_event: "dedup", listener: NonceDedupListener): void {
    this.listeners.delete(listener);
  }

  /** Remove all tracked nonces. */
  clear(): void {
    this.seen.clear();
  }

  /** Number of nonces currently tracked (including not-yet-evicted expired ones). */
  get size(): number {
    return this.seen.size;
  }

  // ── private helpers ──────────────────────────────────────────────────────

  private purgeExpired(): void {
    const now = Date.now();
    for (const [nonce, expiresAt] of this.seen) {
      if (now > expiresAt) this.seen.delete(nonce);
    }
  }

  private emit(event: NonceDedupEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }
}
