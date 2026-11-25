/**
 * SDK input validation framework.
 *
 * Composable validators with built-in rules, custom rule registration,
 * and validation tracking. Validators never throw on invalid input; they
 * return a structured result so callers can handle failures safely.
 */

export interface ValidationError {
  path: string;
  message: string;
  rule: string;
}

export interface ValidationResult<T = unknown> {
  valid: boolean;
  value?: T;
  errors: ValidationError[];
}

export interface Validator<T = unknown> {
  readonly name: string;
  validate(input: unknown, path?: string): ValidationResult<T>;
}

export interface ValidationRecord {
  validator: string;
  path: string;
  valid: boolean;
  timestamp: number;
}

const history: ValidationRecord[] = [];

function track(validator: string, path: string, valid: boolean): void {
  history.push({ validator, path, valid, timestamp: Date.now() });
}

export function getValidationHistory(): ValidationRecord[] {
  return history.slice();
}

export function clearValidationHistory(): void {
  history.length = 0;
}

function ok<T>(value: T): ValidationResult<T> {
  return { valid: true, value, errors: [] };
}

function fail<T>(path: string, rule: string, message: string): ValidationResult<T> {
  return { valid: false, errors: [{ path, rule, message }] };
}

function make<T>(name: string, check: (input: unknown, path: string) => ValidationResult<T>): Validator<T> {
  return {
    name,
    validate(input: unknown, path = '$'): ValidationResult<T> {
      const result = check(input, path);
      track(name, path, result.valid);
      return result;
    },
  };
}

export const string = (opts: { min?: number; max?: number; pattern?: RegExp } = {}): Validator<string> =>
  make('string', (input, path) => {
    if (typeof input !== 'string') return fail(path, 'string', 'Expected a string');
    if (opts.min !== undefined && input.length < opts.min) return fail(path, 'string', `Must be at least ${opts.min} characters`);
    if (opts.max !== undefined && input.length > opts.max) return fail(path, 'string', `Must be at most ${opts.max} characters`);
    if (opts.pattern && !opts.pattern.test(input)) return fail(path, 'string', 'Does not match required pattern');
    return ok(input);
  });

export const number = (opts: { min?: number; max?: number; integer?: boolean } = {}): Validator<number> =>
  make('number', (input, path) => {
    if (typeof input !== 'number' || Number.isNaN(input)) return fail(path, 'number', 'Expected a number');
    if (opts.integer && !Number.isInteger(input)) return fail(path, 'number', 'Expected an integer');
    if (opts.min !== undefined && input < opts.min) return fail(path, 'number', `Must be >= ${opts.min}`);
    if (opts.max !== undefined && input > opts.max) return fail(path, 'number', `Must be <= ${opts.max}`);
    return ok(input);
  });

export const address = (): Validator<string> =>
  make('address', (input, path) => {
    if (typeof input !== 'string' || !/^0x[0-9a-fA-F]{40}$/.test(input)) return fail(path, 'address', 'Invalid address');
    return ok(input);
  });

export const amount = (opts: { min?: number; max?: number } = {}): Validator<number> =>
  make('amount', (input, path) => {
    if (typeof input !== 'number' || !Number.isFinite(input) || input < 0) return fail(path, 'amount', 'Invalid amount');
    if (opts.min !== undefined && input < opts.min) return fail(path, 'amount', `Must be >= ${opts.min}`);
    if (opts.max !== undefined && input > opts.max) return fail(path, 'amount', `Must be <= ${opts.max}`);
    return ok(input);
  });

export const enumOf = <T extends string>(values: readonly T[]): Validator<T> =>
  make('enum', (input, path) => {
    if (typeof input !== 'string' || !values.includes(input as T)) return fail(path, 'enum', `Must be one of: ${values.join(', ')}`);
    return ok(input as T);
  });

export const optional = <T>(validator: Validator<T>): Validator<T | undefined> =>
  make(`optional(${validator.name})`, (input, path) => {
    if (input === undefined || input === null) return ok(undefined);
    return validator.validate(input, path);
  });

export const allOf = <T>(...validators: Validator<T>[]): Validator<T> =>
  make('allOf', (input, path) => {
    const errors: ValidationError[] = [];
    let value: T | undefined;
    for (const v of validators) {
      const r = v.validate(input, path);
      if (!r.valid) errors.push(...r.errors);
      else value = r.value;
    }
    return errors.length ? { valid: false, errors } : ok(value as T);
  });

export const arrayOf = <T>(validator: Validator<T>): Validator<T[]> =>
  make('arrayOf', (input, path) => {
    if (!Array.isArray(input)) return fail(path, 'arrayOf', 'Expected an array');
    const errors: ValidationError[] = [];
    const value: T[] = [];
    input.forEach((item, i) => {
      const r = validator.validate(item, `${path}[${i}]`);
      if (r.valid) value.push(r.value as T);
      else errors.push(...r.errors);
    });
    return errors.length ? { valid: false, errors } : ok(value);
  });

export const objectOf = <T extends Record<string, unknown>>(
  shape: { [K in keyof T]: Validator<T[K]> },
): Validator<T> =>
  make('objectOf', (input, path) => {
    if (typeof input !== 'object' || input === null || Array.isArray(input)) return fail(path, 'objectOf', 'Expected an object');
    const errors: ValidationError[] = [];
    const value = {} as T;
    for (const key of Object.keys(shape) as (keyof T)[]) {
      const r = shape[key].validate((input as Record<string, unknown>)[key as string], `${path}.${String(key)}`);
      if (r.valid) value[key] = r.value as T[keyof T];
      else errors.push(...r.errors);
    }
    return errors.length ? { valid: false, errors } : ok(value);
  });

const customRules = new Map<string, (input: unknown) => boolean>();

export function registerRule(name: string, predicate: (input: unknown) => boolean): void {
  customRules.set(name, predicate);
}

export const custom = (name: string, message = `Failed rule: ${name}`): Validator<unknown> =>
  make(`custom(${name})`, (input, path) => {
    const predicate = customRules.get(name);
    if (!predicate) return fail(path, name, `Unknown rule: ${name}`);
    return predicate(input) ? ok(input) : fail(path, name, message);
  });
