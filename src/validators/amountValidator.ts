/**
 * Amount validator for StellarSplit payments, splits, and token transfers.
 *
 * Stellar operates in stroops (1 unit = 10,000,000 stroops = 10^7), giving
 * token amounts a maximum precision of 7 decimal places. The maximum allowable
 * asset amount on Stellar is bounded by the signed 64-bit integer limit:
 * `INT64_MAX = 9,223,372,036,854,775,807` stroops (~922.3 billion units).
 *
 * This module enforces strict validation rules:
 * 1. Range validation: Enforces minimum bounds (default: 1 stroop, or 0 if allowZero),
 *    maximum bounds (default: INT64_MAX), and prevents negative values.
 * 2. Precision validation: Enforces that decimal amounts do not exceed Stellar's
 *    7 decimal places (configurable via maxDecimals), and rejects scientific notation.
 * 3. Boundary handling: Validates edge cases at exact thresholds (0, 1 stroop,
 *    INT64_MAX, INT64_MAX + 1, negative amounts).
 * 4. Clear documentation & errors: Provides actionable error messages and limits.
 *
 * @example
 * ```ts
 * import { validateAmount, validateAmountOrThrow } from "@stellar-split/sdk";
 *
 * // Validate bigint stroops
 * const result = validateAmount(10_000_000n);
 * if (result.valid) {
 *   console.log("Valid stroops:", result.stroops);
 * }
 *
 * // Validate decimal string with precision checking
 * const stroops = validateAmountOrThrow("100.50"); // 1_005_000_000n
 *
 * // Throws AmountValidationError: precision exceeds 7 decimals
 * validateAmountOrThrow("1.12345678");
 * ```
 */

import { AmountValidationError } from "../errors.js";

/**
 * Maximum 64-bit signed integer supported by Stellar protocol amounts.
 * Equals `2^63 - 1` = `9,223,372,036,854,775,807n` stroops (~922,337,203,685 units).
 */
export const STELLAR_MAX_INT64 = 9_223_372_036_854_775_807n;

/**
 * Minimum valid positive amount on Stellar (1 stroop = 0.0000001 units).
 */
export const STELLAR_MIN_AMOUNT = 1n;

/**
 * Maximum decimal places supported by the Stellar protocol.
 */
export const STELLAR_MAX_DECIMALS = 7;

/**
 * Number of stroops in one whole token unit (10^7).
 */
export const STROOPS_PER_UNIT = 10_000_000n;

/** Result object returned by {@link validateAmount}. */
export interface AmountValidationResult {
  /** True when the amount passes all range, precision, and boundary constraints. */
  valid: boolean;
  /** List of human-readable validation error messages. */
  errors: string[];
  /** The normalized amount in stroops (`bigint`), if valid. */
  stroops?: bigint;
}

/** Unit format of the input amount. */
export type AmountUnit = "stroops" | "decimal" | "auto";

/**
 * Currency/asset identifiers with known decimal precision.
 *
 * Stellar-native assets use 7 decimals (stroops). Fiat-like currencies use
 * their conventional minor-unit precision (e.g. 2 for USD/EUR/GBP).
 */
export type AmountCurrency =
  | "XLM"
  | "USDC"
  | "USDT"
  | "USD"
  | "EUR"
  | "GBP"
  | "JPY"
  | "BTC"
  | "ETH";

/**
 * Decimal precision (number of fractional digits) per supported currency.
 */
export const CURRENCY_DECIMALS: Readonly<Record<AmountCurrency, number>> = Object.freeze({
  XLM: 7,
  USDC: 7,
  USDT: 7,
  USD: 2,
  EUR: 2,
  GBP: 2,
  JPY: 0,
  BTC: 8,
  ETH: 8,
});

/**
 * Resolve the decimal precision for a currency identifier.
 *
 * @param currency - Currency identifier (case-insensitive).
 * @returns Number of decimal places for the currency.
 * @throws {AmountValidationError} If the currency is not supported.
 */
export function getCurrencyDecimals(currency: string): number {
  const key = currency.trim().toUpperCase() as AmountCurrency;
  const decimals = CURRENCY_DECIMALS[key];
  if (decimals === undefined) {
    throw new AmountValidationError(`Unsupported currency: "${currency}".`, { currency });
  }
  return decimals;
}

/**
 * Compute the maximum representable amount (in stroops) for a currency,
 * bounded by both its decimal precision and the Stellar INT64_MAX limit.
 *
 * @param currency - Currency identifier.
 * @returns Maximum amount in stroops.
 */
export function getCurrencyMaxStroops(currency: string): bigint {
  const decimals = getCurrencyDecimals(currency);
  const unitScale = 10n ** BigInt(decimals);
  const maxUnits = STELLAR_MAX_INT64 / unitScale;
  const currencyMax = maxUnits * unitScale;
  return currencyMax < STELLAR_MAX_INT64 ? currencyMax : STELLAR_MAX_INT64;
}

/** Options for configuring amount validation behavior. */
export interface AmountValidationOptions {
  /**
   * Minimum allowable amount in stroops.
   * Defaults to 1n (or 0n if `allowZero` is true).
   */
  min?: bigint | number | string;
  /**
   * Maximum allowable amount in stroops.
   * Defaults to {@link STELLAR_MAX_INT64}.
   */
  max?: bigint | number | string;
  /**
   * Whether zero (0n) is considered a valid amount.
   * Defaults to false.
   */
  allowZero?: boolean;
  /**
   * Whether negative amounts are considered valid.
   * Defaults to false.
   */
  allowNegative?: boolean;
  /**
   * Maximum number of decimal places allowed for decimal representations.
   * Defaults to 7 (Stellar's standard precision).
   */
  maxDecimals?: number;
  /**
   * How to interpret input numbers or strings.
   * - "stroops": Input is interpreted as raw integer stroops.
   * - "decimal": Input is interpreted as whole units with decimal fractions (e.g. "1.5" = 15,000,000 stroops).
   * - "auto": bigint is stroops; string with '.' is decimal; string without '.' is stroops.
   * Defaults to "auto".
   */
  unit?: AmountUnit;
  /**
   * Currency/asset identifier used to derive decimal precision and bounds.
   * When set, overrides `maxDecimals` (unless explicitly provided) and caps
   * the maximum bound to the currency's representable range.
   */
  currency?: AmountCurrency | string;
  /**
   * Alias for {@link AmountValidationOptions.currency}.
   */
  asset?: AmountCurrency | string;
}

/** Record of a single amount validation invocation. */
export interface AmountValidationRecord {
  /** The raw input amount as received. */
  input: unknown;
  /** Resolved stroops, if parsing succeeded. */
  stroops?: bigint;
  /** Whether the amount passed validation. */
  valid: boolean;
  /** Validation error messages (empty when valid). */
  errors: string[];
  /** Currency used for validation, if any. */
  currency?: string;
  /** Effective maximum decimal places applied. */
  maxDecimals: number;
  /** Timestamp (ms since epoch) of the validation. */
  timestamp: number;
}

/** Aggregate statistics over recorded amount validations. */
export interface AmountValidationStats {
  /** Total number of validations recorded. */
  total: number;
  /** Number of valid amounts. */
  valid: number;
  /** Number of invalid amounts. */
  invalid: number;
  /** Number of validations that failed due to exceeding the maximum bound. */
  overflow: number;
  /** Number of validations that failed due to precision/decimal errors. */
  precisionErrors: number;
  /** Number of validations that failed due to negative amounts. */
  negativeErrors: number;
  /** Per-currency validation counts. */
  byCurrency: Record<string, number>;
}

const validationRecords: AmountValidationRecord[] = [];
const MAX_RECORDS = 1000;

/**
 * Record a validation invocation for statistics tracking.
 */
function recordValidation(record: AmountValidationRecord): void {
  validationRecords.push(record);
  if (validationRecords.length > MAX_RECORDS) {
    validationRecords.shift();
  }
}

/**
 * Get aggregate statistics over recorded amount validations.
 */
export function getAmountValidationStats(): AmountValidationStats {
  const stats: AmountValidationStats = {
    total: 0,
    valid: 0,
    invalid: 0,
    overflow: 0,
    precisionErrors: 0,
    negativeErrors: 0,
    byCurrency: {},
  };

  for (const record of validationRecords) {
    stats.total += 1;
    if (record.valid) {
      stats.valid += 1;
    } else {
      stats.invalid += 1;
    }
    if (record.currency) {
      stats.byCurrency[record.currency] = (stats.byCurrency[record.currency] ?? 0) + 1;
    }
    for (const error of record.errors) {
      if (/exceeds the maximum/i.test(error)) {
        stats.overflow += 1;
      }
      if (/precision|decimal/i.test(error)) {
        stats.precisionErrors += 1;
      }
      if (/negative/i.test(error)) {
        stats.negativeErrors += 1;
      }
    }
  }

  return stats;
}

/**
 * Reset (clear) all recorded amount validations.
 */
export function resetAmountValidationStats(): void {
  validationRecords.length = 0;
}

/**
 * Parse an unknown input into raw stroops (`bigint`).
 *
 * @param amount - The raw amount input (bigint, number, or string).
 * @param unit - Unit mode ("auto", "decimal", or "stroops"). Defaults to "auto".
 * @param maxDecimals - Maximum allowed decimal places. Defaults to 7.
 * @returns Parsed stroops as `bigint`.
 * @throws {AmountValidationError} If parsing fails or precision is exceeded.
 */
export function parseToStroops(
  amount: unknown,
  unit: AmountUnit = "auto",
  maxDecimals: number = STELLAR_MAX_DECIMALS
): bigint {
  if (amount === null || amount === undefined) {
    throw new AmountValidationError("Amount is required (received null or undefined).", {
      amount,
    });
  }

  if (typeof amount === "bigint") {
    if (unit === "decimal") {
      return amount * STROOPS_PER_UNIT;
    }
    return amount;
  }

  if (typeof amount === "number") {
    if (!Number.isFinite(amount)) {
      throw new AmountValidationError(
        `Amount must be a finite number (received ${String(amount)}).`,
        { amount }
      );
    }
    if (unit === "stroops") {
      if (!Number.isInteger(amount)) {
        throw new AmountValidationError(
          `Stroop amounts must be integers (received fractional number ${amount}).`,
          { amount }
        );
      }
      return BigInt(Math.trunc(amount));
    }
    // Decimal mode or auto with fractional number
    return parseDecimalStringToStroops(amount.toString(), maxDecimals);
  }

  if (typeof amount === "string") {
    const trimmed = amount.trim();
    if (trimmed.length === 0) {
      throw new AmountValidationError("Amount string cannot be empty.", { amount });
    }

    // Disallow scientific notation to prevent floating-point ambiguity
    if (/[eE]/.test(trimmed)) {
      throw new AmountValidationError(
        `Scientific notation is not supported for amounts ("${amount}"). Use standard decimal notation.`,
        { amount }
      );
    }

    if (unit === "stroops" || (unit === "auto" && !trimmed.includes("."))) {
      if (!/^[+-]?\d+$/.test(trimmed)) {
        throw new AmountValidationError(
          `Invalid stroop amount format: "${amount}". Expected an integer string.`,
          { amount }
        );
      }
      return BigInt(trimmed);
    }

    // Decimal mode or auto with '.'
    return parseDecimalStringToStroops(trimmed, maxDecimals);
  }

  throw new AmountValidationError(
    `Unsupported amount type: expected bigint, number, or string (received ${typeof amount}).`,
    { amount }
  );
}

/**
 * Parse a decimal string into stroops with precision checking.
 */
function parseDecimalStringToStroops(str: string, maxDecimals: number): bigint {
  const match = /^([+-])?(\d*)(\.(\d*))?$/.exec(str);
  if (!match) {
    throw new AmountValidationError(
      `Invalid decimal amount format: "${str}". Expected a numeric string (e.g. "10.50").`,
      { str }
    );
  }

  const sign = match[1] === "-" ? -1n : 1n;
  const wholePart = match[2] || "0";
  const fracPart = match[4] || "";

  if (!match[2] && !match[4]) {
    throw new AmountValidationError(`Invalid decimal amount: "${str}". No digits found.`, { str });
  }

  if (fracPart.length > maxDecimals) {
    throw new AmountValidationError(
      `Amount precision (${fracPart.length} decimals) exceeds maximum allowed ${maxDecimals} decimal places in "${str}".`,
      { str, decimals: fracPart.length, maxDecimals }
    );
  }

  const whole = BigInt(wholePart) * STROOPS_PER_UNIT;
  const fracPadded = fracPart.padEnd(7, "0").slice(0, 7);
  const frac = BigInt(fracPadded);

  return sign * (whole + frac);
}

/**
 * Validate an amount for correct range, precision, and bounds.
 *
 * Validation checks:
 * 1. Format & Parsing: Parses amount into bigint stroops, rejecting NaN, Infinity,
 *    unsupported types, or malformed strings.
 * 2. Precision: Verifies decimal fraction digits do not exceed `maxDecimals` (default 7).
 * 3. Non-negative: Rejects negative amounts unless `allowNegative` is true.
 * 4. Zero check: Rejects 0 amounts unless `allowZero` is true.
 * 5. Minimum bound: Verifies amount >= `min` (default 1 stroop or 0 if allowZero).
 * 6. Maximum bound: Verifies amount <= `max` (default Stellar INT64_MAX).
 *
 * @param amount - The amount to validate (bigint, number, or string).
 * @param options - Optional validation configuration.
 * @returns A {@link AmountValidationResult} containing validity status, normalized stroops, and errors.
 */
export function validateAmount(
  amount: unknown,
  options?: AmountValidationOptions
): AmountValidationResult {
  const errors: string[] = [];
  const currency = options?.currency ?? options?.asset;
  let currencyDecimals: number | undefined;
  if (currency !== undefined) {
    try {
      currencyDecimals = getCurrencyDecimals(currency);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      recordValidation({
        input: amount,
        valid: false,
        errors: [message],
        currency,
        maxDecimals: options?.maxDecimals ?? STELLAR_MAX_DECIMALS,
        timestamp: Date.now(),
      });
      return { valid: false, errors: [message] };
    }
  }

  const maxDecimals =
    options?.maxDecimals ?? currencyDecimals ?? STELLAR_MAX_DECIMALS;
  const unit = options?.unit ?? "auto";

  let stroops: bigint;
  try {
    stroops = parseToStroops(amount, unit, maxDecimals);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    recordValidation({
      input: amount,
      valid: false,
      errors: [message],
      currency,
      maxDecimals,
      timestamp: Date.now(),
    });
    return { valid: false, errors: [message] };
  }

  const allowZero = options?.allowZero ?? false;
  const allowNegative = options?.allowNegative ?? false;

  // 1. Negative amount check
  if (stroops < 0n && !allowNegative) {
    errors.push(`Amount cannot be negative (received ${stroops} stroops).`);
  }

  // 2. Zero amount check
  if (stroops === 0n && !allowZero) {
    errors.push("Amount must be greater than zero.");
  }

  // 3. Minimum bound check
  let minBound: bigint = allowNegative
    ? -STELLAR_MAX_INT64
    : allowZero
      ? 0n
      : STELLAR_MIN_AMOUNT;
  if (options?.min !== undefined) {
    try {
      minBound = parseToStroops(options.min, unit, maxDecimals);
    } catch {
      minBound = typeof options.min === "bigint" ? options.min : BigInt(options.min);
    }
  }

  if (stroops < minBound) {
    errors.push(
      `Amount (${stroops} stroops) is below the minimum allowed limit of ${minBound} stroops.`
    );
  }

  // 4. Maximum bound check
  let maxBound: bigint = STELLAR_MAX_INT64;
  if (currency !== undefined) {
    maxBound = getCurrencyMaxStroops(currency);
  }
  if (options?.max !== undefined) {
    try {
      maxBound = parseToStroops(options.max, unit, maxDecimals);
    } catch {
      maxBound = typeof options.max === "bigint" ? options.max : BigInt(options.max);
    }
  }

  // 5. Absolute overflow check against INT64_MAX (no overflow allowed)
  if (stroops > STELLAR_MAX_INT64 || stroops < -STELLAR_MAX_INT64) {
    errors.push(
      `Amount (${stroops} stroops) exceeds the maximum allowed limit of ${STELLAR_MAX_INT64} stroops.`
    );
  } else if (stroops > maxBound) {
    errors.push(
      `Amount (${stroops} stroops) exceeds the maximum allowed limit of ${maxBound} stroops.`
    );
  }

  const valid = errors.length === 0;
  recordValidation({
    input: amount,
    stroops,
    valid,
    errors,
    currency,
    maxDecimals,
    timestamp: Date.now(),
  });

  return {
    valid,
    errors,
    stroops: valid ? stroops : undefined,
  };
}

/**
 * Validate an amount and throw {@link AmountValidationError} if invalid.
 *
 * @param amount - The amount to validate.
 * @param options - Optional validation configuration.
 * @returns The validated amount in stroops as a `bigint`.
 * @throws {AmountValidationError} If validation fails.
 */
export function validateAmountOrThrow(
  amount: unknown,
  options?: AmountValidationOptions
): bigint {
  const result = validateAmount(amount, options);
  if (!result.valid || result.stroops === undefined) {
    throw new AmountValidationError(result.errors.join("; "), {
      errors: result.errors,
      amount,
    });
  }
  return result.stroops;
}

/**
 * Convenience helper returning `true` if an amount is valid.
 *
 * @param amount - The amount to check.
 * @param options - Optional validation configuration.
 * @returns `true` if valid, `false` otherwise.
 */
export function isValidAmount(amount: unknown, options?: AmountValidationOptions): boolean {
  return validateAmount(amount, options).valid;
}

/**
 * Reusable validator instance for validating amounts with pre-configured rules.
 */
export class AmountValidator {
  constructor(private readonly defaultOptions?: AmountValidationOptions) {}

  /**
   * Validate an amount using configured defaults combined with per-call overrides.
   */
  validate(amount: unknown, options?: AmountValidationOptions): AmountValidationResult {
    return validateAmount(amount, { ...this.defaultOptions, ...options });
  }

  /**
   * Validate an amount or throw {@link AmountValidationError}.
   */
  validateOrThrow(amount: unknown, options?: AmountValidationOptions): bigint {
    return validateAmountOrThrow(amount, { ...this.defaultOptions, ...options });
  }

  /**
   * Get aggregate validation statistics for this validator's tracked calls.
   */
  getStats(): AmountValidationStats {
    return getAmountValidationStats();
  }

  /**
   * Reset tracked validation statistics.
   */
  resetStats(): void {
    resetAmountValidationStats();
  }
}
