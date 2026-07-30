/**
 * Ledger Close Time Estimator
 *
 * Computes a rolling-average ledger close interval from recent Horizon ledger
 * history and projects future close times / ledger sequences. Used by
 * DeadlineEngine and StellarSplitTxBuilder for accurate timebounds computation.
 *
 * Stellar targets a ~5-second close interval but actual intervals vary with
 * network load. Calibrating from real history gives much better estimates.
 */

import { Horizon } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A condensed ledger record used internally for calibration. */
export interface LedgerRecord {
  /** Ledger sequence number. */
  sequence: number;
  /** ISO-8601 timestamp string of when the ledger closed. */
  closed_at: string;
}

/** Options for creating a {@link LedgerCloseEstimator}. */
export interface LedgerCloseEstimatorOptions {
  /**
   * Base URL for the Horizon server.
   * @example "https://horizon-testnet.stellar.org"
   */
  horizonUrl: string;
  /**
   * How often to re-calibrate automatically, in milliseconds.
   * @default 300_000 (5 minutes)
   */
  calibrationIntervalMs?: number;
  /**
   * Default number of recent ledgers to fetch during calibration.
   * @default 20
   */
  defaultSampleSize?: number;
}

/** Internal calibration state after a successful {@link LedgerCloseEstimator.calibrate} call. */
export interface CalibrationState {
  /** Rolling-average close interval in milliseconds. */
  avgIntervalMs: number;
  /** The most-recent ledger sequence number in the sample. */
  latestSequence: number;
  /** The epoch-ms timestamp at which that ledger closed. */
  latestClosedAtMs: number;
  /** When this calibration was computed (epoch ms). */
  calibratedAt: number;
}

// ---------------------------------------------------------------------------
// Estimator implementation
// ---------------------------------------------------------------------------

/**
 * Estimates future ledger close times by computing a rolling-average close
 * interval from recent Horizon ledger history.
 *
 * @example
 * ```typescript
 * const estimator = new LedgerCloseEstimator({
 *   horizonUrl: "https://horizon-testnet.stellar.org",
 * });
 *
 * // Calibrate once before using
 * await estimator.calibrate();
 *
 * // Estimate when ledger 100 ledgers ahead will close
 * const currentLedger = 100_000;
 * const targetLedger  = currentLedger + 100;
 * const closeTime = estimator.estimateCloseTime(targetLedger);
 *
 * // Or: which ledger will be current in 10 minutes?
 * const futureTime = new Date(Date.now() + 10 * 60_000);
 * const futureLedger = estimator.estimateLedgerAtTime(futureTime);
 * ```
 */
export class LedgerCloseEstimator {
  private readonly horizonUrl: string;
  private readonly calibrationIntervalMs: number;
  private readonly defaultSampleSize: number;

  private _state: CalibrationState | null = null;
  private _autoTimer: ReturnType<typeof setInterval> | null = null;

  /** Fallback interval assumed when no calibration data is available (ms). */
  static readonly FALLBACK_INTERVAL_MS = 5_000;

  constructor(options: LedgerCloseEstimatorOptions) {
    this.horizonUrl = options.horizonUrl.replace(/\/$/, "");
    this.calibrationIntervalMs = options.calibrationIntervalMs ?? 300_000;
    this.defaultSampleSize = options.defaultSampleSize ?? 20;
  }

  // ---------------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------------

  /**
   * Fetch the last `sampleSize` ledgers from Horizon and compute the
   * rolling-average close interval in milliseconds.
   *
   * Call this at least once before using the projection methods. Subsequent
   * calls refresh the calibration data.
   *
   * @param sampleSize - How many recent ledgers to include in the average.
   *   Defaults to the value set in the constructor options (20).
   */
  async calibrate(sampleSize?: number): Promise<void> {
    const n = sampleSize ?? this.defaultSampleSize;
    const records = await this._fetchLedgers(n);

    if (records.length < 2) {
      // Not enough data — keep any existing state or use the fallback.
      return;
    }

    // Sort ascending by sequence so we can compute deltas in order.
    const sorted = [...records].sort((a, b) => a.sequence - b.sequence);

    // Compute consecutive close-time deltas.
    const deltas: number[] = [];
    for (let i = 1; i < sorted.length; i++) {
      const prev = new Date(sorted[i - 1]!.closed_at).getTime();
      const curr = new Date(sorted[i]!.closed_at).getTime();
      const delta = curr - prev;
      if (delta > 0) deltas.push(delta);
    }

    if (deltas.length === 0) return;

    const avgIntervalMs = deltas.reduce((s, d) => s + d, 0) / deltas.length;

    const latest = sorted[sorted.length - 1]!;
    this._state = {
      avgIntervalMs,
      latestSequence: latest.sequence,
      latestClosedAtMs: new Date(latest.closed_at).getTime(),
      calibratedAt: Date.now(),
    };

    // Arm the auto-recalibration timer the first time calibrate() succeeds.
    if (this._autoTimer === null && this.calibrationIntervalMs > 0) {
      this._autoTimer = setInterval(
        () => void this.calibrate(n),
        this.calibrationIntervalMs,
      );
      // Keep Node.js from blocking the exit due to this timer.
      if (
        typeof this._autoTimer === "object" &&
        this._autoTimer !== null &&
        typeof (this._autoTimer as NodeJS.Timeout).unref === "function"
      ) {
        (this._autoTimer as NodeJS.Timeout).unref();
      }
    }
  }

  /**
   * Project the wall-clock time at which `targetLedger` will close.
   *
   * Uses the rolling-average interval from the last calibration. Falls back
   * to a 5-second interval when not yet calibrated.
   *
   * @param targetLedger - The future ledger sequence number to project.
   * @returns A {@link Date} representing the estimated close time.
   */
  estimateCloseTime(targetLedger: number): Date {
    const state = this._state;
    if (!state) {
      // No calibration — project from now using the fallback interval.
      const ledgerAge = targetLedger - this._guessCurrentLedger();
      const msFromNow = ledgerAge * LedgerCloseEstimator.FALLBACK_INTERVAL_MS;
      return new Date(Date.now() + Math.max(0, msFromNow));
    }

    const ledgerDelta = targetLedger - state.latestSequence;
    const msFromLatest = ledgerDelta * state.avgIntervalMs;
    return new Date(state.latestClosedAtMs + msFromLatest);
  }

  /**
   * Project which ledger sequence will be current at `targetTime`.
   *
   * Uses the rolling-average interval from the last calibration. Falls back
   * to a 5-second interval when not yet calibrated.
   *
   * @param targetTime - The future point in time to project.
   * @returns The estimated ledger sequence number at that time.
   */
  estimateLedgerAtTime(targetTime: Date): number {
    const state = this._state;
    const targetMs = targetTime.getTime();

    if (!state) {
      const msFromNow = targetMs - Date.now();
      const ledgersFromNow = msFromNow / LedgerCloseEstimator.FALLBACK_INTERVAL_MS;
      return Math.round(this._guessCurrentLedger() + ledgersFromNow);
    }

    const msFromLatest = targetMs - state.latestClosedAtMs;
    const ledgersFromLatest = msFromLatest / state.avgIntervalMs;
    return Math.round(state.latestSequence + ledgersFromLatest);
  }

  /**
   * Returns the current {@link CalibrationState} or `null` if not yet calibrated.
   */
  get state(): CalibrationState | null {
    return this._state;
  }

  /**
   * Returns the rolling-average close interval in milliseconds.
   * Falls back to {@link LedgerCloseEstimator.FALLBACK_INTERVAL_MS} when not calibrated.
   */
  get avgIntervalMs(): number {
    return this._state?.avgIntervalMs ?? LedgerCloseEstimator.FALLBACK_INTERVAL_MS;
  }

  /**
   * Stop the automatic re-calibration timer.
   */
  destroy(): void {
    if (this._autoTimer !== null) {
      clearInterval(this._autoTimer);
      this._autoTimer = null;
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Fetch the last `n` ledgers from Horizon, sorted descending by sequence. */
  private async _fetchLedgers(n: number): Promise<LedgerRecord[]> {
    const server = new Horizon.Server(this.horizonUrl, {
      allowHttp: this.horizonUrl.startsWith("http://"),
    });

    const response = await server
      .ledgers()
      .order("desc")
      .limit(Math.max(2, Math.min(n, 200)))
      .call();

    return (response.records as Array<{ sequence: number; closed_at: string }>).map(
      (r) => ({
        sequence: r.sequence,
        closed_at: r.closed_at,
      }),
    );
  }

  /**
   * Very rough guess at the current ledger sequence based on a well-known
   * Stellar mainnet genesis ledger (32570) and the fallback interval.
   * Only used as a fallback when no calibration data is available.
   */
  private _guessCurrentLedger(): number {
    // Stellar mainnet genesis was Jan 2015.
    // Using a rough constant is fine here — this path is only taken when not calibrated.
    const GENESIS_LEDGER = 32_570;
    const GENESIS_TIMESTAMP_MS = new Date("2015-10-01T00:00:00Z").getTime();
    const elapsed = Date.now() - GENESIS_TIMESTAMP_MS;
    return (
      GENESIS_LEDGER + Math.floor(elapsed / LedgerCloseEstimator.FALLBACK_INTERVAL_MS)
    );
  }
}
