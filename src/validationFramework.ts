/** Composable validation framework with custom rules and result tracking. */

export interface ValidationIssue {
  rule: string;
  message: string;
}

export interface ValidationResult {
  valid: boolean;
  issues: ValidationIssue[];
}

export interface Validator<T> {
  name: string;
  /** Return true if valid, or a string / false for failure. */
  check(value: T): boolean | string;
}

export function rule<T>(name: string, check: (value: T) => boolean | string): Validator<T> {
  return { name, check };
}

export const validators = {
  required: <T>() => rule<T>("required", (v) => v !== undefined && v !== null && v !== "" || "value is required"),
  minLength: (n: number) => rule<string>("minLength", (v) => v.length >= n || `must be at least ${n} characters`),
  maxLength: (n: number) => rule<string>("maxLength", (v) => v.length <= n || `must be at most ${n} characters`),
  pattern: (re: RegExp) => rule<string>("pattern", (v) => re.test(v) || `must match ${re}`),
  range: (min: number, max: number) =>
    rule<number>("range", (v) => (v >= min && v <= max) || `must be between ${min} and ${max}`),
};

/** Compose validators: all must pass. */
export function all<T>(...vs: Validator<T>[]): Validator<T> {
  return {
    name: "all",
    check: (value) => {
      const msgs = vs.flatMap((v) => {
        const r = v.check(value);
        return r === true ? [] : [typeof r === "string" ? r : `${v.name} failed`];
      });
      return msgs.length === 0 || msgs.join("; ");
    },
  };
}

/** Compose validators: at least one must pass. */
export function any<T>(...vs: Validator<T>[]): Validator<T> {
  return {
    name: "any",
    check: (value) => vs.some((v) => v.check(value) === true) || "no alternative validator passed",
  };
}

export class ValidationRunner<T> {
  private rules: Validator<T>[] = [];
  private stats = { runs: 0, failures: 0, byRule: {} as Record<string, number> };

  add(...vs: Validator<T>[]): this {
    this.rules.push(...vs);
    return this;
  }

  validate(value: T): ValidationResult {
    const issues: ValidationIssue[] = [];
    for (const v of this.rules) {
      const r = v.check(value);
      if (r !== true) {
        issues.push({ rule: v.name, message: typeof r === "string" ? r : `${v.name} failed` });
        this.stats.byRule[v.name] = (this.stats.byRule[v.name] ?? 0) + 1;
      }
    }
    this.stats.runs++;
    if (issues.length) this.stats.failures++;
    return { valid: issues.length === 0, issues };
  }

  getStats() {
    return { ...this.stats, byRule: { ...this.stats.byRule } };
  }
}
