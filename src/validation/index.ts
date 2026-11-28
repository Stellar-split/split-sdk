/**
 * SDK input validation framework.
 *
 * Provides a small, composable validation system:
 * - `Validator<T>` interface with a `validate` method returning a `ValidationResult<T>`.
 * - Built-in validators for common SDK inputs (string, number, address, amount, enum).
 * - Custom rule registration via `registerRule` / `createRule`.
 * - Safe composition helpers (`allOf`, `object`, `array`, `optional`).
 * - Validation tracking via `ValidationTracker`.
 *
 * All validators are pure and never throw on invalid input; they return a
 * result object so callers can handle failures explicitly. This prevents
 * injection by rejecting unexpected shapes/values before they reach the SDK.
 */

export interface ValidationError {
  /** Dotted path to the offending field (empty for root). */
  path: string;
  /** Human-readable message. */
  message: string;
  /** Machine-readable rule code. */
  code: string;
}

export interface ValidationResult<T> {
  ok: boolean;
  value?: T;
  errors: ValidationError[];
}

export interface Validator<T> {
  validate(input: unknown, path?: string): ValidationResult<T>;
}

export type Rule<T> = (input: unknown) => ValidationResult<T>;

const ok = <T>(value: T): ValidationResult<T> => ({ ok: true, value, errors: [] });

const fail = <T>(path: string, code: string, message: string): ValidationResult<T> => ({
  ok: false,
  errors: [{ path, code, message }],
});

const joinPath = (base: string, key: string | number): string =>
  base ? `${base}.${key}` : String(key);

/** Wrap a plain rule function into a `Validator`. */
export function createValidator<T>(rule: Rule<T>): Validator<T> {
  return {
    validate(input: unknown, path = ''): ValidationResult<T> {
      const result = rule(input);
      if (result.ok) return result;
      return {
        ok: false,
        errors: result.errors.map((e) => ({ ...e, path: e.path || path })),
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Custom rule registry
// ---------------------------------------------------------------------------

const customRules = new Map<string, Rule<unknown>>();

/** Register a named custom rule usable via `rule(name)`. */
export function registerRule<T>(name: string, rule: Rule<T>): void {
  if (!name) throw new Error('Rule name is required');
  customRules.set(name, rule as Rule<unknown>);
}

/** Look up a registered custom rule and wrap it as a validator. */
export function rule<T = unknown>(name: string): Validator<T> {
  const found = customRules.get(name);
  if (!found) throw new Error(`Unknown validation rule: ${name}`);
  return createValidator<T>(found as Rule<T>);
}

// ---------------------------------------------------------------------------
// Built-in validators
// ---------------------------------------------------------------------------

export interface StringOptions {
  minLength?: number;
  maxLength?: number;
  pattern?: RegExp;
  /** Reject control characters and other injection-prone content. */
  noControlChars?: boolean;
}

export function string(options: StringOptions = {}): Validator<string> {
  return createValidator<string>((input) => {
    if (typeof input !== 'string') return fail('', 'string.type', 'Expected a string');
    if (options.minLength !== undefined && input.length < options.minLength) {
      return fail('', 'string.minLength', `Must be at least ${options.minLength} characters`);
    }
    if (options.maxLength !== undefined && input.length > options.maxLength) {
      return fail('', 'string.maxLength', `Must be at most ${options.maxLength} characters`);
    }
    if (options.pattern && !options.pattern.test(input)) {
      return fail('', 'string.pattern', 'Value does not match required pattern');
    }
    if (options.noControlChars && /[\u0000-\u001f\u007f]/.test(input)) {
      return fail('', 'string.controlChars', 'Value contains control characters');
    }
    return ok(input);
  });
}

export interface NumberOptions {
  min?: number;
  max?: number;
  integer?: boolean;
}

export function number(options: NumberOptions = {}): Validator<number> {
  return createValidator<number>((input) => {
    if (typeof input !== 'number' || !Number.isFinite(input)) {
      return fail('', 'number.type', 'Expected a finite number');
    }
    if (options.integer && !Number.isInteger(input)) {
      return fail('', 'number.integer', 'Expected an integer');
    }
    if (options.min !== undefined && input < options.min) {
      return fail('', 'number.min', `Must be at least ${options.min}`);
    }
    if (options.max !== undefined && input > options.max) {
      return fail('', 'number.max', `Must be at most ${options.max}`);
    }
    return ok(input);
  });
}

const ADDRESS_PATTERN = /^0x[0-9a-fA-F]{40}$/;

/** Validate a hex EVM-style address. */
export function address(): Validator<string> {
  return createValidator<string>((input) => {
    if (typeof input !== 'string') return fail('', 'address.type', 'Expected a string');
    if (!ADDRESS_PATTERN.test(input)) {
      return fail('', 'address.format', 'Invalid address format');
    }
    return ok(input);
  });
}

export interface AmountOptions {
  min?: bigint;
  max?: bigint;
}

/** Validate a non-negative integer amount (bigint or numeric string). */
export function amount(options: AmountOptions = {}): Validator<bigint> {
  return createValidator<bigint>((input) => {
    let value: bigint;
    if (typeof input === 'bigint') {
      value = input;
    } else if (typeof input === 'string' && /^\d+$/.test(input)) {
      value = BigInt(input);
    } else if (typeof input === 'number' && Number.isInteger(input) && input >= 0) {
      value = BigInt(input);
    } else {
      return fail('', 'amount.type', 'Expected a non-negative integer amount');
    }
    if (value < 0n) return fail('', 'amount.negative', 'Amount must not be negative');
    if (options.min !== undefined && value < options.min) {
      return fail('', 'amount.min', `Amount must be at least ${options.min}`);
    }
    if (options.max !== undefined && value > options.max) {
      return fail('', 'amount.max', `Amount must be at most ${options.max}`);
    }
    return ok(value);
  });
}

/** Validate that input is one of the allowed enum values. */
export function enumOf<T extends string | number>(values: readonly T[]): Validator<T> {
  const allowed = new Set<unknown>(values);
  return createValidator<T>((input) => {
    if (!allowed.has(input)) {
      return fail('', 'enum.value', `Expected one of: ${values.join(', ')}`);
    }
    return ok(input as T);
  });
}

// ---------------------------------------------------------------------------
// Composition
// ---------------------------------------------------------------------------

/** Run all validators; succeed only if every one succeeds. */
export function allOf<T>(...validators: Validator<unknown>[]): Validator<T> {
  return {
    validate(input: unknown, path = ''): ValidationResult<T> {
      const errors: ValidationError[] = [];
      for (const v of validators) {
        const result = v.validate(input, path);
        if (!result.ok) errors.push(...result.errors);
      }
      if (errors.length > 0) return { ok: false, errors };
      return ok(input as T);
    },
  };
}

export type Shape = Record<string, Validator<unknown>>;

export type InferShape<S extends Shape> = {
  [K in keyof S]: S[K] extends Validator<infer T> ? T : never;
};

/** Validate an object against a shape of validators. Unknown keys are rejected. */
export function object<S extends Shape>(shape: S): Validator<InferShape<S>> {
  const keys = Object.keys(shape);
  return {
    validate(input: unknown, path = ''): ValidationResult<InferShape<S>> {
      if (typeof input !== 'object' || input === null || Array.isArray(input)) {
        return fail(path, 'object.type', 'Expected an object');
      }
      const source = input as Record<string, unknown>;
      const errors: ValidationError[] = [];
      const output: Record<string, unknown> = {};

      for (const key of Object.keys(source)) {
        if (!keys.includes(key)) {
          errors.push({
            path: joinPath(path, key),
            code: 'object.unknownKey',
            message: `Unexpected key: ${key}`,
          });
        }
      }

      for (const key of keys) {
        const result = shape[key]!.validate(source[key], joinPath(path, key));
        if (result.ok) {
          output[key] = result.value;
        } else {
          errors.push(...result.errors);
        }
      }

      if (errors.length > 0) return { ok: false, errors };
      return ok(output as InferShape<S>);
    },
  };
}

/** Validate an array where every element matches the given validator. */
export function array<T>(item: Validator<T>, options: { minLength?: number; maxLength?: number } = {}): Validator<T[]> {
  return {
    validate(input: unknown, path = ''): ValidationResult<T[]> {
      if (!Array.isArray(input)) return fail(path, 'array.type', 'Expected an array');
      if (options.minLength !== undefined && input.length < options.minLength) {
        return fail(path, 'array.minLength', `Must have at least ${options.minLength} items`);
      }
      if (options.maxLength !== undefined && input.length > options.maxLength) {
        return fail(path, 'array.maxLength', `Must have at most ${options.maxLength} items`);
      }
      const errors: ValidationError[] = [];
      const output: T[] = [];
      input.forEach((entry, index) => {
        const result = item.validate(entry, joinPath(path, index));
        if (result.ok) output.push(result.value as T);
        else errors.push(...result.errors);
      });
      if (errors.length > 0) return { ok: false, errors };
      return ok(output);
    },
  };
}

/** Allow `undefined`/`null` to pass through as `undefined`. */
export function optional<T>(validator: Validator<T>): Validator<T | undefined> {
  return {
    validate(input: unknown, path = ''): ValidationResult<T | undefined> {
      if (input === undefined || input === null) return ok(undefined);
      return validator.validate(input, path);
    },
  };
}

// ---------------------------------------------------------------------------
// Tracking
// ---------------------------------------------------------------------------

export interface ValidationRecord {
  path: string;
  ok: boolean;
  errors: ValidationError[];
  timestamp: number;
}

/** Records validation outcomes for observability/debugging. */
export class ValidationTracker {
  private readonly records: ValidationRecord[] = [];

  /** Wrap a validator so each run is recorded. */
  track<T>(validator: Validator<T>): Validator<T> {
    return {
      validate: (input: unknown, path = ''): ValidationResult<T> => {
        const result = validator.validate(input, path);
        this.records.push({
          path,
          ok: result.ok,
          errors: result.errors,
          timestamp: Date.now(),
        });
        return result;
      },
    };
  }

  getRecords(): readonly ValidationRecord[] {
    return this.records;
  }

  getFailures(): readonly ValidationRecord[] {
    return this.records.filter((r) => !r.ok);
  }

  clear(): void {
    this.records.length = 0;
  }
}
