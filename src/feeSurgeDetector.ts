/**
 * Fee surge detector — monitors real-time ledger fee statistics via Horizon
 * and automatically recommends an adjusted fee multiplier during network
 * congestion so transactions don't fail with hard-coded fee values.
 *
 * Extends {@link src/feeEstimator.ts} and {@link src/fee.ts} with surge-aware
 * behaviour.
 *
 * ## Moving-average baseline (#690)
 *
 * Instead of comparing the observed fee against a hard-coded static baseline,
 * the detector maintains a **sliding window** of the last N fee samples
 * (configurable via `windowSize`, default 20). The moving average of the
 * window becomes the dynamic baseline used for surge detection.
 *
 * When the window is not yet full (i.e. fewer than `windowSize` samples have
 * been collected), the static baseline (`DEFAULT_BASE_FEE = 100n stroops`) is
 * used as a fallback so the detector is immediately useful on first run.
 */

import { rpc as SorobanRpc, Horizon } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Configuration for the fee surge detector.
 */
export interface FeeSurgeConfig {
  /**
   * Fee percentile to track as the "current" network fee.
   *
   * - `"p10"` — conservative (lowest fee that 90 % of ledgers accept).
   * - `"p50"` — median fee.
   * - `"p95"` — aggressive (only 5 % of ledgers require a higher fee).
   *
   * Defaults to `"p50"`.
   */
  percentile?: "p10" | "p50" | "p95";

  /**
   * Congestion threshold multiplier. When the observed fee exceeds
   * `baseline * surgeMultiplier`, the network is considered congested.
   * Defaults to `2`.
   */
  surgeMultiplier?: number;

  /**
   * Recommended fee multiplier applied during surge. Defaults to `1.5`
   * (i.e. pay 50 % more than the observed percentile fee during surge).
   */
  surgeFeeMultiplier?: number;

  /**
   * How long a surge recommendation is cached (ms). Defaults to 30_000.
   */
  cacheTtlMs?: number;

  /**
   * Maximum fee in stroops the surge detector will ever recommend. Acts as
   * a safety ceiling. Defaults to 10_000_000 (10 XLM).
   */
  maxFeeStroops?: number;

  /**
   * Number of recent fee samples kept in the sliding window used to compute
   * the moving-average baseline. When the window has fewer than `windowSize`
   * samples, the static `DEFAULT_BASE_FEE` is used as a fallback.
   *
   * Defaults to `20`.
   */
  windowSize?: number;
}

/** Congestion level derived from fee statistics. */
export type CongestionLevel = "low" | "medium" | "high";

/**
 * A fee recommendation produced by the surge detector.
 */
export interface FeeRecommendation {
  /** Recommended fee in stroops. */
  fee: bigint;
  /** The base fee used as reference (in stroops). */
  baseFee: bigint;
  /** The observed fee-percentile value (in stroops). */
  observedFee: bigint;
  /** Current congestion level. */
  congestion: CongestionLevel;
  /** Whether surge pricing is active. */
  surgeActive: boolean;
  /** Multiplier applied to the base fee. */
  multiplier: number;
  /** Unix timestamp (ms) when this recommendation was produced. */
  timestamp: number;
}

// ---------------------------------------------------------------------------
// Moving-average window state (module-level for the free-standing function)
// ---------------------------------------------------------------------------

const DEFAULT_BASE_FEE = 100n; // 100 stroops
const DEFAULT_WINDOW_SIZE = 20;

/** Circular buffer of recent fee samples (in stroops, as numbers for averaging). */
const _feeSamples: number[] = [];
let _windowSize = DEFAULT_WINDOW_SIZE;

let cachedRecommendation: FeeRecommendation | null = null;
let cacheExpiry = 0;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Add a new fee sample to the sliding window. Evicts the oldest sample when
 * the window is full.
 *
 * @internal
 */
function addFeeSample(fee: bigint, windowSize: number): void {
  // Update window size if it changed between calls
  _windowSize = windowSize;
  _feeSamples.push(Number(fee));
  if (_feeSamples.length > _windowSize) {
    _feeSamples.shift();
  }
}

/**
 * Compute the moving-average baseline from the current window.
 *
 * Returns `null` when the window is not yet full (so callers can fall back to
 * the static baseline).
 *
 * @internal
 */
function movingAverageBaseline(windowSize: number): bigint | null {
  if (_feeSamples.length < windowSize) {
    // Window not yet full — use static fallback
    return null;
  }
  const sum = _feeSamples.reduce((acc, v) => acc + v, 0);
  return BigInt(Math.ceil(sum / _feeSamples.length));
}

/**
 * Fetch the current fee statistics from Horizon and produce a surge-aware
 * fee recommendation.
 *
 * Uses {@link Horizon.Server.feeStats} which returns a {@link Horizon.FeeStatsResponse}
 * with `p10`, `p50`, `p95` fee percentiles.
 *
 * @param horizonUrl - Horizon server URL (e.g. "https://horizon.stellar.org").
 * @param config     - Optional surge detector configuration.
 * @returns A fee recommendation with congestion level and surge-adjusted fee.
 */
export async function detectFeeSurge(
  horizonUrl: string,
  config?: FeeSurgeConfig,
): Promise<FeeRecommendation> {
  const now = Date.now();
  const ttl = config?.cacheTtlMs ?? 30_000;

  // Return cached result if still fresh.
  if (cachedRecommendation && now < cacheExpiry) {
    return cachedRecommendation;
  }

  const percentile = config?.percentile ?? "p50";
  const surgeMultiplier = config?.surgeMultiplier ?? 2;
  const surgeFeeMultiplier = config?.surgeFeeMultiplier ?? 1.5;
  const maxFee = BigInt(config?.maxFeeStroops ?? 10_000_000);
  const windowSize = config?.windowSize ?? DEFAULT_WINDOW_SIZE;

  try {
    const server = new Horizon.Server(horizonUrl);
    const feeStats = await server.feeStats();

    const observedFee = feePercentileToBigInt(feeStats, percentile);

    // ── Moving-average baseline ────────────────────────────────────────────
    // Add the observed fee to the sliding window and derive the baseline.
    // Falls back to the static DEFAULT_BASE_FEE until the window is full.
    addFeeSample(observedFee, windowSize);
    const maBaseline = movingAverageBaseline(windowSize);
    const baseFee = maBaseline ?? DEFAULT_BASE_FEE;

    const surgeActive = observedFee > baseFee * BigInt(Math.ceil(surgeMultiplier));

    let congestion: CongestionLevel;
    if (observedFee <= baseFee * 2n) {
      congestion = "low";
    } else if (observedFee <= baseFee * 10n) {
      congestion = "medium";
    } else {
      congestion = "high";
    }

    let recommendedFee: bigint;
    let multiplier: number;

    if (surgeActive) {
      recommendedFee = BigInt(
        Math.ceil(Number(observedFee) * surgeFeeMultiplier),
      );
      multiplier = surgeFeeMultiplier;
    } else {
      recommendedFee = observedFee;
      multiplier = 1.0;
    }

    // Apply safety ceiling
    if (recommendedFee > maxFee) {
      recommendedFee = maxFee;
    }

    const recommendation: FeeRecommendation = {
      fee: recommendedFee,
      baseFee,
      observedFee,
      congestion,
      surgeActive,
      multiplier,
      timestamp: now,
    };

    // Cache the result
    cachedRecommendation = recommendation;
    cacheExpiry = now + ttl;

    return recommendation;
  } catch {
    // On failure, return a safe default (base fee with low congestion).
    return {
      fee: DEFAULT_BASE_FEE,
      baseFee: DEFAULT_BASE_FEE,
      observedFee: DEFAULT_BASE_FEE,
      congestion: "low",
      surgeActive: false,
      multiplier: 1.0,
      timestamp: now,
    };
  }
}

/**
 * Clear the internal fee recommendation cache so the next call to
 * {@link detectFeeSurge} fetches fresh data.
 */
export function clearFeeSurgeCache(): void {
  cachedRecommendation = null;
  cacheExpiry = 0;
}

/**
 * Reset the moving-average window (clears all accumulated samples).
 *
 * Useful in tests or when resetting detector state entirely.
 */
export function resetFeeSurgeWindow(): void {
  _feeSamples.length = 0;
  _windowSize = DEFAULT_WINDOW_SIZE;
}

/**
 * Return a read-only snapshot of the current fee sample window.
 *
 * Intended for debugging and unit testing.
 */
export function getFeeSampleWindow(): readonly number[] {
  return [..._feeSamples];
}

/**
 * Extract a fee percentile from the Horizon fee stats response as a bigint
 * (in stroops).
 */
function feePercentileToBigInt(
  stats: any,
  percentile: "p10" | "p50" | "p95",
): bigint {
  const raw =
    percentile === "p10"
      ? stats.feeCharged.p10
      : percentile === "p50"
        ? stats.feeCharged.p50
        : stats.feeCharged.p95;

  if (raw === undefined || raw === null) return DEFAULT_BASE_FEE;
  // Horizon returns fee values in stroops already. Ceil to the nearest
  // integer to avoid floating-point precision issues.
  return BigInt(Math.ceil(Number(raw)));
}
