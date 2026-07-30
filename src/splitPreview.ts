import type { Invoice, SplitRule, SplitPreviewEntry } from "./types.js";
import { deduplicateRecipients } from "./validators/recipientDeduplicator.js";
import type { RecipientShare, SplitConfig } from "./validators/splitRatioValidator.js";

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
  const deduped = deduplicateRecipients(invoice.recipients, "merge");
  const totalOwed = deduped.reduce((sum, r) => sum + r.amount, 0n);
  const denominator = totalOwed === 0n ? 1n : totalOwed;
  return deduped.map((r) => ({
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

// ---------------------------------------------------------------------------
// Issue #545 — Split Config Diff Generator
// ---------------------------------------------------------------------------

/**
 * A single recipient that changed their ratio between two {@link SplitConfig}
 * objects.
 */
export interface ChangedShare {
  /** The recipient address whose ratio changed. */
  accountId: string;
  /** Share value in the original config. */
  oldRatio: number;
  /** Share value in the revised config. */
  newRatio: number;
}

/**
 * Typed diff between two {@link SplitConfig} objects.
 *
 * - `added`          — recipients present in `revised` but not in `original`.
 * - `removed`        — recipients present in `original` but not in `revised`.
 * - `changed`        — recipients present in both with a different ratio.
 * - `totalRatioDelta`— signed difference of the sums of all shares
 *                      (`revisedSum − originalSum`).  Should be 0 for a valid
 *                      rebalance.
 */
export interface SplitConfigDiff {
  /** Recipients that were added in the revised config. */
  added: RecipientShare[];
  /** Recipients that were removed from the original config. */
  removed: RecipientShare[];
  /** Recipients present in both configs whose ratio changed. */
  changed: ChangedShare[];
  /**
   * Signed difference between the sum of all shares in the revised config
   * and the sum of all shares in the original config.
   * For a valid split re-balance this should equal 0.
   */
  totalRatioDelta: number;
}

/**
 * Generate a structured diff between two {@link SplitConfig} split
 * configurations.
 *
 * Pure function — performs no RPC calls or side effects.
 *
 * @param original - The existing / before split configuration.
 * @param revised  - The proposed / after split configuration.
 * @returns A {@link SplitConfigDiff} describing what changed.
 *
 * @example
 * ```ts
 * const diff = generateSplitDiff(original, revised);
 * console.log(diff.added, diff.removed, diff.changed, diff.totalRatioDelta);
 * ```
 */
export function generateSplitDiff(
  original: SplitConfig,
  revised: SplitConfig,
): SplitConfigDiff {
  // Build lookup maps keyed by address for O(1) access
  const origMap = new Map<string, RecipientShare>(
    original.shares.map((s) => [s.address, s]),
  );
  const revMap = new Map<string, RecipientShare>(
    revised.shares.map((s) => [s.address, s]),
  );

  const added: RecipientShare[] = [];
  const removed: RecipientShare[] = [];
  const changed: ChangedShare[] = [];

  // Identify added and changed
  for (const [address, revShare] of revMap) {
    const origShare = origMap.get(address);
    if (origShare === undefined) {
      added.push(revShare);
    } else if (origShare.share !== revShare.share) {
      changed.push({
        accountId: address,
        oldRatio: origShare.share,
        newRatio: revShare.share,
      });
    }
  }

  // Identify removed
  for (const [address, origShare] of origMap) {
    if (!revMap.has(address)) {
      removed.push(origShare);
    }
  }

  // Compute signed total ratio delta
  const originalSum = original.shares.reduce((acc, s) => acc + s.share, 0);
  const revisedSum = revised.shares.reduce((acc, s) => acc + s.share, 0);
  const totalRatioDelta = revisedSum - originalSum;

  return { added, removed, changed, totalRatioDelta };
}
