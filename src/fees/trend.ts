/**
 * Transaction fee history trend analyzer for StellarSplit.
 *
 * Polls Horizon's `/fee_stats` endpoint on a rolling basis and computes
 * percentile estimates over a sliding window, so callers can request a
 * recommended base fee for a chosen acceptance percentile instead of
 * guessing during network congestion.
 */

import { Horizon } from "@stellar/stellar-sdk";
import { CircularBuffer } from "../utils/circularBuffer.js";
import { percentile } from "../utils/stats.js";
import type { FeeTrendOptions } from "../types.js";

/** Acceptance-percentile targets supported by {@link FeeTrendAnalyzer.recommendedFee}. */
export type FeePercentile = 50 | 75 | 95 | 99;

const MIN_WINDOW_SIZE = 5;
const MAX_WINDOW_SIZE = 100;
const DEFAULT_WINDOW_SIZE = 20;
const DEFAULT_TTL_MS = 5 * 60 * 1000;

const brand: unique symbol = Symbol("WindowCapacity");

/** Branded integer type: a window size validated to `[5, 100]` at construction time. */
export type WindowCapacity = number & { readonly [brand]: true };

/** Validates and brands a raw window size. */
function toWindowCapacity(size: number): WindowCapacity {
  if (!Number.isInteger(size) || size < MIN_WINDOW_SIZE || size > MAX_WINDOW_SIZE) {
    throw new RangeError(
      `windowSize must be an integer between ${MIN_WINDOW_SIZE} and ${MAX_WINDOW_SIZE}, got ${size}`
    );
  }
  return size as WindowCapacity;
}

/** A single fee snapshot captured from Horizon's `/fee_stats` endpoint. */
interface FeeSample {
  /** Representative fee charged (stroops) for the most recently closed ledger. */
  value: number;
  /** Time the sample was captured, used for TTL-based eviction. */
  capturedAt: number;
}

/**
 * Tracks a rolling window of Horizon fee_stats snapshots and recommends a
 * base fee at a caller-specified acceptance percentile.
 *
 * @example
 * ```typescript
 * const analyzer = new FeeTrendAnalyzer({ horizonUrl: "https://horizon.stellar.org" });
 * await analyzer.sample();
 * const fee = analyzer.recommendedFee(95); // stroops
 * ```
 */
export class FeeTrendAnalyzer {
  private readonly server: Horizon.Server;
  private readonly buffer: CircularBuffer<FeeSample>;
  private readonly ttlMs: number;

  constructor(options: FeeTrendOptions) {
    const windowSize = toWindowCapacity(options.windowSize ?? DEFAULT_WINDOW_SIZE);
    this.buffer = new CircularBuffer<FeeSample>(windowSize);
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.server = new Horizon.Server(options.horizonUrl);
  }

  /**
   * Fetches the current fee stats snapshot from Horizon and appends it to
   * the rolling window, evicting the oldest entry once at capacity.
   */
  async sample(): Promise<void> {
    const stats = await this.server.feeStats();
    const value = Number(stats.fee_charged.mode);
    this.buffer.push({ value, capturedAt: Date.now() });
  }

  /**
   * Returns the recommended fee, in stroops, at `percentileTarget` across
   * all samples currently in the window. Samples older than the
   * configured TTL are evicted before the computation runs.
   */
  recommendedFee(percentileTarget: FeePercentile): number {
    this.evictExpired();

    const values = this.buffer.toArray().map((sample) => sample.value);
    if (values.length === 0) {
      throw new RangeError("No fee samples available; call sample() before recommendedFee()");
    }

    return Math.ceil(percentile(values, percentileTarget));
  }

  /** Number of non-expired samples currently held in the window. */
  get sampleCount(): number {
    this.evictExpired();
    return this.buffer.size;
  }

  private evictExpired(): void {
    const cutoff = Date.now() - this.ttlMs;
    this.buffer.evictOldestWhile((sample) => sample.capturedAt < cutoff);
  }
}

/**
 * Compute a Simple Moving Average (SMA) series for an array of numbers.
 *
 * The first `windowSize - 1` entries are padded with `NaN` because a full
 * window is not yet available. All calculations are pure: no side effects,
 * no input mutation.
 *
 * @param samples    - Raw numeric series (e.g. fee samples over time).
 * @param windowSize - Number of consecutive elements to average. Must be ≥ 1.
 * @returns An array of the same length where each element `i` is the SMA of
 *   `samples.slice(i - windowSize + 1, i + 1)` when `i >= windowSize - 1`,
 *   otherwise `NaN`.
 * @throws {RangeError} When `windowSize` is less than 1.
 */
export function computeMovingAverage(samples: number[], windowSize: number): number[] {
  if (windowSize < 1) {
    throw new RangeError(`windowSize must be at least 1, got ${windowSize}`);
  }
  if (samples.length === 0) return [];

  const result: number[] = new Array(samples.length).fill(NaN);
  let windowSum = 0;

  for (let i = 0; i < samples.length; i++) {
    windowSum += samples[i]!;
    if (i >= windowSize) {
      windowSum -= samples[i - windowSize]!;
    }
    if (i >= windowSize - 1) {
      result[i] = windowSum / windowSize;
    }
  }

  return result;
}
