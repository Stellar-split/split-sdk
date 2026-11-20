/**
 * Validator suite for StellarSplit SDK.
 *
 * Provides dedicated validators for:
 * - Deadlines (Issue #1064)
 * - Amounts and precision (Issue #1063)
 * - Stellar addresses and checksums (Issue #1062)
 * - Signatures and multi-sig thresholds (Issue #1061)
 * - Split ratios and totals
 * - Invoice metadata
 * - Recipient deduplication
 *
 * Also provides a validation-hook entry point (Issue #1251) that runs the
 * input sanitizer rules before delegating to the individual validators, so
 * every validator call is sanitized and whitelist-enforced.
 */

export * from "./deadlineValidator.js";
export * from "./amountValidator.js";
export * from "./addressValidator.js";
export * from "./signatureValidator.js";
export * from "./splitRatioValidator.js";
export * from "./invoiceMetadataValidator.js";
export * from "./recipientDeduplicator.js";

import {
  sanitizeInput,
  sanitizeInputs,
  enforceWhitelist,
  getSanitizationTracker,
  resetSanitizationTracker,
  type SanitizationOptions,
  type SanitizationResult,
  type SanitizationRule,
  type SanitizationTracker,
  type SanitizationRecord,
  type WhitelistConfig,
} from "../inputSanitizer.js";

export {
  sanitizeInput,
  sanitizeInputs,
  enforceWhitelist,
  getSanitizationTracker,
  resetSanitizationTracker,
  type SanitizationOptions,
  type SanitizationResult,
  type SanitizationRule,
  type SanitizationTracker,
  type SanitizationRecord,
  type WhitelistConfig,
};

/**
 * A validator function that accepts a single input value and returns a
 * boolean (or throws) to indicate validity.
 */
export type ValidatorFn<T = unknown> = (value: T) => boolean;

/**
 * Options controlling how the validation hook sanitizes inputs before
 * delegating to the wrapped validator.
 */
export interface ValidationHookOptions extends SanitizationOptions {
  /** Whitelist configuration enforced before validation. */
  whitelist?: WhitelistConfig;
  /** When true, sanitization failures throw instead of returning false. */
  throwOnSanitizationFailure?: boolean;
}

/**
 * Result returned by a hooked validator invocation.
 */
export interface ValidationHookResult<T = unknown> {
  /** Whether the (sanitized) input passed validation. */
  valid: boolean;
  /** The sanitized value that was validated. */
  sanitized: T;
  /** Full sanitization result including any tracking metadata. */
  sanitization: SanitizationResult<T>;
}

/**
 * Wraps a validator so that its input is sanitized (and whitelist-enforced)
 * before the underlying validator runs. Every call is recorded by the
 * sanitization tracker.
 *
 * @param validator The underlying validator to delegate to.
 * @param options   Sanitization / whitelist options for this hook.
 * @returns A function that sanitizes then validates its input.
 */
export function withSanitization<T = unknown>(
  validator: ValidatorFn<T>,
  options: ValidationHookOptions = {},
): (value: unknown) => ValidationHookResult<T> {
  const { whitelist, throwOnSanitizationFailure, ...sanitizationOptions } =
    options;

  return (value: unknown): ValidationHookResult<T> => {
    const sanitization = sanitizeInput<T>(value, {
      ...sanitizationOptions,
      whitelist,
    });

    if (!sanitization.ok) {
      if (throwOnSanitizationFailure) {
        throw new Error(
          `Input sanitization failed: ${sanitization.reason ?? "unknown reason"}`,
        );
      }
      return {
        valid: false,
        sanitized: sanitization.value,
        sanitization,
      };
    }

    const valid = validator(sanitization.value);
    return {
      valid,
      sanitized: sanitization.value,
      sanitization,
    };
  };
}

/**
 * Runs the input sanitizer rules over one or more inputs and then delegates
 * to the supplied validator. This is the primary validation-hook entry point
 * for callers that want sanitization + validation in a single call.
 *
 * @param validator The underlying validator to delegate to.
 * @param value     The raw input to sanitize and validate.
 * @param options   Sanitization / whitelist options for this hook.
 * @returns The hooked validation result.
 */
export function validateWithSanitization<T = unknown>(
  validator: ValidatorFn<T>,
  value: unknown,
  options: ValidationHookOptions = {},
): ValidationHookResult<T> {
  return withSanitization(validator, options)(value);
}

/**
 * Sanitizes a batch of inputs and delegates to a validator that operates on
 * the sanitized collection. Useful for methods that accept multiple
 * parameters which must all be sanitized before validation.
 *
 * @param validator The underlying validator to delegate to.
 * @param values    The raw inputs to sanitize and validate.
 * @param options   Sanitization / whitelist options for this hook.
 * @returns The hooked validation result.
 */
export function validateManyWithSanitization<T = unknown>(
  validator: ValidatorFn<T[]>,
  values: unknown[],
  options: ValidationHookOptions = {},
): ValidationHookResult<T[]> {
  const { whitelist, throwOnSanitizationFailure, ...sanitizationOptions } =
    options;

  const sanitization = sanitizeInputs<T>(values, {
    ...sanitizationOptions,
    whitelist,
  });

  if (!sanitization.ok) {
    if (throwOnSanitizationFailure) {
      throw new Error(
        `Input sanitization failed: ${sanitization.reason ?? "unknown reason"}`,
      );
    }
    return {
      valid: false,
      sanitized: sanitization.value,
      sanitization,
    };
  }

  const valid = validator(sanitization.value);
  return {
    valid,
    sanitized: sanitization.value,
    sanitization,
  };
}
</｜｜DSML｜｜ parameter>