import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { LedgerCloseEstimator } from "../src/ledgerCloseEstimator.js";
import { DeadlineEngine } from "../src/deadlineEngine.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a fake Horizon.Server stub that returns `records` from `.ledgers()`.
 */
function makeFakeHorizon(records: Array<{ sequence: number; closed_at: string }>) {
  return {
    ledgers: vi.fn().mockReturnValue({
      order: vi.fn().mockReturnThis(),
      limit: vi.fn().mockReturnThis(),
      call: vi.fn().mockResolvedValue({ records }),
    }),
  };
}

/**
 * Build a series of `count` ledger records starting at `baseSequence`,
 * each separated by `intervalMs` milliseconds starting from `baseTimeMs`.
 */
function buildLedgerRecords(
  count: number,
  baseSequence: number,
  baseTimeMs: number,
  intervalMs: number,
): Array<{ sequence: number; closed_at: string }> {
  return Array.from({ length: count }, (_, i) => ({
    sequence: baseSequence + i,
    closed_at: new Date(baseTimeMs + i * intervalMs).toISOString(),
  }));
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("LedgerCloseEstimator", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  describe("calibrate()", () => {
    it("computes the correct rolling-average interval from uniform records", async () => {
      const INTERVAL_MS = 5_000;
      const BASE_SEQ = 1_000_000;
      const BASE_TIME = new Date("2025-01-01T00:00:00Z").getTime();
      const records = buildLedgerRecords(20, BASE_SEQ, BASE_TIME, INTERVAL_MS);

      const estimator = new LedgerCloseEstimator({
        horizonUrl: "https://horizon-testnet.stellar.org",
        calibrationIntervalMs: 0, // disable auto-timer for tests
      });

      // Patch _fetchLedgers to return our fake records (sorted desc as Horizon would)
      const fetchSpy = vi
        .spyOn(estimator as any, "_fetchLedgers")
        .mockResolvedValue([...records].reverse());

      await estimator.calibrate(20);

      expect(fetchSpy).toHaveBeenCalledWith(20);
      expect(estimator.state).not.toBeNull();
      expect(estimator.avgIntervalMs).toBeCloseTo(INTERVAL_MS, 0);

      estimator.destroy();
    });

    it("computes correct average when intervals vary", async () => {
      // Intervals: 4s, 6s, 5s, 5s → avg = 5s
      const BASE_SEQ = 500_000;
      const BASE_TIME = new Date("2025-06-01T12:00:00Z").getTime();
      const records = [
        { sequence: BASE_SEQ,     closed_at: new Date(BASE_TIME).toISOString() },
        { sequence: BASE_SEQ + 1, closed_at: new Date(BASE_TIME + 4_000).toISOString() },
        { sequence: BASE_SEQ + 2, closed_at: new Date(BASE_TIME + 10_000).toISOString() },
        { sequence: BASE_SEQ + 3, closed_at: new Date(BASE_TIME + 15_000).toISOString() },
        { sequence: BASE_SEQ + 4, closed_at: new Date(BASE_TIME + 20_000).toISOString() },
      ];

      const estimator = new LedgerCloseEstimator({
        horizonUrl: "https://horizon-testnet.stellar.org",
        calibrationIntervalMs: 0,
      });

      vi.spyOn(estimator as any, "_fetchLedgers").mockResolvedValue(records);

      await estimator.calibrate(5);

      // deltas: 4000, 6000, 5000, 5000 → avg = 5000
      expect(estimator.avgIntervalMs).toBeCloseTo(5_000, 0);

      estimator.destroy();
    });

    it("uses default sampleSize of 20 when none is provided", async () => {
      const estimator = new LedgerCloseEstimator({
        horizonUrl: "https://horizon-testnet.stellar.org",
        calibrationIntervalMs: 0,
      });

      const fetchSpy = vi
        .spyOn(estimator as any, "_fetchLedgers")
        .mockResolvedValue(buildLedgerRecords(20, 1_000, Date.now(), 5_000));

      await estimator.calibrate(); // no arg → default 20

      expect(fetchSpy).toHaveBeenCalledWith(20);

      estimator.destroy();
    });

    it("does not throw when fewer than 2 records are returned", async () => {
      const estimator = new LedgerCloseEstimator({
        horizonUrl: "https://horizon-testnet.stellar.org",
        calibrationIntervalMs: 0,
      });

      vi.spyOn(estimator as any, "_fetchLedgers").mockResolvedValue([
        { sequence: 100, closed_at: new Date().toISOString() },
      ]);

      await expect(estimator.calibrate()).resolves.toBeUndefined();
      expect(estimator.state).toBeNull();

      estimator.destroy();
    });
  });

  describe("estimateCloseTime()", () => {
    it("projects the correct future close time given a known interval", async () => {
      const INTERVAL_MS = 5_000;
      const BASE_SEQ = 2_000_000;
      const BASE_TIME = new Date("2025-01-01T00:00:00Z").getTime();

      const estimator = new LedgerCloseEstimator({
        horizonUrl: "https://horizon-testnet.stellar.org",
        calibrationIntervalMs: 0,
      });

      vi.spyOn(estimator as any, "_fetchLedgers").mockResolvedValue(
        buildLedgerRecords(20, BASE_SEQ, BASE_TIME, INTERVAL_MS),
      );

      await estimator.calibrate(20);

      const state = estimator.state!;
      // 10 ledgers ahead of the latest → 50 s later
      const target = state.latestSequence + 10;
      const estimated = estimator.estimateCloseTime(target);

      expect(estimated.getTime()).toBeCloseTo(
        state.latestClosedAtMs + 10 * INTERVAL_MS,
        -2, // within 100ms
      );

      estimator.destroy();
    });

    it("uses FALLBACK_INTERVAL_MS when not calibrated", () => {
      const estimator = new LedgerCloseEstimator({
        horizonUrl: "https://horizon-testnet.stellar.org",
        calibrationIntervalMs: 0,
      });

      // spy to stabilize guessCurrentLedger
      const currentLedger = 1_000_000;
      vi.spyOn(estimator as any, "_guessCurrentLedger").mockReturnValue(
        currentLedger,
      );

      const futureTime = estimator.estimateCloseTime(currentLedger + 10);
      const expectedMs = Date.now() + 10 * LedgerCloseEstimator.FALLBACK_INTERVAL_MS;

      expect(futureTime.getTime()).toBeCloseTo(expectedMs, -2);

      estimator.destroy();
    });

    it("returns a past time when targetLedger < latestSequence", async () => {
      const INTERVAL_MS = 5_000;
      const BASE_SEQ = 3_000_000;
      const BASE_TIME = new Date("2025-03-01T00:00:00Z").getTime();

      const estimator = new LedgerCloseEstimator({
        horizonUrl: "https://horizon-testnet.stellar.org",
        calibrationIntervalMs: 0,
      });

      vi.spyOn(estimator as any, "_fetchLedgers").mockResolvedValue(
        buildLedgerRecords(20, BASE_SEQ, BASE_TIME, INTERVAL_MS),
      );

      await estimator.calibrate(20);

      const state = estimator.state!;
      const pastLedger = state.latestSequence - 5;
      const estimated = estimator.estimateCloseTime(pastLedger);

      expect(estimated.getTime()).toBeLessThan(state.latestClosedAtMs);

      estimator.destroy();
    });
  });

  describe("estimateLedgerAtTime()", () => {
    it("projects the correct ledger sequence for a future time", async () => {
      const INTERVAL_MS = 5_000;
      const BASE_SEQ = 4_000_000;
      const BASE_TIME = new Date("2025-05-01T00:00:00Z").getTime();

      const estimator = new LedgerCloseEstimator({
        horizonUrl: "https://horizon-testnet.stellar.org",
        calibrationIntervalMs: 0,
      });

      vi.spyOn(estimator as any, "_fetchLedgers").mockResolvedValue(
        buildLedgerRecords(20, BASE_SEQ, BASE_TIME, INTERVAL_MS),
      );

      await estimator.calibrate(20);

      const state = estimator.state!;
      // 30 seconds after latest → ~6 ledgers ahead
      const futureMs = state.latestClosedAtMs + 30_000;
      const seq = estimator.estimateLedgerAtTime(new Date(futureMs));

      expect(seq).toBeCloseTo(state.latestSequence + 6, 0);

      estimator.destroy();
    });

    it("uses FALLBACK_INTERVAL_MS when not calibrated", () => {
      const estimator = new LedgerCloseEstimator({
        horizonUrl: "https://horizon-testnet.stellar.org",
        calibrationIntervalMs: 0,
      });

      const currentLedger = 1_000_000;
      vi.spyOn(estimator as any, "_guessCurrentLedger").mockReturnValue(
        currentLedger,
      );

      // 50 seconds in the future → 10 ledgers at 5s each
      const future = new Date(Date.now() + 50_000);
      const seq = estimator.estimateLedgerAtTime(future);

      expect(seq).toBeCloseTo(currentLedger + 10, 0);

      estimator.destroy();
    });
  });

  describe("auto-calibration", () => {
    it("re-calibrates automatically after calibrationIntervalMs", async () => {
      const estimator = new LedgerCloseEstimator({
        horizonUrl: "https://horizon-testnet.stellar.org",
        calibrationIntervalMs: 60_000,
      });

      const fetchSpy = vi
        .spyOn(estimator as any, "_fetchLedgers")
        .mockResolvedValue(buildLedgerRecords(20, 1_000, Date.now(), 5_000));

      await estimator.calibrate(20);
      expect(fetchSpy).toHaveBeenCalledTimes(1);

      // Advance fake timers by 1 minute to trigger recalibration
      await vi.advanceTimersByTimeAsync(60_000);

      expect(fetchSpy).toHaveBeenCalledTimes(2);

      estimator.destroy();
    });
  });

  describe("DeadlineEngine.estimateDeadlineFromLedger()", () => {
    it("returns a Unix-seconds deadline derived from the estimator", async () => {
      const INTERVAL_MS = 5_000;
      const BASE_SEQ = 5_000_000;
      const BASE_TIME = new Date("2025-07-01T00:00:00Z").getTime();

      const estimator = new LedgerCloseEstimator({
        horizonUrl: "https://horizon-testnet.stellar.org",
        calibrationIntervalMs: 0,
      });

      vi.spyOn(estimator as any, "_fetchLedgers").mockResolvedValue(
        buildLedgerRecords(20, BASE_SEQ, BASE_TIME, INTERVAL_MS),
      );

      await estimator.calibrate(20);
      const state = estimator.state!;

      const engine = new DeadlineEngine();
      const targetLedger = state.latestSequence + 12;
      const deadline = engine.estimateDeadlineFromLedger(targetLedger, estimator);

      const expectedMs = state.latestClosedAtMs + 12 * INTERVAL_MS;
      expect(deadline).toBeCloseTo(expectedMs / 1000, 0);

      estimator.destroy();
    });
  });
});
