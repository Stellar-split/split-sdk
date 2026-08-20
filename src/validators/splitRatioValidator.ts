/**
 * Split ratio pre-submission validator.
 *
 * Invoices accept an array of recipient share ratios that must sum to exactly
 * 1.0 (100 %) when expressed as a decimal, but the SDK currently accepted
 * malformed ratio arrays and only surfaced the error at transaction
 * submission time deep inside Horizon.
 *
 * This validator catches ratio-sum violations, negative shares, duplicate
 * recipient addresses, and zero-weight entries early, returning structured,
 * actionable error objects.
 */

import { StellarSplitError, ValidationError } from "../errors.js";
import type { Recipient } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** A single recipient share entry consumed by the ratio validator. */
export interface RecipientShare {
  /** Stellar address of the recipient. */
  address: string;
  /**
   * The recipient's share expressed as a decimal fraction where the sum
   * across all shares MUST equal 1.0 (e.g. 0.4 + 0.3 + 0.3 = 1.0).
   */
  share: number;
}

/**
 * Split configuration consumed by the ratio validator.
 *
 * Contains the raw recipient shares provided by the caller and optional
 * tolerance for floating-point comparison.
 */
export interface SplitConfig {
  /** Ordered list of recipient shares. */
  shares: RecipientShare[];
  /**
   * Floating-point comparison tolerance. Defaults to 1e-9.
   * Increasing this value relaxes the sum-to-one constraint (useful when
   * dealing with imprecise user input).
   */
  tolerance?: number;
}

/** Structured validation result returned by {@link validateSplitRatios}. */
export interface SplitRatioValidationResult {
  /** True when all checks pass. */
  valid: boolean;
  /** Human-readable error messages. */
  errors: string[];
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

/**
 * Validate that an array of recipient shares forms a well-formed split
 * configuration.
 *
 * Checks performed:
 * 1. At least one share is provided.
 * 2. No share is negative.
 * 3. No share is zero.
 * 4. No duplicate recipient addresses.
 * 5. Shares sum to 1.0 (± tolerance).
 *
 * @param config - The split configuration to validate.
 * @returns A structured result with `valid` and `errors` fields.
 */
export function validateSplitRatios(
  config: SplitConfig,
): SplitRatioValidationResult {
  const errors: string[] = [];
  const tolerance = config.tolerance ?? 1e-9;

  if (!config.shares || config.shares.length === 0) {
    return { valid: false, errors: ["At least one recipient share is required."] };
  }

  // 1. Negative share check
  for (const share of config.shares) {
    if (share.share < 0) {
      errors.push(
        `Recipient ${share.address} has a negative share (${share.share}). Shares must be non-negative.`,
      );
    }
  }

  // 2. Zero share check
  for (const share of config.shares) {
    if (share.share === 0) {
      errors.push(
        `Recipient ${share.address} has a zero share. Remove zero-weight entries.`,
      );
    }
  }

  // 3. Duplicate address check
  const seen = new Set<string>();
  for (const share of config.shares) {
    if (seen.has(share.address)) {
      errors.push(
        `Duplicate recipient address: ${share.address}. Each recipient must appear only once.`,
      );
    }
    seen.add(share.address);
  }

  // 4. Sum-to-one check
  const sum = config.shares.reduce((acc, s) => acc + s.share, 0);
  if (Math.abs(sum - 1.0) > tolerance) {
    errors.push(
      `Share ratios sum to ${sum} but must sum to exactly 1.0 (tolerance: ±${tolerance}).`,
    );
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate that the share ratios sum to 1.0 and throw a {@link ValidationError}
 * on the first violation.
 *
 * Convenience function for callers that prefer exceptions over result objects.
 *
 * @param config - The split configuration to validate.
 * @throws ValidationError if any check fails.
 */
export function validateSplitRatiosOrThrow(config: SplitConfig): void {
  const result = validateSplitRatios(config);
  if (!result.valid) {
    throw new ValidationError(result.errors.join(" "), { errors: result.errors });
  }
}

/**
 * Convert a {@link SplitConfig} (ratio-based) into an array of
 * {@link Recipient} with absolute amounts given a total.
 *
 * Useful for bridging the ratio validator with the existing `Recipient[]`
 * contract-call format.
 *
 * @param config  - Validated split configuration.
 * @param total   - Total amount in stroops to distribute.
 * @returns Recipient entries with absolute amounts.
 */
export function ratiosToRecipients(
  config: SplitConfig,
  total: bigint,
): Recipient[] {
  // Integer allocation using the largest-remainder method to avoid
  // rounding errors summing to != total.
  const n = config.shares.length;
  const amounts: bigint[] = new Array(n).fill(0n);
  let allocated = 0n;

  // Floor allocation
  for (let i = 0; i < n; i++) {
    const share = config.shares[i]!.share;
    amounts[i] = (total * BigInt(Math.floor(share * 1_000_000))) / 1_000_000n;
    allocated += amounts[i]!;
  }

  // Distribute remainder (at most n-1 stroops due to flooring) to the
  // first few entries.
  const remainder = total - allocated;
  for (let i = 0; i < Number(remainder); i++) {
    amounts[i] = (amounts[i] ?? 0n) + 1n;
  }

  return config.shares.map((s, i) => ({
    address: s.address,
    amount: amounts[i]!,
  }));
}

/**
 * Validate that the sum of an array of bigint splits equals the expected total.
 *
 * @param splits - Array of bigint split amounts
 * @param totalBasisPoints - Expected total in basis points (default: 10000n = 100%)
 * @throws StellarSplitError with code INVALID_RECIPIENT if sum !== total
 */
export function validateSplitTotal(
  splits: bigint[],
  totalBasisPoints?: bigint,
): void {
  const total = totalBasisPoints ?? 10000n;

  if (splits.length === 0) {
    throw new StellarSplitError(
      "splits must sum to 10000 basis points",
      "INVALID_RECIPIENT",
    );
  }

  const sum = splits.reduce((acc, s) => acc + s, 0n);
  if (sum !== total) {
    throw new StellarSplitError(
      "splits must sum to 10000 basis points",
      "INVALID_RECIPIENT",
    );
  }
}

/**
 * Normalize an array of bigint amounts so they sum to exactly the given total.
 * Distributes the rounding remainder to the last element.
 *
 * @param amounts - Array of bigint amounts to normalize
 * @param total - The target total sum
 * @returns A new array with the remainder distributed to the last element
 */
export function normalizeSplits(
  amounts: bigint[],
  total: bigint,
): bigint[] {
  const sum = amounts.reduce((acc, s) => acc + s, 0n);
  if (sum === total) return [...amounts];

  const remainder = total - sum;
  const result = [...amounts];
  result[result.length - 1] = (result[result.length - 1] ?? 0n) + remainder;
  return result;
}
