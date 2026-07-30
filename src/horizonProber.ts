/**
 * Horizon Endpoint Availability Prober — Issue #546
 *
 * Proactively verifies that the configured Horizon endpoint is reachable and
 * returning a healthy response.  Tracks the `history_latest_ledger` field to
 * detect stale endpoints and emits `horizonEndpointDegraded` /
 * `horizonEndpointRecovered` events via a callback interface.
 *
 * Integrates with src/health.ts (RPCHealth) and src/healthDashboard.ts
 * (prober result included in the dashboard snapshot).
 */

import { Horizon } from "@stellar/stellar-sdk";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Result of a single {@link HorizonProber.probe} call. */
export interface HorizonProbeResult {
  /** Whether the endpoint responded within `timeoutMs`. */
  reachable: boolean;
  /** Round-trip time in milliseconds (0 when not reachable). */
  latencyMs: number;
  /** `history_latest_ledger` from the root response, or 0 if unreachable. */
  latestLedger: number;
  /**
   * `true` when the ledger has not advanced since the previous successful
   * probe AND the gap exceeds `stalenessThresholdMs`.
   */
  isStale: boolean;
  /** ISO-8601 timestamp of when this probe was taken. */
  probedAt: string;
  /** Optional error message when `reachable` is false. */
  error?: string;
}

/** Configuration for {@link HorizonProber}. */
export interface HorizonProberConfig {
  /** Horizon server URL. */
  horizonUrl: string;
  /**
   * Milliseconds to wait for a root-endpoint response before marking the
   * endpoint as unreachable.  Default: 10 000 ms.
   */
  timeoutMs?: number;
  /**
   * Milliseconds without a ledger advancement before `isStale` is set to
   * `true`.  Default: 30 000 ms.
   */
  stalenessThresholdMs?: number;
  /**
   * Number of consecutive failing or stale probes before
   * `horizonEndpointDegraded` is emitted.  Default: 2.
   */
  degradedAfterConsecutiveFailures?: number;
  /**
   * Called when two consecutive probes fail or return stale results
   * (and the endpoint was previously considered healthy).
   */
  onDegraded?: (result: HorizonProbeResult) => void;
  /**
   * Called on the first successful non-stale probe after a degraded period.
   */
  onRecovered?: (result: HorizonProbeResult) => void;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Lightweight Horizon endpoint availability prober.
 *
 * @example
 * ```ts
 * const prober = new HorizonProber({
 *   horizonUrl: "https://horizon.stellar.org",
 *   onDegraded: (r) => console.warn("Horizon degraded", r),
 *   onRecovered: (r) => console.info("Horizon recovered", r),
 * });
 *
 * const result = await prober.probe("https://horizon.stellar.org");
 * console.log(result.reachable, result.isStale, result.latencyMs);
 * ```
 */
export class HorizonProber {
  private readonly timeoutMs: number;
  private readonly stalenessThresholdMs: number;
  private readonly degradedAfterConsecutiveFailures: number;
  private readonly onDegraded?: (r: HorizonProbeResult) => void;
  private readonly onRecovered?: (r: HorizonProbeResult) => void;

  /** Ledger sequence observed in the last successful probe. */
  private lastLedger = 0;
  /** Timestamp (ms) when `lastLedger` was first observed. */
  private lastLedgerSeenAt = 0;
  /** Number of consecutive failing or stale probes. */
  private consecutiveFailures = 0;
  /** Whether the endpoint is currently considered degraded. */
  private degraded = false;
  /** Most recent probe result (exposed to the health dashboard). */
  private lastResult: HorizonProbeResult | null = null;

  constructor(config: HorizonProberConfig) {
    this.timeoutMs = config.timeoutMs ?? 10_000;
    this.stalenessThresholdMs = config.stalenessThresholdMs ?? 30_000;
    this.degradedAfterConsecutiveFailures =
      config.degradedAfterConsecutiveFailures ?? 2;
    this.onDegraded = config.onDegraded;
    this.onRecovered = config.onRecovered;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Probe the Horizon endpoint at `endpointUrl` and return a
   * {@link HorizonProbeResult}.
   *
   * Side effects:
   * - Tracks ledger advancement to determine staleness.
   * - Fires `onDegraded` when `degradedAfterConsecutiveFailures` consecutive
   *   probes fail or return stale results (emits `horizonEndpointDegraded`).
   * - Fires `onRecovered` on the first successful non-stale probe after a
   *   degraded period (emits `horizonEndpointRecovered`).
   *
   * @param endpointUrl - Horizon root URL to probe.
   * @returns A {@link HorizonProbeResult} describing the current health.
   */
  async probe(endpointUrl: string): Promise<HorizonProbeResult> {
    const startTime = Date.now();
    const probedAt = new Date(startTime).toISOString();

    let result: HorizonProbeResult;

    try {
      const server = new Horizon.Server(endpointUrl, { allowHttp: endpointUrl.startsWith("http://") });

      // Race the root() call against the timeout
      const rootResponse = await this._withTimeout(
        server.root(),
        this.timeoutMs,
      );

      const latencyMs = Date.now() - startTime;
      const latestLedger: number =
        (rootResponse as { history_latest_ledger: number }).history_latest_ledger ?? 0;

      // Determine staleness
      const isStale = this._checkStaleness(latestLedger, startTime);

      result = {
        reachable: true,
        latencyMs,
        latestLedger,
        isStale,
        probedAt,
      };
    } catch (err) {
      const latencyMs = Date.now() - startTime;
      result = {
        reachable: false,
        latencyMs,
        latestLedger: 0,
        isStale: false,
        probedAt,
        error: err instanceof Error ? err.message : String(err),
      };
    }

    this.lastResult = result;
    this._updateDegradationState(result);
    return result;
  }

  /**
   * Return the most recent probe result, or `null` if `probe()` has not been
   * called yet.  Used by the health dashboard to include the prober's state
   * in the snapshot.
   */
  getLastResult(): HorizonProbeResult | null {
    return this.lastResult;
  }

  /**
   * Whether the endpoint is currently considered degraded.
   */
  isDegraded(): boolean {
    return this.degraded;
  }

  // -------------------------------------------------------------------------
  // Internal helpers
  // -------------------------------------------------------------------------

  /**
   * Check whether the most recently observed `latestLedger` is stale.
   *
   * Staleness = the ledger value has NOT advanced since the last successful
   * probe AND more than `stalenessThresholdMs` have elapsed since we first
   * saw that ledger value.
   */
  private _checkStaleness(latestLedger: number, nowMs: number): boolean {
    if (latestLedger === 0) return false; // nothing to compare yet

    if (latestLedger > this.lastLedger) {
      // Ledger advanced — reset staleness clock
      this.lastLedger = latestLedger;
      this.lastLedgerSeenAt = nowMs;
      return false;
    }

    // Ledger did not advance
    if (this.lastLedgerSeenAt === 0) {
      // First probe — initialise the staleness clock
      this.lastLedger = latestLedger;
      this.lastLedgerSeenAt = nowMs;
      return false;
    }

    return nowMs - this.lastLedgerSeenAt >= this.stalenessThresholdMs;
  }

  /** Update degradation state and fire callbacks when the state changes. */
  private _updateDegradationState(result: HorizonProbeResult): void {
    const isBad = !result.reachable || result.isStale;

    if (isBad) {
      this.consecutiveFailures++;
      if (
        !this.degraded &&
        this.consecutiveFailures >= this.degradedAfterConsecutiveFailures
      ) {
        this.degraded = true;
        this.onDegraded?.(result);
      }
    } else {
      const wasDegraded = this.degraded;
      this.consecutiveFailures = 0;
      this.degraded = false;
      if (wasDegraded) {
        this.onRecovered?.(result);
      }
    }
  }

  /** Race a promise against a timeout. */
  private _withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error(`Request timed out after ${ms}ms`)),
        ms,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (err: unknown) => {
          clearTimeout(timer);
          reject(err);
        },
      );
    });
  }
}
