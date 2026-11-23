/** Feature flag registry with conditional evaluation and usage tracking. */

export type FlagContext = Record<string, string | number | boolean | undefined>;

export type FlagOperator = "eq" | "neq" | "in" | "gt" | "lt";

export interface FlagCondition {
  attribute: string;
  operator: FlagOperator;
  value: unknown;
}

export interface FeatureFlagDefinition {
  key: string;
  enabled: boolean;
  /** All conditions must match for the flag to be on. */
  conditions?: FlagCondition[];
}

export interface FlagEvaluation {
  key: string;
  enabled: boolean;
  reason: "unknown" | "disabled" | "condition_failed" | "matched";
}

export function evaluateCondition(c: FlagCondition, ctx: FlagContext): boolean {
  const actual = ctx[c.attribute];
  switch (c.operator) {
    case "eq":
      return actual === c.value;
    case "neq":
      return actual !== c.value;
    case "in":
      return Array.isArray(c.value) && c.value.includes(actual);
    case "gt":
      return typeof actual === "number" && typeof c.value === "number" && actual > c.value;
    case "lt":
      return typeof actual === "number" && typeof c.value === "number" && actual < c.value;
  }
}

export class FeatureFlagManager {
  private flags = new Map<string, FeatureFlagDefinition>();
  private counts = new Map<string, { evaluations: number; enabled: number }>();

  constructor(definitions: FeatureFlagDefinition[] = []) {
    definitions.forEach((d) => this.register(d));
  }

  register(def: FeatureFlagDefinition): void {
    this.flags.set(def.key, def);
  }

  remove(key: string): boolean {
    return this.flags.delete(key);
  }

  list(): FeatureFlagDefinition[] {
    return [...this.flags.values()];
  }

  evaluate(key: string, ctx: FlagContext = {}): FlagEvaluation {
    const def = this.flags.get(key);
    let result: FlagEvaluation;
    if (!def) result = { key, enabled: false, reason: "unknown" };
    else if (!def.enabled) result = { key, enabled: false, reason: "disabled" };
    else if (!(def.conditions ?? []).every((c) => evaluateCondition(c, ctx)))
      result = { key, enabled: false, reason: "condition_failed" };
    else result = { key, enabled: true, reason: "matched" };

    const s = this.counts.get(key) ?? { evaluations: 0, enabled: 0 };
    s.evaluations++;
    if (result.enabled) s.enabled++;
    this.counts.set(key, s);
    return result;
  }

  isEnabled(key: string, ctx?: FlagContext): boolean {
    return this.evaluate(key, ctx).enabled;
  }

  /** Per-flag evaluation counts. */
  getUsage(key: string): { evaluations: number; enabled: number } {
    return { ...(this.counts.get(key) ?? { evaluations: 0, enabled: 0 }) };
  }
}
