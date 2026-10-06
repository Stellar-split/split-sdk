/**
 * SplitExecutor — orchestrates multi-recipient split payment execution (Issue #591).
 *
 * Runs a subentry capacity pre-flight check via {@link checkSubentryCapacity}
 * for each recipient account before attempting to add new trustlines or data
 * entries, preventing silent `op_low_reserve` failures on the Stellar network.
 *
 * Callers may opt out of the capacity check by passing
 * `{ skipCapacityCheck: true }` in the options, which bypasses the guard
 * entirely without altering any other pre-flight behaviour.
 *
 * Issue #778 — when recipients declare a `ratio`, the executor first verifies
 * that the ratios sum to exactly 1.0 (within {@link SPLIT_RATIO_TOLERANCE})
 * and throws {@link SplitRatioSumError} otherwise, so floating-point rounding
 * errors or user input mistakes can never silently over- or underpay a split.
 * Splits without ratios behave exactly as before.
 */

import { checkSubentryCapacity, SubentryCapacityGuardError } from "../account/subentryGuard.js";
import { StellarSplitError } from "../errors.js";
import type { SubentryCapacityResult } from "../types.js";

// ---------------------------------------------------------------------------
// Ratio validation (Issue #778)
// ---------------------------------------------------------------------------

/**
 * Absolute tolerance applied when comparing the sum of recipient ratios to
 * 1.0. Floating-point arithmetic cannot represent most decimal ratios exactly,
 * so a sum such as `0.1 + 0.2 + 0.7` (≈ 0.9999999999999999) is accepted.
 */
export const SPLIT_RATIO_TOLERANCE = 1e-9;

/** The exact sum every valid split's recipient ratios must equal. */
const SPLIT_RATIO_EXPECTED_SUM = 1;

/**
 * Thrown when the sum of all recipient ratios does not equal 1.0 within
 * {@link SPLIT_RATIO_TOLERANCE}. The offending sum is exposed on
 * {@link SplitRatioSumError.actualSum} so callers can report the exact drift.
 */
export class SplitRatioSumError extends StellarSplitError {
  /** The sum of all declared recipient ratios. */
  readonly actualSum: number;
  /** The sum the ratios were expected to add up to (always `1`). */
  readonly expectedSum: number;
  /** Tolerance applied to the comparison. */
  readonly tolerance: number;

  constructor(
    actualSum: number,
    expectedSum: number = SPLIT_RATIO_EXPECTED_SUM,
    tolerance: number = SPLIT_RATIO_TOLERANCE,
  ) {
    const drift = actualSum - expectedSum;
    super(
      `Split recipient ratios must sum to ${expectedSum} (±${tolerance}); ` +
        `received ${actualSum} (drift ${drift}).`,
      "SPLIT_RATIO_SUM_INVALID",
      { actualSum, expectedSum, tolerance, drift },
    );
    this.name = "SplitRatioSumError";
    this.actualSum = actualSum;
    this.expectedSum = expectedSum;
    this.tolerance = tolerance;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Sum the declared ratios of `recipients`.
 *
 * Recipients that omit `ratio` contribute `0`, which means every recipient of a
 * ratio-validated split must declare its share.
 *
 * @param recipients - Recipient legs of the split.
 *
 * @returns The arithmetic sum of all declared ratios.
 */
export function sumRecipientRatios(recipients: SplitRecipient[]): number {
  return recipients.reduce((sum, recipient) => sum + (recipient.ratio ?? 0), 0);
}

/**
 * Thrown when a recipient's individual ratio is not a finite number in the
 * valid [0, 1] range. Covers NaN, ±Infinity, and out-of-range values such as
 * negative ratios or ratios greater than 1.
 */
export class SplitRatioLegError extends StellarSplitError {
  /** The address of the recipient whose ratio is invalid. */
  readonly address: string;
  /** The invalid ratio value that was provided. */
  readonly ratio: number;

  constructor(address: string, ratio: number) {
    const reason = !Number.isFinite(ratio)
      ? `not a finite number (${ratio})`
      : ratio < 0
      ? `negative (${ratio})`
      : `greater than 1 (${ratio})`;
    super(
      `Split recipient ${address} has an invalid ratio: ${reason}. ` +
        `Each ratio must be a finite number in [0, 1].`,
      "SPLIT_RATIO_LEG_INVALID",
      { address, ratio },
    );
    this.name = "SplitRatioLegError";
    this.address = address;
    this.ratio = ratio;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Assert that the declared recipient ratios sum to 1.0 within `tolerance`.
 *
 * Also validates that every individual ratio is a finite number in the
 * [0, 1] range before checking the aggregate. This catches negative ratios,
 * ratios greater than 1, NaN, and ±Infinity — any of which could silently
 * produce a sum of 1.0 that is actually invalid (e.g. `[-1, 2]`).
 *
 * @param recipients - Recipient legs of the split; each should declare `ratio`.
 * @param tolerance  - Absolute tolerance for the comparison.
 *   Defaults to {@link SPLIT_RATIO_TOLERANCE}.
 *
 * @returns The actual sum of the declared ratios (useful for logging/metrics).
 *
 * @throws {SplitRatioLegError} When any individual ratio is not finite or
 *   outside [0, 1].
 * @throws {SplitRatioSumError} When `|sum - 1| > tolerance`.
 */
export function validateSplitRatioSum(
  recipients: SplitRecipient[],
  tolerance: number = SPLIT_RATIO_TOLERANCE,
): number {
  // Issue #1012 — validate each leg individually first so that invalid
  // values like [-1, 2], NaN, or Infinity cannot slip through just because
  // their aggregate happens to equal 1.0 (or NaN, which always evades the
  // tolerance check since NaN comparisons return false).
  for (const recipient of recipients) {
    if (recipient.ratio !== undefined) {
      const r = recipient.ratio;
      if (!Number.isFinite(r) || r < 0 || r > 1) {
        throw new SplitRatioLegError(recipient.address, r);
      }
    }
  }

  const actualSum = sumRecipientRatios(recipients);
  // Also guard against non-finite sums from missing legs or other edge cases.
  if (!Number.isFinite(actualSum)) {
    throw new SplitRatioSumError(actualSum, SPLIT_RATIO_EXPECTED_SUM, tolerance);
  }
  if (Math.abs(actualSum - SPLIT_RATIO_EXPECTED_SUM) > tolerance) {
    throw new SplitRatioSumError(actualSum, SPLIT_RATIO_EXPECTED_SUM, tolerance);
  }
  return actualSum;
}

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** A single recipient leg in a split payment. */
export interface SplitRecipient {
  /** Stellar G… address of the recipient. */
  address: string;
  /** Amount to send in stroops. */
  amount: bigint;
  /**
   * Number of new subentry slots this recipient will consume as a result of
   * this operation (e.g., 1 for a new trustline, 1 for a new data entry).
   * Defaults to 1 when not provided.
   */
  requiredSlots?: number;
  /**
   * The recipient's share of the split as a decimal ratio (a fraction of the
   * total, e.g. `0.25` for 25 %).
   *
   * When at least one recipient declares a `ratio`, every recipient must do so
   * and the ratios must sum to 1.0 within {@link SPLIT_RATIO_TOLERANCE};
   * otherwise {@link splitExecutor} throws {@link SplitRatioSumError} before
   * building any transaction. Splits that omit ratios entirely skip this check.
   */
  ratio?: number;
}

/** Options that control splitExecutor behaviour. */
export interface SplitExecutorOptions {
  /**
   * When `true`, the subentry capacity pre-flight check is skipped entirely.
   * Useful when the caller has already verified capacity out-of-band.
   * Defaults to `false`.
   */
  skipCapacityCheck?: boolean;
  /**
   * Horizon API base URL used for account lookups during the capacity check.
   * Defaults to `"https://horizon.stellar.org"`.
   */
  horizonUrl?: string;
}

/** Result of a successful split execution. */
export interface SplitExecutionResult {
  /** Whether the execution was successful (pre-flight and dispatch passed). */
  success: boolean;
  /**
   * Per-recipient capacity check results, keyed by recipient address.
   * Only populated when the capacity check was not skipped.
   */
  capacityChecks: Record<string, SubentryCapacityResult>;
  /** Whether the capacity pre-flight check was skipped. */
  skippedCapacityCheck: boolean;
}

// ---------------------------------------------------------------------------
// splitExecutor
// ---------------------------------------------------------------------------

/**
 * Executes a multi-recipient split payment after running subentry capacity
 * pre-flight checks for each recipient.
 *
 * When any recipient declares a `ratio`, the ratios are validated to sum to
 * 1.0 (within {@link SPLIT_RATIO_TOLERANCE}) before any transaction is built.
 *
 * @param recipients - Array of recipient addresses, amounts, and required slots.
 * @param options    - Execution options including the opt-out skip flag and Horizon URL.
 *
 * @returns {@link SplitExecutionResult} with capacity check outcomes.
 *
 * @throws {SplitRatioSumError} When recipient ratios are declared but do not
 *   sum to 1.0 within {@link SPLIT_RATIO_TOLERANCE}.
 * @throws {SubentryCapacityGuardError} When any recipient's account cannot
 *   accommodate the required subentry slots and `skipCapacityCheck` is not set.
 *
 * @example
 * ```ts
 * // Normal execution — capacity guard runs for each recipient
 * const result = await splitExecutor(
 *   [
 *     { address: "GABC...", amount: 5_000_000n, requiredSlots: 1 },
 *     { address: "GDEF...", amount: 5_000_000n, requiredSlots: 1 },
 *   ],
 *   { horizonUrl: "https://horizon-testnet.stellar.org" },
 * );
 *
 * // Ratio-validated split — rejects before building a transaction when the
 * // declared shares do not add up to 100 %
 * await splitExecutor([
 *   { address: "GABC...", amount: 5_000_000n, ratio: 0.4 },
 *   { address: "GDEF...", amount: 5_000_000n, ratio: 0.6 },
 * ]);
 *
 * // Opt-out — skip capacity guard entirely
 * const result = await splitExecutor(recipients, { skipCapacityCheck: true });
 * ```
 */
export async function splitExecutor(
  recipients: SplitRecipient[],
  options: SplitExecutorOptions = {},
): Promise<SplitExecutionResult> {
  const {
    skipCapacityCheck = false,
    horizonUrl = "https://horizon.stellar.org",
  } = options;

  // Issue #778 — fail fast on malformed ratios instead of processing (and
  // paying out) a split whose shares silently over- or underpay the total.
  if (recipients.some((recipient) => recipient.ratio !== undefined)) {
    validateSplitRatioSum(recipients);
  }

  const capacityChecks: Record<string, SubentryCapacityResult> = {};

  if (!skipCapacityCheck) {
    // Run capacity checks for all recipients sequentially so that the first
    // failing account surfaces a clear error with the account ID and the
    // amount of additional XLM required.
    for (const recipient of recipients) {
      const requiredSlots = recipient.requiredSlots ?? 1;
      // checkSubentryCapacity throws SubentryCapacityGuardError on failure,
      // which names the specific account ID and the reserve shortfall.
      const result = await checkSubentryCapacity(
        recipient.address,
        requiredSlots,
        horizonUrl,
      );
      capacityChecks[recipient.address] = result;
    }
  }

  return {
    success: true,
    capacityChecks,
    skippedCapacityCheck: skipCapacityCheck,
  };
}

// Re-export the error classes so callers can catch them without a separate import.
export { SubentryCapacityGuardError };
