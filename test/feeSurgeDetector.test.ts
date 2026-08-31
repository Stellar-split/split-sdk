/**
 * Unit tests for feeSurgeDetector.ts – moving-average baseline (#690).
 *
 * These tests verify that:
 *  1. The detector maintains a sliding window of the last N fee samples.
 *  2. The moving average of the window is used as the baseline for surge detection.
 *  3. When the window is not yet full, the static baseline (100 stroops) is used.
 *  4. The surge multiplier threshold remains configurable.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  detectFeeSurge,
  clearFeeSurgeCache,
  resetFeeSurgeWindow,
  getFeeSampleWindow,
} from "../src/feeSurgeDetector.js";
import type { FeeSurgeConfig } from "../src/feeSurgeDetector.js";
import { Horizon } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HORIZON_URL = "https://horizon-testnet.stellar.org";

/** Build a minimal Horizon fee-stats response. */
function makeFeeStats(p50: number) {
  return {
    feeCharged: { p10: String(Math.round(p50 * 0.8)), p50: String(p50), p95: String(Math.round(p50 * 1.5)) },
    maxFee: { p10: "100", p50: "200", p95: "500" },
    ledgerCapacityUsage: "0.5",
  };
}

/** Replace Horizon.Server.feeStats with a stub that returns the given p50 fee. */
function stubFeeStats(p50: number) {
  return vi
    .spyOn(Horizon.Server.prototype, "feeStats")
    .mockResolvedValue(makeFeeStats(p50) as any);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("feeSurgeDetector – moving-average baseline (#690)", () => {
  beforeEach(() => {
    // Reset module-level state before each test
    clearFeeSurgeCache();
    resetFeeSurgeWindow();
    vi.restoreAllMocks();
  });

  // ── Window not yet full → static fallback ─────────────────────────────────

  it("uses the static baseline (100 stroops) when the window is not yet full", async () => {
    // Only one sample in a window of 20 → should use fallback
    stubFeeStats(150);

    const result = await detectFeeSurge(HORIZON_URL, { windowSize: 20 });

    // baseFee should be the static 100n because window is not full
    expect(result.baseFee).toBe(100n);
    expect(result.observedFee).toBe(150n);
  });

  // ── Window full → moving average used as baseline ─────────────────────────

  it("uses the moving average as baseline once the window is full", async () => {
    const windowSize = 3;

    // Fill the window with 3 samples by calling detectFeeSurge 3 times,
    // each time clearing the cache but NOT the window.
    for (const fee of [200, 300, 400]) {
      stubFeeStats(fee);
      clearFeeSurgeCache();
      await detectFeeSurge(HORIZON_URL, { windowSize });
    }

    // Window should now hold [200, 300, 400]; moving average = 300
    expect(getFeeSampleWindow()).toEqual([200, 300, 400]);

    // Next call: observed fee = 200, moving-average baseline = 300
    stubFeeStats(200);
    clearFeeSurgeCache();
    const result = await detectFeeSurge(HORIZON_URL, { windowSize });

    // baseFee should be the moving average of the full window [300, 400, 200] = 300
    // (window slides: oldest 200 evicted, 200 appended → [300, 400, 200])
    expect(result.baseFee).toBe(300n);
  });

  // ── Sliding window evicts oldest sample ──────────────────────────────────

  it("maintains a sliding window that evicts the oldest sample when full", async () => {
    const windowSize = 3;

    for (const fee of [100, 200, 300]) {
      stubFeeStats(fee);
      clearFeeSurgeCache();
      await detectFeeSurge(HORIZON_URL, { windowSize });
    }
    expect(getFeeSampleWindow()).toEqual([100, 200, 300]);

    // Adding a 4th sample (400) should evict the first (100)
    stubFeeStats(400);
    clearFeeSurgeCache();
    await detectFeeSurge(HORIZON_URL, { windowSize });

    expect(getFeeSampleWindow()).toEqual([200, 300, 400]);
  });

  // ── Surge detection uses moving-average baseline ──────────────────────────

  it("marks surgeActive when observed fee exceeds moving-average baseline × surgeMultiplier", async () => {
    const windowSize = 3;
    const surgeMultiplier = 2;

    // Fill window with low fees → moving-average baseline = 100
    for (const fee of [100, 100, 100]) {
      stubFeeStats(fee);
      clearFeeSurgeCache();
      await detectFeeSurge(HORIZON_URL, { windowSize, surgeMultiplier });
    }

    // Now spike the fee: 100 * 2 = 200 threshold, so 201 should trigger surge
    stubFeeStats(201);
    clearFeeSurgeCache();
    const result = await detectFeeSurge(HORIZON_URL, { windowSize, surgeMultiplier });

    expect(result.surgeActive).toBe(true);
    expect(result.congestion).not.toBe("low");
  });

  it("does NOT mark surgeActive when observed fee is within the moving-average baseline", async () => {
    const windowSize = 3;
    const surgeMultiplier = 2;

    // Fill window with low fees → moving-average baseline = 100
    for (const fee of [100, 100, 100]) {
      stubFeeStats(fee);
      clearFeeSurgeCache();
      await detectFeeSurge(HORIZON_URL, { windowSize, surgeMultiplier });
    }

    // Fee of 150 is below 100 * 2 = 200 → no surge
    stubFeeStats(150);
    clearFeeSurgeCache();
    const result = await detectFeeSurge(HORIZON_URL, { windowSize, surgeMultiplier });

    expect(result.surgeActive).toBe(false);
  });

  // ── surgeMultiplier remains configurable ─────────────────────────────────

  it("respects a custom surgeMultiplier when determining surge status", async () => {
    const windowSize = 3;

    // Fill window → moving-average baseline = 100
    for (const fee of [100, 100, 100]) {
      stubFeeStats(fee);
      clearFeeSurgeCache();
      await detectFeeSurge(HORIZON_URL, { windowSize, surgeMultiplier: 5 });
    }

    // With surgeMultiplier=5, threshold = 100*5 = 500.  Fee of 300 < 500 → no surge.
    stubFeeStats(300);
    clearFeeSurgeCache();
    const result = await detectFeeSurge(HORIZON_URL, { windowSize, surgeMultiplier: 5 });

    expect(result.surgeActive).toBe(false);
    expect(result.multiplier).toBe(1.0);
  });

  // ── Default window size ───────────────────────────────────────────────────

  it("defaults to a window size of 20", async () => {
    // Confirm the window has fewer than 20 entries initially → fallback used
    stubFeeStats(200);
    const result = await detectFeeSurge(HORIZON_URL);

    // Window not yet full (1 of 20) → static baseline
    expect(result.baseFee).toBe(100n);
    expect(getFeeSampleWindow()).toHaveLength(1);
  });

  // ── resetFeeSurgeWindow ───────────────────────────────────────────────────

  it("resetFeeSurgeWindow clears all accumulated samples", async () => {
    const windowSize = 3;

    for (const fee of [100, 200, 300]) {
      stubFeeStats(fee);
      clearFeeSurgeCache();
      await detectFeeSurge(HORIZON_URL, { windowSize });
    }
    expect(getFeeSampleWindow()).toHaveLength(3);

    resetFeeSurgeWindow();
    expect(getFeeSampleWindow()).toHaveLength(0);

    // After reset, window is empty → static baseline fallback
    stubFeeStats(500);
    clearFeeSurgeCache();
    const result = await detectFeeSurge(HORIZON_URL, { windowSize });
    expect(result.baseFee).toBe(100n);
  });
});
