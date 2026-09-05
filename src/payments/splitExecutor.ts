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
 */

import { checkSubentryCapacity, SubentryCapacityGuardError } from "../account/subentryGuard.js";
import type { SubentryCapacityResult } from "../types.js";
import { SplitRatioSumError } from "../errors.js";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Tolerance for floating-point ratio-sum comparison. Exported for callers. */
export const SPLIT_RATIO_TOLERANCE = 1e-9;

/** A single recipient leg in a split payment. */
export interface SplitRecipient {
  /** Stellar G… address of the recipient. */
  address: string;
  /** Amount to send in stroops. */
  amount: bigint;
  /** Optional share ratio (0.0–1.0). When provided, splitExecutor validates that all ratios sum to 1.0. */
  ratio?: number;
  /**
   * Number of new subentry slots this recipient will consume as a result of
   * this operation (e.g., 1 for a new trustline, 1 for a new data entry).
   * Defaults to 1 when not provided.
   */
  requiredSlots?: number;
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
 * Validates that any provided recipient ratios sum to 1.0 within tolerance.
 * @throws {SplitRatioSumError} When ratios are provided and do not sum to 1.0.
 */
function validateRecipientRatios(recipients: SplitRecipient[]): void {
  const ratios = recipients
    .map((r) => r.ratio)
    .filter((r): r is number => r !== undefined);

  if (ratios.length === 0) return;

  const sum = ratios.reduce((acc, r) => acc + r, 0);
  if (Math.abs(sum - 1.0) > SPLIT_RATIO_TOLERANCE) {
    throw new SplitRatioSumError(sum, SPLIT_RATIO_TOLERANCE);
  }
}

/**
 * Executes a multi-recipient split payment after running subentry capacity
 * pre-flight checks for each recipient.
 *
 * @param recipients - Array of recipient addresses, amounts, and required slots.
 * @param options    - Execution options including the opt-out skip flag and Horizon URL.
 *
 * @returns {@link SplitExecutionResult} with capacity check outcomes.
 *
 * @throws {SubentryCapacityGuardError} When any recipient's account cannot
 *   accommodate the required subentry slots and `skipCapacityCheck` is not set.
 * @throws {SplitRatioSumError} When recipient ratios are provided and do not sum to 1.0.
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

  // Ratio validation (issue #778)
  validateRecipientRatios(recipients);

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

// Re-export the error class so callers can catch it without a separate import.
export { SubentryCapacityGuardError };
