/**
 * Deadline validator for StellarSplit invoices and time-locked operations.
 *
 * Invoices and contract operations require deadlines expressed as Unix
 * timestamps in seconds (Soroban `u64`). Submitting past, malformed, or
 * unrealistic deadlines can cause transaction panics, unfulfillable contracts,
 * or immediate invoice expiration.
 *
 * This module enforces strict validation rules:
 * 1. Format check: Ensures input is a valid timestamp, Date, or date string
 *    within valid 64-bit unsigned integer bounds (`1 <= deadline <= 2^64 - 1`).
 * 2. Millisecond normalization: Automatically detects millisecond timestamps
 *    (e.g., JS `Date.now()`) and converts them to seconds.
 * 3. Future requirement: Enforces that the deadline is strictly in the future
 *    relative to a reference time (wall-clock or caller-injected).
 * 4. Lead time constraint: Validates optional minimum lead time into the future
 *    (e.g., minimum 1 hour lead time).
 * 5. Upper bound constraint: Validates optional maximum allowable duration into
 *    the future to prevent absurdly distant deadlines.
 *
 * @example
 * ```ts
 * import { validateDeadline, validateDeadlineOrThrow } from "@stellar-split/sdk";
 *
 * // Validating a Date
 * const result = validateDeadline(new Date(Date.now() + 86400 * 1000));
 * if (result.valid) {
 *   console.log("Deadline in seconds:", result.deadlineSeconds);
 * }
 *
 * // Throwing on invalid or past deadline
 * const deadlineSec = validateDeadlineOrThrow(Date.now() + 3600 * 1000, {
 *   minLeadSeconds: 1800, // at least 30 minutes in future
 * });
 * ```
 */

import { DeadlineValidationError } from "../errors.js";

/** Maximum value of an unsigned 64-bit integer (`u64` max). */
export const MAX_U64 = 18_446_744_073_709_551_615n;

/**
 * Threshold above which a timestamp is assumed to be in milliseconds rather
 * than seconds (10^11 seconds corresponds to November 5138).
 */
export const MS_TIMESTAMP_THRESHOLD = 100_000_000_000n;

/** Result object returned by {@link validateDeadline}. */
export interface DeadlineValidationResult {
  /** True when the deadline passes all format and future constraints. */
  valid: boolean;
  /** List of human-readable validation error messages. */
  errors: string[];
  /** The normalized deadline as a Unix timestamp in seconds (`bigint`), if valid. */
  deadlineSeconds?: bigint;
}

/** A single recorded deadline validation attempt. */
export interface DeadlineValidationRecord {
  /** The raw input that was validated. */
  input: unknown;
  /** The normalized deadline in seconds, if parsing succeeded. */
  deadlineSeconds?: bigint;
  /** The reference time (seconds) used for the future check. */
  referenceSeconds: bigint;
  /** Whether the validation passed. */
  valid: boolean;
  /** The error messages produced, if any. */
  errors: string[];
  /** Wall-clock time (ms since epoch) at which the validation occurred. */
  timestamp: number;
}

/** Aggregate statistics over all recorded deadline validations. */
export interface DeadlineValidationStats {
  /** Total number of validations recorded. */
  total: number;
  /** Number of validations that passed. */
  valid: number;
  /** Number of validations that failed. */
  invalid: number;
  /** Number of failures caused by past or non-future deadlines. */
  pastDeadlineFailures: number;
  /** Number of failures caused by unparsable / malformed input. */
  formatFailures: number;
}

const validationHistory: DeadlineValidationRecord[] = [];

/**
 * Return aggregate statistics for all deadline validations performed so far.
 */
export function getDeadlineValidationStats(): DeadlineValidationStats {
  let valid = 0;
  let pastDeadlineFailures = 0;
  let formatFailures = 0;
  for (const record of validationHistory) {
    if (record.valid) {
      valid++;
    } else {
      if (record.deadlineSeconds === undefined) {
        formatFailures++;
      } else if (record.errors.some((e) => e.includes("must be in the future"))) {
        pastDeadlineFailures++;
      }
    }
  }
  return {
    total: validationHistory.length,
    valid,
    invalid: validationHistory.length - valid,
    pastDeadlineFailures,
    formatFailures,
  };
}

/**
 * Clear all recorded deadline validations.
 */
export function resetDeadlineValidationStats(): void {
  validationHistory.length = 0;
}
=======

/** Options for configuring deadline validation behavior. */
export interface DeadlineValidationOptions {
  /**
   * Reference time to measure against.
   * Defaults to the current wall-clock time (`Date.now()`).
   */
  referenceTime?: bigint | number | Date;
  /**
   * Minimum required lead time in seconds into the future.
   * If set, `deadline >= referenceTime + minLeadSeconds` is required.
   * Defaults to 0 (meaning `deadline > referenceTime`).
   */
  minLeadSeconds?: number;
  /**
   * Maximum allowable future duration in seconds from referenceTime.
   * If set, `deadline <= referenceTime + maxFutureSeconds` is required.
   */
  maxFutureSeconds?: number;
  /**
   * Whether to automatically detect and convert millisecond timestamps to seconds.
   * Defaults to true.
   */
  autoConvertMs?: boolean;
}

/**
 * Convert a reference time input into a normalized Unix timestamp in seconds (`bigint`).
 */
function toReferenceSeconds(ref?: bigint | number | Date, autoConvertMs: boolean = true): bigint {
  if (ref === undefined || ref === null) {
    return BigInt(Math.floor(Date.now() / 1000));
  }
  if (ref instanceof Date) {
    return BigInt(Math.floor(ref.getTime() / 1000));
  }
  if (typeof ref === "bigint") {
    if (autoConvertMs && ref >= MS_TIMESTAMP_THRESHOLD) {
      return ref / 1000n;
    }
    return ref;
  }
  if (typeof ref === "number") {
    if (!Number.isFinite(ref)) {
      return BigInt(Math.floor(Date.now() / 1000));
    }
    if (autoConvertMs && ref >= Number(MS_TIMESTAMP_THRESHOLD)) {
      return BigInt(Math.floor(ref / 1000));
    }
    return BigInt(Math.floor(ref));
  }
  return BigInt(Math.floor(Date.now() / 1000));
}

/**
 * Parse an unknown input into a Unix timestamp in seconds as a `bigint`.
 *
 * Supports `bigint`, `number`, `Date`, and string representations (ISO-8601 or numeric).
 *
 * @param input - The raw deadline input.
 * @param autoConvertMs - Whether to convert timestamps >= 10^11 from ms to seconds. Defaults to true.
 * @returns Normalized seconds timestamp as `bigint`.
 * @throws {DeadlineValidationError} If input cannot be parsed into a valid timestamp.
 */
export function parseDeadline(input: unknown, autoConvertMs: boolean = true): bigint {
  if (input === null || input === undefined) {
    throw new DeadlineValidationError("Deadline value is required (received null or undefined).", {
      input,
    });
  }

  if (typeof input === "bigint") {
    if (autoConvertMs && input >= MS_TIMESTAMP_THRESHOLD) {
      return input / 1000n;
    }
    return input;
  }

  if (typeof input === "number") {
    if (!Number.isFinite(input)) {
      throw new DeadlineValidationError(
        `Deadline must be a finite number (received ${String(input)}).`,
        { input }
      );
    }
    if (autoConvertMs && input >= Number(MS_TIMESTAMP_THRESHOLD)) {
      return BigInt(Math.floor(input / 1000));
    }
    return BigInt(Math.floor(input));
  }

  if (input instanceof Date) {
    const ms = input.getTime();
    if (!Number.isFinite(ms)) {
      throw new DeadlineValidationError("Deadline Date is invalid (NaN timestamp).", {
        input: input.toString(),
      });
    }
    return BigInt(Math.floor(ms / 1000));
  }

  if (typeof input === "string") {
    const trimmed = input.trim();
    if (trimmed.length === 0) {
      throw new DeadlineValidationError("Deadline string cannot be empty.", { input });
    }

    // Check if it is a pure integer string (Unix timestamp in seconds or ms)
    if (/^[+-]?\d+$/.test(trimmed)) {
      try {
        const val = BigInt(trimmed);
        if (autoConvertMs && val >= MS_TIMESTAMP_THRESHOLD) {
          return val / 1000n;
        }
        return val;
      } catch {
        // Fall through to Date.parse
      }
    }

    // ISO-8601 strings with an explicit timezone designator (Z or ±HH:MM / ±HHMM)
    // are interpreted as absolute instants and normalized to UTC seconds.
    // Timezone-less strings (e.g. "2030-01-01T00:00:00") are parsed by
    // `Date.parse` using the host's local timezone; we normalize the resulting
    // instant to UTC seconds so behavior is consistent across callers.
    const parsedMs = Date.parse(trimmed);
    if (Number.isFinite(parsedMs)) {
      return BigInt(Math.floor(parsedMs / 1000));
    }

    throw new DeadlineValidationError(
      `Invalid deadline string format: "${input}". Must be a Unix timestamp or ISO-8601 date string.`,
      { input }
    );
  }

  throw new DeadlineValidationError(
    `Unsupported deadline type: expected bigint, number, Date, or date string (received ${typeof input}).`,
    { input }
  );
}

/**
 * Validate a deadline against format, range, and future constraints.
 *
 * Validation checks:
 * 1. Format: Must be parsable as a Unix timestamp or Date.
 * 2. Range: Must be positive (> 0) and fit within unsigned 64-bit integer (`u64`).
 * 3. Future requirement: Must be strictly in the future relative to `referenceTime`.
 * 4. Lead time: If `minLeadSeconds` is specified, `deadline >= referenceTime + minLeadSeconds`.
 * 5. Max duration: If `maxFutureSeconds` is specified, `deadline <= referenceTime + maxFutureSeconds`.
 *
 * @param deadline - The deadline to validate (bigint, number, Date, or string).
 * @param options - Optional validation options.
 * @returns A {@link DeadlineValidationResult} containing validity status, normalized seconds, and errors.
 */
export function validateDeadline(
  deadline: unknown,
  options?: DeadlineValidationOptions
): DeadlineValidationResult {
  const errors: string[] = [];
  const autoConvertMs = options?.autoConvertMs ?? true;

  let parsed: bigint;
  try {
    parsed = parseDeadline(deadline, autoConvertMs);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const refSec = toReferenceSeconds(options?.referenceTime, autoConvertMs);
    validationHistory.push({
      input: deadline,
      referenceSeconds: refSec,
      valid: false,
      errors: [message],
      timestamp: Date.now(),
    });
    return { valid: false, errors: [message] };
  }

  // 1. Positive value check
  if (parsed <= 0n) {
    errors.push(`Deadline must be a positive timestamp (received ${parsed}).`);
  }

  // 2. 64-bit unsigned bounds check
  if (parsed > MAX_U64) {
    errors.push(
      `Deadline (${parsed}) exceeds maximum 64-bit unsigned integer limit (${MAX_U64}).`
    );
  }

  // 3. Future constraint check
  const refSec = toReferenceSeconds(options?.referenceTime, autoConvertMs);

  if (parsed <= refSec) {
    errors.push(
      `Deadline (${parsed}) must be in the future (reference time: ${refSec}).`
    );
  } else {
    // 4. Minimum lead time check
    const minLead = options?.minLeadSeconds ?? 0;
    if (minLead > 0) {
      const minRequired = refSec + BigInt(minLead);
      if (parsed < minRequired) {
        errors.push(
          `Deadline (${parsed}) must be at least ${minLead} seconds in the future (minimum required: ${minRequired}).`
        );
      }
    }

    // 5. Maximum future limit check
    const maxFuture = options?.maxFutureSeconds;
    if (maxFuture !== undefined && maxFuture > 0) {
      const maxAllowed = refSec + BigInt(maxFuture);
      if (parsed > maxAllowed) {
        errors.push(
          `Deadline (${parsed}) exceeds maximum allowed future limit of ${maxFuture} seconds (maximum allowed: ${maxAllowed}).`
        );
      }
    }
  }

  const valid = errors.length === 0;
  validationHistory.push({
    input: deadline,
    deadlineSeconds: parsed,
    referenceSeconds: refSec,
    valid,
    errors,
    timestamp: Date.now(),
  });

  return {
    valid,
    errors,
    deadlineSeconds: valid ? parsed : undefined,
  };
}

/**
 * Validate a deadline and throw {@link DeadlineValidationError} if invalid.
 *
 * @param deadline - The deadline to validate.
 * @param options - Optional validation options.
 * @returns The normalized deadline in seconds as a `bigint`.
 * @throws {DeadlineValidationError} If validation fails.
 */
export function validateDeadlineOrThrow(
  deadline: unknown,
  options?: DeadlineValidationOptions
): bigint {
  const result = validateDeadline(deadline, options);
  if (!result.valid || result.deadlineSeconds === undefined) {
    throw new DeadlineValidationError(result.errors.join("; "), {
      errors: result.errors,
      deadline,
    });
  }
  return result.deadlineSeconds;
}

/**
 * Convenience helper to check if a deadline is in the future.
 *
 * @param deadline - The deadline to check.
 * @param minLeadSeconds - Optional minimum lead time in seconds. Defaults to 0.
 * @param referenceTime - Optional reference time. Defaults to now.
 * @returns `true` if valid and in the future; `false` otherwise.
 */
export function isFutureDeadline(
  deadline: unknown,
  minLeadSeconds: number = 0,
  referenceTime?: bigint | number | Date
): boolean {
  return validateDeadline(deadline, { minLeadSeconds, referenceTime }).valid;
}

/**
 * Reusable validator instance for validating deadlines with pre-configured rules.
 */
export class DeadlineValidator {
  constructor(private readonly defaultOptions?: DeadlineValidationOptions) {}

  /**
   * Validate a deadline using configured defaults combined with per-call overrides.
   */
  validate(deadline: unknown, options?: DeadlineValidationOptions): DeadlineValidationResult {
    return validateDeadline(deadline, { ...this.defaultOptions, ...options });
  }

  /**
   * Validate a deadline or throw {@link DeadlineValidationError}.
   */
  validateOrThrow(deadline: unknown, options?: DeadlineValidationOptions): bigint {
    return validateDeadlineOrThrow(deadline, { ...this.defaultOptions, ...options });
  }

  /**
   * Return aggregate validation statistics for all validations performed so far.
   */
  getStats(): DeadlineValidationStats {
    return getDeadlineValidationStats();
  }

  /**
   * Clear all recorded validation history.
   */
  resetStats(): void {
    resetDeadlineValidationStats();
  }
}
