/**
 * Stellar asset validation (issue #1375).
 *
 * Offline, structural validation for every kind of asset the SDK accepts:
 *
 * - **Native XLM** — code `"XLM"` (or `"native"`) with no issuer.
 * - **Classic credit assets** — `credit_alphanum4` (1–4 chars) and
 *   `credit_alphanum12` (5–12 chars) codes issued by a valid G-address.
 * - **Custom tokens** — Soroban token contracts identified by a C-address.
 * - **Limits** — amounts are checked against the 7-decimal stroop precision,
 *   the int64 ceiling Stellar imposes, and an optional trustline limit.
 *
 * Network checks (issuer existence, stellar.toml) live in
 * {@link verifyAssetIssuer}; this module never performs I/O.
 */

import { StrKey } from "@stellar/stellar-sdk";

/** Kind of asset a validated input resolves to. */
export type StellarAssetType =
  | "native"
  | "credit_alphanum4"
  | "credit_alphanum12"
  | "contract";

/** Asset description accepted by {@link validateStellarAsset}. */
export interface StellarAssetInput {
  /** Asset code (e.g. "USDC"). Optional for custom tokens. */
  code?: string;
  /** Issuer G-address for classic credit assets. */
  issuer?: string;
  /** Soroban token contract C-address for custom tokens. */
  contractId?: string;
}

/** Options for {@link validateStellarAsset}. */
export interface StellarAssetValidationOptions {
  /** Amount to check against limits, as a decimal string (e.g. "10.5"). */
  amount?: string;
  /** Trustline/asset limit the amount must not exceed, as a decimal string. */
  limit?: string;
  /** When provided, the issuer must be one of these G-addresses. */
  allowedIssuers?: string[];
}

/** Result of {@link validateStellarAsset}. */
export interface StellarAssetValidationResult {
  /** Whether every check passed. */
  valid: boolean;
  /** Resolved asset type, or `null` when it could not be determined. */
  type: StellarAssetType | null;
  /** Human-readable reasons for each failed check. */
  errors: string[];
}

/** Number of decimal places Stellar amounts support. */
export const STELLAR_AMOUNT_DECIMALS = 7;

/** Largest representable amount in stroops (int64 max). */
export const MAX_STELLAR_AMOUNT_STROOPS = 9_223_372_036_854_775_807n;

const ASSET_CODE_PATTERN = /^[A-Za-z0-9]{1,12}$/;
const AMOUNT_PATTERN = /^\d+(\.\d+)?$/;

/**
 * Validate an asset code and classify it by length.
 *
 * @param code - The asset code to validate.
 * @returns The asset type on success, or an error message.
 */
export function validateAssetCode(
  code: string,
): { valid: true; type: "credit_alphanum4" | "credit_alphanum12" } | { valid: false; error: string } {
  if (typeof code !== "string" || code.length === 0) {
    return { valid: false, error: "Asset code is required" };
  }
  if (!ASSET_CODE_PATTERN.test(code)) {
    return {
      valid: false,
      error: `Asset code "${code}" must be 1-12 alphanumeric characters`,
    };
  }
  return { valid: true, type: code.length <= 4 ? "credit_alphanum4" : "credit_alphanum12" };
}

/**
 * Validate that an issuer is a well-formed Stellar account (G-address).
 *
 * @param issuer - Issuer public key.
 * @returns `null` when valid, otherwise an error message.
 */
export function validateAssetIssuer(issuer: string): string | null {
  if (typeof issuer !== "string" || issuer.length === 0) {
    return "Asset issuer is required";
  }
  if (!StrKey.isValidEd25519PublicKey(issuer)) {
    return `Asset issuer "${issuer}" is not a valid Stellar public key`;
  }
  return null;
}

/**
 * Validate a custom token contract address (C-address).
 *
 * @param contractId - Soroban contract id.
 * @returns `null` when valid, otherwise an error message.
 */
export function validateCustomToken(contractId: string): string | null {
  if (typeof contractId !== "string" || contractId.length === 0) {
    return "Token contract id is required";
  }
  if (!StrKey.isValidContract(contractId)) {
    return `Token contract id "${contractId}" is not a valid contract address`;
  }
  return null;
}

/**
 * Convert a decimal amount string into stroops.
 *
 * @returns The amount in stroops, or `null` when the string is malformed or
 *   has more than {@link STELLAR_AMOUNT_DECIMALS} decimal places.
 */
export function parseAmountToStroops(amount: string): bigint | null {
  if (typeof amount !== "string" || !AMOUNT_PATTERN.test(amount)) {
    return null;
  }
  const [whole, fraction = ""] = amount.split(".");
  if (fraction.length > STELLAR_AMOUNT_DECIMALS) {
    return null;
  }
  return BigInt(whole + fraction.padEnd(STELLAR_AMOUNT_DECIMALS, "0"));
}

/**
 * Validate an amount against Stellar's precision and size limits and,
 * optionally, a trustline limit.
 *
 * @param amount - Decimal amount string.
 * @param limit - Optional decimal limit the amount must not exceed.
 * @returns A list of error messages (empty when valid).
 */
export function validateAssetAmount(amount: string, limit?: string): string[] {
  const errors: string[] = [];
  const stroops = parseAmountToStroops(amount);
  if (stroops === null) {
    errors.push(
      `Amount "${amount}" must be a non-negative decimal with at most ${STELLAR_AMOUNT_DECIMALS} decimal places`,
    );
    return errors;
  }
  if (stroops <= 0n) {
    errors.push("Amount must be greater than zero");
  }
  if (stroops > MAX_STELLAR_AMOUNT_STROOPS) {
    errors.push(`Amount "${amount}" exceeds the maximum Stellar amount`);
  }
  if (limit !== undefined) {
    const limitStroops = parseAmountToStroops(limit);
    if (limitStroops === null) {
      errors.push(`Limit "${limit}" is not a valid Stellar amount`);
    } else if (stroops > limitStroops) {
      errors.push(`Amount "${amount}" exceeds the asset limit of "${limit}"`);
    }
  }
  return errors;
}

/**
 * Validate a Stellar asset — native, classic credit asset, or custom token —
 * and optionally an amount against its limits.
 *
 * @example
 * validateStellarAsset({ code: "USDC", issuer: "GA5Z..." }, { amount: "25", limit: "1000" });
 * validateStellarAsset({ contractId: "CA3D..." });
 * validateStellarAsset({ code: "XLM" });
 */
export function validateStellarAsset(
  asset: StellarAssetInput,
  options: StellarAssetValidationOptions = {},
): StellarAssetValidationResult {
  const errors: string[] = [];
  let type: StellarAssetType | null = null;

  if (!asset || typeof asset !== "object") {
    return { valid: false, type: null, errors: ["Asset is required"] };
  }

  const { code, issuer, contractId } = asset;
  const isNative = (code === "XLM" || code === "native") && !issuer && !contractId;

  if (contractId !== undefined) {
    const error = validateCustomToken(contractId);
    if (error) {
      errors.push(error);
    } else {
      type = "contract";
    }
    if (code !== undefined) {
      const codeResult = validateAssetCode(code);
      if (!codeResult.valid) errors.push(codeResult.error);
    }
  } else if (isNative) {
    type = "native";
  } else {
    const codeResult = validateAssetCode(code ?? "");
    if (!codeResult.valid) {
      errors.push(codeResult.error);
    }
    const issuerError = validateAssetIssuer(issuer ?? "");
    if (issuerError) {
      errors.push(issuerError);
    } else if (options.allowedIssuers && !options.allowedIssuers.includes(issuer as string)) {
      errors.push(`Asset issuer "${issuer}" is not in the list of allowed issuers`);
    }
    if (codeResult.valid && !issuerError) {
      type = codeResult.type;
    }
  }

  if (options.amount !== undefined) {
    errors.push(...validateAssetAmount(options.amount, options.limit));
  }

  return { valid: errors.length === 0, type, errors };
}
