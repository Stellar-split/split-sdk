/**
 * Paging-token-based deduplicator for Horizon SSE / stream consumers.
 *
 * Horizon streams occasionally redeliver the same event (reconnects, Horizon
 * restarts). This maintains a fixed-size circular buffer of recently seen
 * paging tokens and discards records whose token has already been processed,
 * persisting the token set periodically so restarts don't reprocess events.
 */

import { TypedEventEmitter } from "./events/TypedEventEmitter.js";
import { saveDedupTokens, loadDedupTokens } from "./snapshot.js";

/** Events emitted by {@link StreamDeduplicator}. */
export interface StreamDeduplicatorEventMap {
  [key: string]: unknown;
  duplicateEventDiscarded: { pagingToken: string };
}

/** Configuration for {@link StreamDeduplicator}. */
export interface StreamDeduplicatorOptions {
  /** Maximum number of paging tokens retained. Oldest tokens are evicted first. Default: 1000. */
  windowSize?: number;
  /** Persist the token set after this many newly seen tokens. Default: 100. */
  flushIntervalTokens?: number;
  /** Namespace used to key persisted state. Default: "default". */
  namespace?: string;
}

const DEFAULT_WINDOW_SIZE = 1000;
const DEFAULT_FLUSH_INTERVAL_TOKENS = 100;

/**
 * Discards duplicate stream records by paging token using a fixed-size
 * circular buffer, with periodic persistence for restart survival.
 */
export class StreamDeduplicator extends TypedEventEmitter<StreamDeduplicatorEventMap> {
  private readonly windowSize: number;
  private readonly flushIntervalTokens: number;
  private readonly namespace: string;

  private readonly seen = new Set<string>();
  private readonly buffer: string[] = [];
  private writeIndex = 0;
  private newTokensSinceFlush = 0;

  constructor(options: StreamDeduplicatorOptions = {}) {
    super();
    this.windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
    this.flushIntervalTokens = options.flushIntervalTokens ?? DEFAULT_FLUSH_INTERVAL_TOKENS;
    this.namespace = options.namespace ?? "default";
  }

  /**
   * Load the previously persisted token set for this deduplicator's
   * namespace. Call once at startup, before processing any new events.
   */
  async restore(): Promise<void> {
    const tokens = await loadDedupTokens(this.namespace);
    if (!tokens) return;

    for (const token of tokens.slice(-this.windowSize)) {
      if (this.seen.has(token)) continue;
      this.seen.add(token);
      this.buffer.push(token);
    }
    this.writeIndex = this.buffer.length % this.windowSize;
  }

  /**
   * Returns `false` when `record.paging_token` has already been seen within
   * the current window (i.e. it is a duplicate and should be discarded).
   * Returns `true` (and records the token) otherwise.
   */
  filter<T extends { paging_token: string }>(record: T): boolean {
    const token = record.paging_token;

    if (this.seen.has(token)) {
      this.emit("duplicateEventDiscarded", { pagingToken: token });
      return false;
    }

    this.record(token);
    return true;
  }

  /** Number of tokens currently tracked. */
  get size(): number {
    return this.seen.size;
  }

  private record(token: string): void {
    if (this.buffer.length >= this.windowSize) {
      const evicted = this.buffer[this.writeIndex];
      if (evicted !== undefined) this.seen.delete(evicted);
      this.buffer[this.writeIndex] = token;
    } else {
      this.buffer.push(token);
    }
    this.writeIndex = (this.writeIndex + 1) % this.windowSize;
    this.seen.add(token);

    this.newTokensSinceFlush++;
    if (this.newTokensSinceFlush >= this.flushIntervalTokens) {
      this.newTokensSinceFlush = 0;
      void saveDedupTokens(this.namespace, [...this.buffer]);
    }
  }
}
