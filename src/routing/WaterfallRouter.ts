/**
 * WaterfallRouter — sequences a multi-tier invoice payout (e.g. platform
 * fee, then tax withholding, then beneficiary) so lower-priority recipients
 * are only paid once every upstream tier's minimum has been met.
 */

import type { Invoice } from "../types.js";
import { ValidationError } from "../errors.js";
import type { WaterfallConfig, WaterfallPlan, WaterfallStep } from "../types/routing.js";

export class WaterfallRouter {
  /**
   * Build a sequenced payment plan for `invoice` given `availableAmount`
   * (stroops) to distribute across `config.tiers`, in declared priority
   * order. As soon as a tier's minimumAmount exceeds what's left of
   * availableAmount, that tier and every tier after it come back with
   * `satisfied: false` and a zero amount.
   */
  plan(invoice: Invoice, availableAmount: bigint, config: WaterfallConfig): WaterfallPlan {
    if (availableAmount < 0n) {
      throw new ValidationError("availableAmount must be >= 0", { availableAmount: availableAmount.toString() });
    }
    for (const tier of config.tiers) {
      if (tier.minimumAmount < 0n) {
        throw new ValidationError("WaterfallTier.minimumAmount must be >= 0", {
          recipient: tier.recipient,
          minimumAmount: tier.minimumAmount.toString(),
        });
      }
    }

    // Sort tiers by score descending; stable sort preserves declaration order on ties
    const sortedTiers = [...config.tiers].sort((a, b) => (b.score ?? 0) - (a.score ?? 0));

    let remaining = availableAmount;
    let blocked = false;
    const steps: WaterfallStep[] = [];

    for (const tier of config.tiers) {
      const asset = tier.asset ?? invoice.token;

      if (blocked || tier.minimumAmount > remaining) {
        blocked = true;
        steps.push({
          recipient: tier.recipient,
          amount: 0n,
          asset,
          minimumAmount: tier.minimumAmount,
          satisfied: false,
        });
        continue;
      }

      remaining -= tier.minimumAmount;
      steps.push({
        recipient: tier.recipient,
        amount: tier.minimumAmount,
        asset,
        minimumAmount: tier.minimumAmount,
        satisfied: true,
      });
    }

    const totalAllocated = steps.reduce((sum, s) => sum + s.amount, 0n);
    return {
      steps,
      fullySatisfied: steps.every((s) => s.satisfied),
      totalAllocated,
      remaining,
      allowPartial: config.allowPartial,
    };
  }
}
