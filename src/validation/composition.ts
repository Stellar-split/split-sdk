/**
 * SDK input validation framework — composition helpers.
 *
 * Provides a small, dependency-free validator abstraction plus safe
 * composition primitives (allOf / anyOf / object / array / optional).
 * Every validator returns a structured result so callers can track
 * validation outcomes without throwing on invalid input.
 */

export interface ValidationIssue {
  path: string;
  message: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  issues: ValidationIssue[];
}

export interface Validator<T> {
  readonly name: string;
  validate(input: unknown, path?: string): ValidationResult<T>;
}

export type ValidatorMap = Record<string, Validator<unknown>>;

export interface ValidationTracker {
  record(validator: string, result: ValidationResult<unknown>): void;
  stats(): Record<string, { runs: number; failures: number }>;
}

function ok<T>(value: T): ValidationResult<T> {
  return { ok: true, value, issues: [] };
}

function fail<T>(path: string, message: string): ValidationResult<T> {
  return { ok: false, issues: [{ path, message }] };
}

function joinPath(base: string, key: string | number): string {
  if (typeof key === 'number') return `${base}[${key}]`;
  return base ? `${base}.${key}` : key;
}

/**
 * Create a validator from a predicate. Custom rules are just validators,
 * so they compose with the built-ins below.
 */
export function rule<T>(
  name: string,
  check: (input: unknown) => input is T,
  message = `invalid ${name}`,
): Validator<T> {
  return {
    name,
    validate(input, path = '') {
      return check(input) ? ok(input) : fail<T>(path, message);
    },
  };
}

/**
 * Registry for custom rules. Registration is explicit and namespaced so
 * user-supplied rules cannot silently shadow built-ins.
 */
export class RuleRegistry {
  private readonly rules = new Map<string, Validator<unknown>>();

  register<T>(validator: Validator<T>): this {
    if (this.rules.has(validator.name)) {
      throw new Error(`validator already registered: ${validator.name}`);
    }
    this.rules.set(validator.name, validator as Validator<unknown>);
    return this;
  }

  get(name: string): Validator<unknown> | undefined {
    return this.rules.get(name);
  }

  has(name: string): boolean {
    return this.rules.has(name);
  }
}

/**
 * In-memory tracker so callers can observe how often each validator runs
 * and how often it rejects input.
 */
export class InMemoryTracker implements ValidationTracker {
  private readonly counts = new Map<string, { runs: number; failures: number }>();

  record(validator: string, result: ValidationResult<unknown>): void {
    const entry = this.counts.get(validator) ?? { runs: 0, failures: 0 };
    entry.runs += 1;
    if (!result.ok) entry.failures += 1;
    this.counts.set(validator, entry);
  }

  stats(): Record<string, { runs: number; failures: number }> {
    return Object.fromEntries(this.counts);
  }
}

/** Run a validator and record the outcome when a tracker is supplied. */
export function tracked<T>(
  validator: Validator<T>,
  tracker: ValidationTracker,
): Validator<T> {
  return {
    name: validator.name,
    validate(input, path = '') {
      const result = validator.validate(input, path);
      tracker.record(validator.name, result as ValidationResult<unknown>);
      return result;
    },
  };
}

/** All validators must pass; the first failure short-circuits. */
export function allOf<T>(...validators: Validator<unknown>[]): Validator<T> {
  return {
    name: `allOf(${validators.map((v) => v.name).join(',')})`,
    validate(input, path = '') {
      for (const validator of validators) {
        const result = validator.validate(input, path);
        if (!result.ok) return { ok: false, issues: result.issues };
      }
      return ok(input as T);
    },
  };
}

/** At least one validator must pass; issues are merged on failure. */
export function anyOf<T>(...validators: Validator<unknown>[]): Validator<T> {
  return {
    name: `anyOf(${validators.map((v) => v.name).join(',')})`,
    validate(input, path = '') {
      const issues: ValidationIssue[] = [];
      for (const validator of validators) {
        const result = validator.validate(input, path);
        if (result.ok) return ok(result.value as T);
        issues.push(...result.issues);
      }
      return { ok: false, issues };
    },
  };
}

/** Allow `undefined`/`null` to pass through untouched. */
export function optional<T>(validator: Validator<T>): Validator<T | undefined> {
  return {
    name: `optional(${validator.name})`,
    validate(input, path = '') {
      if (input === undefined || input === null) return ok(undefined);
      return validator.validate(input, path);
    },
  };
}

/** Validate each element of an array with the given element validator. */
export function array<T>(element: Validator<T>): Validator<T[]> {
  return {
    name: `array(${element.name})`,
    validate(input, path = '') {
      if (!Array.isArray(input)) return fail<T[]>(path, 'expected array');
      const values: T[] = [];
      const issues: ValidationIssue[] = [];
      input.forEach((item, index) => {
        const result = element.validate(item, joinPath(path, index));
        if (result.ok) values.push(result.value as T);
        else issues.push(...result.issues);
      });
      return issues.length ? { ok: false, issues } : ok(values);
    },
  };
}

/**
 * Validate an object against a schema. Unknown keys are rejected so that
 * unexpected input cannot be smuggled through to downstream consumers.
 */
export function object<S extends ValidatorMap>(
  schema: S,
): Validator<{ [K in keyof S]: unknown }> {
  return {
    name: `object(${Object.keys(schema).join(',')})`,
    validate(input, path = '') {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return fail(path, 'expected object');
      }
      const source = input as Record<string, unknown>;
      const issues: ValidationIssue[] = [];
      const value: Record<string, unknown> = {};

      for (const key of Object.keys(source)) {
        if (!(key in schema)) {
          issues.push({ path: joinPath(path, key), message: 'unknown field' });
        }
      }

      for (const [key, validator] of Object.entries(schema)) {
        const result = validator.validate(source[key], joinPath(path, key));
        if (result.ok) value[key] = result.value;
        else issues.push(...result.issues);
      }

      return issues.length ? { ok: false, issues } : ok(value as { [K in keyof S]: unknown });
    },
  };
}
