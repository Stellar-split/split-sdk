import type { Invoice, VestingSchedule } from "./types.js";

/**
 * Calculate the vesting schedule for an invoice with a cliff.
 *
 * @param invoice - The invoice to calculate vesting for
 * @returns Vesting schedule with cliff date and claimable amount function
 */
export function calculateVesting(invoice: Invoice): VestingSchedule {
  // Assuming invoice has vestingCliff and dripDuration fields
  // vestingCliff is the cliff date (unix timestamp)
  // dripDuration is the duration in seconds for the vesting period
  const cliffDate = (invoice as Invoice & { vestingCliff?: number }).vestingCliff ?? 0;
  const dripDuration = (invoice as Invoice & { dripDuration?: number }).dripDuration ?? 0;
  const fullyVestedDate = cliffDate + dripDuration;
  const totalAmount = invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);

  return {
    cliffDate,
    fullyVestedDate,
    claimableAt: (timestamp: number): bigint => {
      // Before cliff: 0
      if (timestamp < cliffDate) {
        return 0n;
      }

      // After fully vested: full amount
      if (timestamp >= fullyVestedDate) {
        return totalAmount;
      }

      // During vesting: linear interpolation
      const elapsed = BigInt(timestamp - cliffDate);
      const duration = BigInt(dripDuration);
      return (totalAmount * elapsed) / duration;
    },
  };
}
