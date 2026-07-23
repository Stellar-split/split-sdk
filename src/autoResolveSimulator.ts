import type { Invoice, AutoResolveRule, AutoResolveSimulation } from "./types.js";

/**
 * Determine whether a single auto-resolve rule matches the funded amount.
 *
 * @param rule   - The rule to evaluate.
 * @param funded - The invoice's current funded amount in stroops.
 */
function ruleMatches(rule: AutoResolveRule, funded: bigint): boolean {
  const comparator = rule.comparator ?? "gte";
  return comparator === "lt"
    ? funded < rule.threshold
    : funded >= rule.threshold;
}

/**
 * Evaluate an invoice's `auto_resolve_rules` against its current funded amount
 * and report what action `auto_resolve()` would take if called now.
 *
 * Pure function — performs no RPC calls. Rules are evaluated in order and the
 * first match wins. When no rule's threshold is met, `wouldResolve` is false.
 *
 * @param invoice - The invoice to simulate.
 * @returns The simulated outcome.
 */
export function simulateAutoResolve(invoice: Invoice): AutoResolveSimulation {
  const rules = invoice.auto_resolve_rules ?? [];

  for (const rule of rules) {
    if (ruleMatches(rule, invoice.funded)) {
      return {
        wouldResolve: true,
        action: rule.action,
        matchedRule: rule,
      };
    }
  }

  return { wouldResolve: false, action: null, matchedRule: null };
}
