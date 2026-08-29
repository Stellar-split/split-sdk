import type { Invoice, VestingSchedule } from "./types.js";

/** Extended invoice fields used for vesting calculations. */
interface VestingInvoice extends Invoice {
  vestingCliff?: number;
  dripDuration?: number;
}

/**
 * Calculate the vesting schedule for an invoice with a cliff.
 *
 * @param invoice - The invoice to calculate vesting for
 * @returns Vesting schedule with cliff date and claimable amount function
 */
export function calculateVesting(invoice: Invoice): VestingSchedule {
  const vesting = invoice as VestingInvoice;
  const cliffDate = vesting.vestingCliff ?? 0;
  const dripDuration = vesting.dripDuration ?? 0;
  const fullyVestedDate = cliffDate + dripDuration;
  const totalAmount = invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);

  return {
    cliffDate,
    fullyVestedDate,
    claimableAt: (timestamp: number): bigint => {
      if (timestamp < cliffDate) return 0n;
      if (timestamp >= fullyVestedDate) return totalAmount;
      const elapsed = BigInt(timestamp - cliffDate);
      const duration = BigInt(dripDuration);
      return (totalAmount * elapsed) / duration;
    },
  };
}

// ---------------------------------------------------------------------------
// VestingOptions / vestedAt API
// ---------------------------------------------------------------------------

/**
 * Options for a token vesting schedule with optional cliff support.
 */
export interface VestingOptions {
  /** Unix timestamp (seconds) when the vesting period begins. */
  startTime: number;
  /** Total duration of the vesting period in seconds. */
  duration: number;
  /** Total amount of tokens to vest (in stroops). */
  totalAmount: bigint;
  /**
   * Minimum duration (in seconds) that must elapse before any tokens vest.
   * Before this threshold no tokens are available regardless of elapsed time.
   * Defaults to `0` (no cliff — tokens begin vesting immediately).
   */
  cliffDuration?: number;
}

/**
 * Compute the vested amount at a given timestamp according to a linear
 * vesting schedule with an optional cliff period.
 *
 * - Returns `0n` when `timestamp - startTime < cliffDuration`.
 * - After the cliff, linear vesting resumes from the cliff date.
 * - Returns `totalAmount` once the full duration has elapsed.
 *
 * The return type of this function is `bigint` and will not change.
 *
 * @param timestamp - Unix timestamp in seconds to evaluate.
 * @param options   - Vesting schedule configuration.
 * @returns The vested amount in stroops as a `bigint`.
 */
export function vestedAt(timestamp: number, options: VestingOptions): bigint {
  const { startTime, duration, totalAmount, cliffDuration = 0 } = options;
  const elapsed = timestamp - startTime;

  if (elapsed < cliffDuration) return 0n;
  if (elapsed >= duration) return totalAmount;

  const vestedElapsed = BigInt(elapsed - cliffDuration);
  const vestingDuration = BigInt(duration - cliffDuration);
  if (vestingDuration === 0n) return totalAmount;

  return (totalAmount * vestedElapsed) / vestingDuration;
}

