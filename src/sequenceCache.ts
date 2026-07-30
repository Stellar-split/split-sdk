/**
 * Sequence-number cache that prefetches account sequence numbers from Horizon,
 * increments them locally on each call, and re-fetches only when the cached
 * value goes stale (detected via SEQUENCE_NUMBER_TOO_OLD submission errors).
 *
 * Integrates with {@link SimpleCache} for TTL-based eviction of stale entries.
 */

import { Horizon } from "@stellar/stellar-sdk";
import { SimpleCache } from "./cache.js";
import { SequenceCacheError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Per-account cached sequence state. */
interface SequenceEntry {
  /** The last-known on-chain sequence number (as a bigint). */
  base: bigint;
  /** How many local increments have been applied on top of `base`. */
  offset: number;
  /** Unix-ms timestamp when the entry was last refreshed from Horizon. */
  fetchedAt: number;
}

/** Configuration for {@link SequenceCache}. */
export interface SequenceCacheConfig {
  /** TTL in milliseconds before a cached entry is considered stale. Default: 30_000 (30s). */
  ttlMs?: number;
  /** Maximum number of accounts to cache concurrently. Default: 10_000. */
  maxEntries?: number;
}

// ---------------------------------------------------------------------------
// SequenceCache
// ---------------------------------------------------------------------------

/**
 * Caches per-account sequence numbers retrieved from Horizon.
 *
 * On every {@link getSequence} call the cache returns the next sequence number
 * by incrementing a local counter, avoiding a Horizon round-trip.  When a
 * `SEQUENCE_NUMBER_TOO_OLD` submission error is detected the caller should
 * invoke {@link invalidate} so the next call re-fetches the true on-chain
 * value.
 */
export class SequenceCache {
  private readonly server: Horizon.Server;
  private readonly entries: SimpleCache<SequenceEntry>;
  private readonly ttlMs: number;

  /**
   * @param horizonUrl - Horizon server URL (e.g. `"https://horizon.stellar.org"`).
   * @param config     - Optional tuning parameters.
   */
  constructor(horizonUrl: string, config: SequenceCacheConfig = {}) {
    this.server = new Horizon.Server(horizonUrl);
    this.ttlMs = config.ttlMs ?? 30_000;
    this.entries = new SimpleCache<SequenceEntry>({
      enabled: true,
      ttlMs: this.ttlMs,
      maxEntries: config.maxEntries ?? 10_000,
    });
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Return the **next** sequence number for `accountId`, incrementing the
   * local counter.  The first call for a given account triggers a Horizon
   * fetch; subsequent calls only touch the in-memory counter.
   *
   * When the cached entry TTL has expired the method automatically re-fetches
   * from Horizon before returning.
   *
   * @throws {@link SequenceCacheError} when the Horizon fetch fails.
   */
  async getSequence(accountId: string): Promise<bigint> {
    let entry = this.entries.get(`seq:${accountId}`);

    if (!entry) {
      entry = await this.fetchAndCache(accountId);
    }

    // Advance local counter
    const nextSeq = entry.base + BigInt(entry.offset);
    entry.offset += 1;
    this.entries.set(`seq:${accountId}`, entry);

    return nextSeq;
  }

  /**
   * Peek at the next sequence number that would be returned by
   * {@link getSequence} **without** incrementing the local counter.
   *
   * Returns `undefined` when the account hasn't been cached yet.
   */
  peekSequence(accountId: string): bigint | undefined {
    const entry = this.entries.get(`seq:${accountId}`);
    if (!entry) return undefined;
    return entry.base + BigInt(entry.offset);
  }

  /**
   * Force a re-fetch of the on-chain sequence number for `accountId`.
   * Call this after detecting a `SEQUENCE_NUMBER_TOO_OLD` submission error.
   */
  async invalidate(accountId: string): Promise<void> {
    this.entries.invalidate(`seq:${accountId}`);
    // Pre-warm: fetch fresh value immediately so the next getSequence is fast
    await this.fetchAndCache(accountId);
  }

  /**
   * Return the underlying Horizon server instance so callers can use it
   * for other queries (e.g. account detail).
   */
  getServer(): Horizon.Server {
    return this.server;
  }

  /**
   * Remove all cached entries.
   */
  clear(): void {
    this.entries.clear();
  }

  /**
   * Number of accounts currently tracked in the cache.
   */
  get size(): number {
    return this.entries.getStats().size;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Fetch the current on-chain sequence number and cache it with offset 0.
   */
  private async fetchAndCache(accountId: string): Promise<SequenceEntry> {
    try {
      const account = await this.server.loadAccount(accountId);
      const base = BigInt(account.sequenceNumber());
      const entry: SequenceEntry = { base, offset: 1, fetchedAt: Date.now() };
      this.entries.set(`seq:${accountId}`, entry);
      return entry;
    } catch (err) {
      throw new SequenceCacheError(
        `Failed to fetch sequence for ${accountId}: ${err instanceof Error ? err.message : String(err)}`,
        accountId,
      );
    }
  }
}

/**
 * Type-guard: returns `true` when `error` looks like a Horizon
 * `SEQUENCE_NUMBER_TOO_OLD` submission result.
 *
 * Inspects error messages / result codes from the Stellar SDK.
 */
export function isSequenceTooOld(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error);
  const lower = msg.toLowerCase();
  return (
    lower.includes("sequence_number_too_old") ||
    lower.includes("tx_bad_seq") ||
    lower.includes("bad sequence")
  );
}
