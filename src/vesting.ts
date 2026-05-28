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
