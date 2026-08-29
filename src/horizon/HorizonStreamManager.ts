/**
 * HorizonStreamManager — wraps Horizon's SSE `payments`/`operations` streams
 * with cursor bookmarking so reconnects resume from the last confirmed event
 * instead of dropping everything that happened while the SSE connection was
 * down.
 *
 * The manager tracks the `paging_token` of the last event it delivered to
 * the handler as a persistent cursor (via a pluggable {@link CursorStore} —
 * localStorage, sessionStorage, or in-memory). On disconnect it reconnects
 * with `.cursor(lastToken).stream()`, deduplicates any overlapping events
 * against a small ring buffer of recently seen tokens, and discards replayed
 * events older than `replayCutoffMs` so a long-stale cursor can't flood the
 * handler with ancient history.
 */

import { EventEmitter } from "events";
import { Horizon } from "@stellar/stellar-sdk";
import { ValidationError } from "../errors.js";

/** Minimal shape of a Horizon payment/operation record this module depends on. */
export interface HorizonStreamRecord {
  paging_token: string;
  created_at?: string;
  [key: string]: unknown;
}

/** Subset of Horizon's `CallBuilder` surface this module depends on. */
export interface HorizonCallBuilderLike<T> {
  cursor(cursor: string): HorizonCallBuilderLike<T>;
  stream(options: {
    onmessage?: (value: T) => void;
    onerror?: (event: unknown) => void;
  }): () => void;
}

/** Produces a fresh, account-scoped call builder for a stream reconnect attempt. */
export type HorizonStreamSource<T extends HorizonStreamRecord> = (
  accountId: string,
) => HorizonCallBuilderLike<T>;

/** Storage abstraction for the persistent cursor — mirrors the SDK's cache-store pattern. */
export interface CursorStore {
  get(key: string): string | null;
  set(key: string, value: string): void;
}

/** In-memory cursor store — the default, and the fallback outside browser environments. */
export class InMemoryCursorStore implements CursorStore {
  private readonly _map = new Map<string, string>();

  get(key: string): string | null {
    return this._map.get(key) ?? null;
  }

  set(key: string, value: string): void {
    this._map.set(key, value);
  }
}

class WebStorageCursorStore implements CursorStore {
  constructor(private readonly _storage: Storage) {}

  get(key: string): string | null {
    return this._storage.getItem(key);
  }

  set(key: string, value: string): void {
    this._storage.setItem(key, value);
  }
}

/** Cursor store backed by `window.localStorage`; falls back to in-memory outside browsers. */
export function createLocalStorageCursorStore(): CursorStore {
  if (typeof window === "undefined" || typeof window.localStorage === "undefined") {
    return new InMemoryCursorStore();
  }
  return new WebStorageCursorStore(window.localStorage);
}

/** Cursor store backed by `window.sessionStorage`; falls back to in-memory outside browsers. */
export function createSessionStorageCursorStore(): CursorStore {
  if (typeof window === "undefined" || typeof window.sessionStorage === "undefined") {
    return new InMemoryCursorStore();
  }
  return new WebStorageCursorStore(window.sessionStorage);
}

export type HorizonStreamKind = "payments" | "operations";

export const DEFAULT_REPLAY_CUTOFF_MS = 300_000;
export const DEFAULT_DEDUPE_BUFFER_SIZE = 256;
export const DEFAULT_RECONNECT_DELAY_MS = 1_000;
export const MAX_RECONNECT_DELAY_MS = 30_000;

export interface HorizonStreamManagerConfig<T extends HorizonStreamRecord = HorizonStreamRecord> {
  /** Horizon server URL. Required unless `source` is supplied directly (e.g. for tests). */
  horizonUrl?: string;
  /** Which SSE endpoint to stream. Default: "payments". Ignored when `source` is supplied. */
  kind?: HorizonStreamKind;
  /** Injectable call-builder factory — overrides `horizonUrl`/`kind`. Mainly for tests. */
  source?: HorizonStreamSource<T>;
  /** Where the cursor is persisted. Default: {@link InMemoryCursorStore}. */
  cursorStore?: CursorStore;
  /** Key prefix used when persisting the cursor, namespaced per account. */
  storageNamespace?: string;
  /** Replayed events older than this (by `created_at`) are discarded. Default: 300 000ms. */
  replayCutoffMs?: number;
  /** Size of the recently-seen-tokens dedupe ring buffer. Default: 256. */
  dedupeBufferSize?: number;
  /** Delay before reconnecting after a stream error. Default: 1 000ms. */
  reconnectDelayMs?: number;
  /** Maximum number of reconnect attempts before giving up. Default: Infinity (unlimited). */
  maxReconnectAttempts?: number;
  /** Time source — exposed for deterministic tests. */
  now?: () => number;
}

/** Event map for {@link HorizonStreamManager}. */
export interface HorizonStreamEventMap {
  "stream:reconnected": [{ accountId: string; cursor: string | null }];
  "stream:reconnecting": [{ accountId: string; attempt: number; delayMs: number }];
  "stream:lag": [{ accountId: string; error: unknown }];
  "stream:cursor_advanced": [{ accountId: string; cursor: string }];
  "stream:reconnect_failed": [{ accountId: string; attempts: number }];
}

function defaultSource<T extends HorizonStreamRecord>(
  horizonUrl: string,
  kind: HorizonStreamKind,
): HorizonStreamSource<T> {
  const server = new Horizon.Server(horizonUrl);
  return (accountId: string) => {
    const builder = kind === "payments" ? server.payments() : server.operations();
    return builder.forAccount(accountId) as unknown as HorizonCallBuilderLike<T>;
  };
}

/**
 * Manages a single cursor-bookmarked Horizon SSE stream (payments or
 * operations) for one account at a time. Call {@link start} to begin
 * streaming and {@link stop} to tear it down.
 */
export class HorizonStreamManager<
  T extends HorizonStreamRecord = HorizonStreamRecord,
> extends EventEmitter {
  private readonly _source: HorizonStreamSource<T>;
  private readonly _cursorStore: CursorStore;
  private readonly _storageNamespace: string;
  private readonly _replayCutoffMs: number;
  private readonly _dedupeBufferSize: number;
  private readonly _reconnectDelayMs: number;
  private readonly _maxReconnectAttempts: number;
  private readonly _now: () => number;

  private _accountId: string | null = null;
  private _handler: ((record: T) => void) | null = null;
  private _cursor: string | null = null;
  private _closeStream: (() => void) | null = null;
  private _reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private _stopped = true;
  private _reconnectAttempts = 0;
  private _seenTokens: string[] = [];
  private readonly _seenSet = new Set<string>();

  constructor(config: HorizonStreamManagerConfig<T> = {}) {
    super();

    if (config.source) {
      this._source = config.source;
    } else {
      if (!config.horizonUrl) {
        throw new ValidationError("HorizonStreamManager requires horizonUrl or source");
      }
      this._source = defaultSource<T>(config.horizonUrl, config.kind ?? "payments");
    }

    this._cursorStore = config.cursorStore ?? new InMemoryCursorStore();
    this._storageNamespace = config.storageNamespace ?? "stellar-split:horizon-cursor";
    this._replayCutoffMs = config.replayCutoffMs ?? DEFAULT_REPLAY_CUTOFF_MS;
    this._dedupeBufferSize = config.dedupeBufferSize ?? DEFAULT_DEDUPE_BUFFER_SIZE;
    this._reconnectDelayMs = config.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS;
    this._maxReconnectAttempts = config.maxReconnectAttempts ?? Infinity;
    this._now = config.now ?? (() => Date.now());
  }

  /** Begin streaming events for `accountId`, resuming from any persisted cursor. */
  start(accountId: string, handler: (record: T) => void): void {
    this.stop();
    this._accountId = accountId;
    this._handler = handler;
    this._stopped = false;
    this._reconnectAttempts = 0;
    this._cursor = this._cursorStore.get(this._cursorKey(accountId));
    this._seenTokens = [];
    this._seenSet.clear();
    this._connect(false);
  }

  /** Stop streaming and release the underlying connection. Idempotent. */
  stop(): void {
    this._stopped = true;
    if (this._reconnectTimer !== null) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }
    this._closeStream?.();
    this._closeStream = null;
  }

  /** The last confirmed cursor (paging_token), or `null` if nothing has been received yet. */
  getCursor(): string | null {
    return this._cursor;
  }

  /** Manually override the cursor (e.g. to skip forward or replay from an earlier point). */
  setCursor(token: string): void {
    this._cursor = token;
    this._persistCursor();
  }

  private _cursorKey(accountId: string): string {
    return `${this._storageNamespace}:${accountId}`;
  }

  private _connect(isReconnect: boolean): void {
    if (this._stopped || !this._accountId) return;

    const builder = this._source(this._accountId);
    const target = this._cursor !== null ? builder.cursor(this._cursor) : builder;

    this._closeStream = target.stream({
      onmessage: (record) => this._onMessage(record),
      onerror: (event) => this._onError(event),
    });

    if (isReconnect) {
      this._reconnectAttempts = 0;
      this.emit("stream:reconnected", { accountId: this._accountId, cursor: this._cursor });
    }
  }

  private _onMessage(record: T): void {
    const token = record.paging_token;
    if (!token || this._seenSet.has(token)) return;
    this._remember(token);

    if (this._isStale(record)) return;

    this._cursor = token;
    this._persistCursor();
    if (this._accountId) {
      this.emit("stream:cursor_advanced", { accountId: this._accountId, cursor: token });
    }
    this._handler?.(record);
  }

  private _isStale(record: T): boolean {
    if (typeof record.created_at !== "string") return false;
    const createdAtMs = Date.parse(record.created_at);
    if (Number.isNaN(createdAtMs)) return false;
    return this._now() - createdAtMs > this._replayCutoffMs;
  }

  private _remember(token: string): void {
    this._seenSet.add(token);
    this._seenTokens.push(token);
    if (this._seenTokens.length > this._dedupeBufferSize) {
      const evicted = this._seenTokens.shift();
      if (evicted !== undefined) this._seenSet.delete(evicted);
    }
  }

  private _persistCursor(): void {
    if (!this._accountId || this._cursor === null) return;
    this._cursorStore.set(this._cursorKey(this._accountId), this._cursor);
  }

  private _onError(event: unknown): void {
    if (this._stopped || !this._accountId) return;
    this._closeStream?.();
    this._closeStream = null;
    this.emit("stream:lag", { accountId: this._accountId, error: event });

    this._reconnectAttempts += 1;
    if (this._reconnectAttempts > this._maxReconnectAttempts) {
      this.emit("stream:reconnect_failed", {
        accountId: this._accountId,
        attempts: this._reconnectAttempts,
      });
      return;
    }

    const delayMs = Math.min(
      this._reconnectDelayMs * Math.pow(2, this._reconnectAttempts - 1),
      MAX_RECONNECT_DELAY_MS,
    );
    this.emit("stream:reconnecting", {
      accountId: this._accountId,
      attempt: this._reconnectAttempts,
      delayMs,
    });
    this._reconnectTimer = setTimeout(() => {
      this._reconnectTimer = null;
      this._connect(true);
    }, delayMs);
  }
}
