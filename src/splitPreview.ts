import type { Invoice, SplitRule, SplitPreviewEntry } from "./types.js";

/**
 * Apply a single {@link SplitRule} against a funded amount.
 *
 * @param rule      - The split rule to evaluate.
 * @param funded    - The hypothetical total funded amount in stroops.
 * @param remaining - Funds still unallocated by earlier rules (used by Fixed).
 * @returns The amount this rule's recipient would receive, in stroops.
 */
function applyRule(rule: SplitRule, funded: bigint, remaining: bigint): bigint {
  switch (rule.kind) {
    case "Fixed": {
      const amount = rule.amount < 0n ? 0n : rule.amount;
      return amount > remaining ? remaining : amount;
    }
    case "Percentage": {
      const bps = BigInt(Math.max(0, Math.trunc(rule.bps)));
      return (funded * bps) / 10_000n;
    }
    case "Tiered": {
      let total = 0n;
      let lower = 0n;
      for (const tier of rule.tiers) {
        const upper = tier.upTo;
        if (funded <= lower) break;
        const bandTop = funded < upper ? funded : upper;
        if (bandTop > lower) {
          const bps = BigInt(Math.max(0, Math.trunc(tier.bps)));
          total += ((bandTop - lower) * bps) / 10_000n;
        }
        lower = upper;
      }
      return total;
    }
  }
}

/**
 * Distribute a funded amount proportionally across the invoice recipients,
 * used as a fallback when no split rules are configured.
 */
function proportionalFallback(
  invoice: Invoice,
  funded: bigint
): SplitPreviewEntry[] {
  const totalOwed = invoice.recipients.reduce((sum, r) => sum + r.amount, 0n);
  const denominator = totalOwed === 0n ? 1n : totalOwed;
  return invoice.recipients.map((r) => ({
    recipient: r.address,
    amount: (funded * r.amount) / denominator,
  }));
}

/**
 * Simulate what each recipient would receive at release for a hypothetical
 * funded amount, given the invoice's `split_rules` configuration.
 *
 * Pure function — performs no RPC calls. Handles the `Fixed`, `Percentage`, and
 * `Tiered` rule variants, and falls back to a proportional split over
 * `recipients[]` when `split_rules` is empty or undefined.
 *
 * @param invoice      - The invoice whose split configuration to apply.
 * @param fundedAmount - The hypothetical total funded amount in stroops.
 * @returns Previewed payouts in rule (or recipient) order.
 */
export function previewSplitRules(
  invoice: Invoice,
  fundedAmount: bigint
): SplitPreviewEntry[] {
  const rules = invoice.split_rules ?? [];
  if (rules.length === 0) {
    return proportionalFallback(invoice, fundedAmount);
  }

  const entries: SplitPreviewEntry[] = [];
  let remaining = fundedAmount < 0n ? 0n : fundedAmount;
  for (const rule of rules) {
    const amount = applyRule(rule, fundedAmount, remaining);
    remaining -= amount;
    if (remaining < 0n) remaining = 0n;
    entries.push({ recipient: rule.recipient, amount });
  }
  return entries;
}
