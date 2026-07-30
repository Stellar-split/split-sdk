/**
 * Fee surge detector — monitors real-time ledger fee statistics via Horizon
 * and automatically recommends an adjusted fee multiplier during network
 * congestion so transactions don't fail with hard-coded fee values.
 *
 * Extends {@link src/feeEstimator.ts} and {@link src/fee.ts} with surge-aware
 * behaviour.
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
   * `baseFee * surgeMultiplier`, the network is considered congested.
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
// Implementation
// ---------------------------------------------------------------------------

const DEFAULT_BASE_FEE = 100n; // 100 stroops

let cachedRecommendation: FeeRecommendation | null = null;
let cacheExpiry = 0;

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
  const baseFee = DEFAULT_BASE_FEE;

  try {
    const server = new Horizon.Server(horizonUrl);
    const feeStats = await server.feeStats();

    const observedFee = feePercentileToBigInt(feeStats, percentile);
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
      fee: baseFee,
      baseFee,
      observedFee: baseFee,
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
