/**
 * Stellar address validator for accounts, contracts, and muxed addresses.
 *
 * Stellar addresses use StrKey encoding, which is RFC 4648 Base32 without padding
 * composed of:
 * 1. A 1-byte version prefix ('G' for public keys, 'C' for contract IDs, 'M' for muxed accounts).
 * 2. An encoded payload (32 bytes for account/contract, 40 bytes for muxed accounts).
 * 3. A 2-byte CRC16-XModem checksum of the prefix and payload.
 *
 * This module enforces strict validation rules:
 * 1. Format validation: Enforces exact lengths (56 chars for G/C, 69 for M),
 *    valid Base32 characters (`[A-Z2-7]`), uppercase standard, and correct prefix.
 * 2. Checksum validation: Decodes and verifies the CRC16-XModem checksum against the payload.
 * 3. Secret key protection: Explicitly rejects secret seeds ('S...') to prevent
 *    accidental disclosure or misuse of private keys as public addresses.
 * 4. Address type constraints: Allows integrators to restrict accepted addresses
 *    to specific types (e.g., only account addresses, or account + contract).
 *
 * @example
 * ```ts
 * import { validateAddress, validateAddressOrThrow } from "@stellar-split/sdk";
 *
 * // Validate standard ed25519 public key
 * const result = validateAddress("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ");
 * console.log(result.valid); // true
 * console.log(result.type);  // "account"
 *
 * // Throws AddressValidationError for corrupted checksum
 * validateAddressOrThrow("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGA");
 * ```
 */

import { StrKey } from "@stellar/stellar-sdk";
import { AddressValidationError } from "../errors.js";
import {
  validateContractAddress as validateSorobanContractAddress,
  isSorobanContractAddress as isSorobanContractAddressShared,
  type ContractAddressValidationResult,
} from "../contractAddressValidator.js";

/** Valid Stellar address types supported by the validator. */
export type StellarAddressType = "account" | "contract" | "muxed";

/** RFC 4648 Base32 alphabet characters used by Stellar StrKeys. */
const BASE32_ALPHABET = /^[A-Z2-7]+$/;

/** Expected lengths for each address type. */
export const STELLAR_ADDRESS_LENGTHS = {
  account: 56,
  contract: 56,
  muxed: 69,
  secretKey: 56,
} as const;

/** Result object returned by {@link validateAddress}. */
export interface AddressValidationResult {
  /** True when the address passes all format, checksum, and type constraints. */
  valid: boolean;
  /** Detected address type ("account", "contract", or "muxed") if valid or recognizable. */
  type?: StellarAddressType;
  /** List of human-readable validation error messages. */
  errors: string[];
  /** Normalized address (trimmed and uppercase) if valid. */
  normalizedAddress?: string;
}

/** Options for configuring address validation behavior. */
export interface AddressValidationOptions {
  /**
   * Allowed address types.
   * Defaults to `["account", "contract"]`.
   */
  allowedTypes?: StellarAddressType[];
  /**
   * Shortcut to enable or disable muxed addresses ('M...').
   * If true, adds "muxed" to allowedTypes; if false, excludes "muxed".
   */
  allowMuxed?: boolean;
  /**
   * Whether to explicitly reject secret keys ('S...') with a security warning.
   * Defaults to true.
   */
  rejectSecretKeys?: boolean;
  /**
   * When true, restricts validation to Soroban contract addresses ('C...') only.
   * Delegates to the shared contract validator in `src/contractAddressValidator.ts`.
   */
  contractOnly?: boolean;
}

/** Options for asynchronous account verification against Horizon. */
export interface AccountVerificationOptions {
  /** Horizon base URL. Defaults to the public Horizon endpoint. */
  horizonUrl?: string;
  /** Request timeout in milliseconds. Defaults to 10000. */
  timeoutMs?: number;
  /** Optional fetch implementation (useful for testing). Defaults to global fetch. */
  fetchFn?: typeof fetch;
}

/** Default public Horizon endpoint used for account verification. */
export const DEFAULT_HORIZON_URL = "https://horizon.stellar.org";

/** A single recorded validation event. */
export interface AddressValidationRecord {
  /** The raw address value passed to {@link validateAddress} (stringified if not a string). */
  address: string;
  /** Detected address type, if recognizable. */
  type?: StellarAddressType;
  /** Whether the address passed validation. */
  valid: boolean;
  /** Error messages produced during validation. */
  errors: string[];
  /** Timestamp (ms since epoch) when the validation occurred. */
  timestamp: number;
}

/** Aggregate statistics over recorded validations. */
export interface AddressValidationStats {
  /** Total number of validations recorded. */
  total: number;
  /** Number of valid addresses. */
  valid: number;
  /** Number of invalid addresses. */
  invalid: number;
  /** Counts grouped by detected address type. */
  byType: Record<StellarAddressType, number>;
  /** Counts grouped by error message. */
  byError: Record<string, number>;
}

/** Internal validation tracking state. */
const validationRecords: AddressValidationRecord[] = [];

/**
 * Record a validation event for statistics tracking.
 *
 * @param address - Raw address value passed to the validator.
 * @param result - The validation result.
 */
function recordValidation(address: unknown, result: AddressValidationResult): void {
  let addressStr: string;
  if (typeof address === "string") {
    addressStr = address;
  } else if (address === null || address === undefined) {
    addressStr = String(address);
  } else {
    addressStr = String(address);
  }

  validationRecords.push({
    address: addressStr,
    type: result.type,
    valid: result.valid,
    errors: [...result.errors],
    timestamp: Date.now(),
  });
}

/**
 * Get aggregate statistics for all recorded address validations.
 *
 * @returns An {@link AddressValidationStats} snapshot.
 */
export function getAddressValidationStats(): AddressValidationStats {
  const byType: Record<StellarAddressType, number> = {
    account: 0,
    contract: 0,
    muxed: 0,
  };
  const byError: Record<string, number> = {};
  let valid = 0;
  let invalid = 0;

  for (const record of validationRecords) {
    if (record.valid) {
      valid++;
    } else {
      invalid++;
    }
    if (record.type) {
      byType[record.type]++;
    }
    for (const err of record.errors) {
      byError[err] = (byError[err] ?? 0) + 1;
    }
  }

  return {
    total: validationRecords.length,
    valid,
    invalid,
    byType,
    byError,
  };
}

/**
 * Reset all recorded validation statistics.
 */
export function resetAddressValidationStats(): void {
  validationRecords.length = 0;
}

/**
 * Verify whether an account exists on the Stellar network via Horizon.
 *
 * Only account addresses ('G...') can be verified. Contract and muxed addresses
 * return `false` because they are not directly queryable as Horizon accounts.
 *
 * @param address - The account address to verify.
 * @param options - Optional Horizon configuration.
 * @returns `true` if the account exists on-chain, `false` otherwise.
 */
export async function verifyAccountExists(
  address: string,
  options?: AccountVerificationOptions
): Promise<boolean> {
  if (typeof address !== "string") return false;
  const trimmed = address.trim();

  // Only standard account addresses can be verified via Horizon accounts endpoint.
  if (detectAddressType(trimmed) !== "account") return false;
  if (!verifyAddressChecksum(trimmed)) return false;

  const horizonUrl = (options?.horizonUrl ?? DEFAULT_HORIZON_URL).replace(/\/+$/, "");
  const timeoutMs = options?.timeoutMs ?? 10000;
  const fetchFn = options?.fetchFn ?? (globalThis.fetch as typeof fetch | undefined);
  if (!fetchFn) return false;

  const controller =
    typeof AbortController !== "undefined" ? new AbortController() : undefined;
  const timer = controller
    ? setTimeout(() => controller.abort(), timeoutMs)
    : undefined;

  try {
    const response = await fetchFn(`${horizonUrl}/accounts/${trimmed}`, {
      method: "GET",
      headers: { Accept: "application/json" },
      signal: controller?.signal,
    });
    if (response.status === 404) return false;
    return response.ok;
  } catch {
    return false;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

/**
 * Detect the address type from prefix and length.
 *
 * @param address - Address string to inspect.
 * @returns The detected {@link StellarAddressType}, or `null` if unrecognized.
 */
export function detectAddressType(address: string): StellarAddressType | null {
  if (typeof address !== "string") return null;
  const trimmed = address.trim();

  if (trimmed.startsWith("G") && trimmed.length === STELLAR_ADDRESS_LENGTHS.account) {
    return "account";
  }
  if (trimmed.startsWith("C") && trimmed.length === STELLAR_ADDRESS_LENGTHS.contract) {
    return "contract";
  }
  if (trimmed.startsWith("M") && trimmed.length === STELLAR_ADDRESS_LENGTHS.muxed) {
    return "muxed";
  }
  return null;
}

/**
 * Verify whether an address string passes Stellar CRC16 checksum verification.
 *
 * @param address - The address string to verify.
 * @returns `true` if the checksum is valid for its detected type.
 */
export function verifyAddressChecksum(address: string): boolean {
  if (typeof address !== "string") return false;
  const trimmed = address.trim();

  if (trimmed.startsWith("G")) {
    return StrKey.isValidEd25519PublicKey(trimmed);
  }
  if (trimmed.startsWith("C")) {
    return StrKey.isValidContract(trimmed);
  }
  if (trimmed.startsWith("M")) {
    return StrKey.isValidMed25519PublicKey(trimmed);
  }
  return false;
}

/**
 * Validate a Stellar address for correct format, character set, prefix, and CRC16 checksum.
 *
 * Validation checks:
 * 1. Type & Non-empty: Must be a non-empty string.
 * 2. Secret Key Check: Explicitly rejects private keys ('S...') for security.
 * 3. Base32 Characters: Must contain only RFC 4648 Base32 uppercase characters (`[A-Z2-7]`).
 * 4. Prefix & Length:
 *    - 'G' addresses must be exactly 56 characters.
 *    - 'C' addresses must be exactly 56 characters.
 *    - 'M' addresses must be exactly 69 characters.
 * 5. Type Restrictions: Verifies detected type is in `allowedTypes`.
 * 6. CRC16 Checksum: Decodes the StrKey and verifies integrity against corruption or typos.
 *
 * @param address - The candidate address to validate.
 * @param options - Optional validation configuration.
 * @returns A {@link AddressValidationResult} object.
 */
export function validateAddress(
  address: unknown,
  options?: AddressValidationOptions
): AddressValidationResult {
  // Contract-only mode delegates to the shared Soroban contract validator.
  if (options?.contractOnly === true) {
    const contractResult = validateSorobanContractAddress(address);
    return {
      valid: contractResult.valid,
      type: contractResult.valid ? "contract" : undefined,
      errors: contractResult.errors,
      normalizedAddress: contractResult.normalizedAddress,
    };
  }

  const errors: string[] = [];

  // 1. Type check
  if (address === null || address === undefined) {
    const result: AddressValidationResult = {
      valid: false,
      errors: ["Address is required (received null or undefined)."],
    };
    recordValidation(address, result);
    return result;
  }

  if (typeof address !== "string") {
    const result: AddressValidationResult = {
      valid: false,
      errors: [`Address must be a string (received ${typeof address}).`],
    };
    recordValidation(address, result);
    return result;
  }

  const trimmed = address.trim();
  if (trimmed.length === 0) {
    const result: AddressValidationResult = {
      valid: false,
      errors: ["Address string cannot be empty."],
    };
    recordValidation(address, result);
    return result;
  }

  // 2. Secret key security check
  const rejectSecretKeys = options?.rejectSecretKeys ?? true;
  if (rejectSecretKeys && (trimmed.startsWith("S") || StrKey.isValidEd25519SecretSeed(trimmed))) {
    const result: AddressValidationResult = {
      valid: false,
      errors: [
        "Security error: Secret key ('S...') detected. Private keys must never be used as public addresses.",
      ],
    };
    recordValidation(address, result);
    return result;
  }

  // 3. Allowed types configuration
  let allowedTypes: StellarAddressType[] = options?.allowedTypes ?? ["account", "contract"];
  if (options?.allowMuxed === true && !allowedTypes.includes("muxed")) {
    allowedTypes = [...allowedTypes, "muxed"];
  } else if (options?.allowMuxed === false && allowedTypes.includes("muxed")) {
    allowedTypes = allowedTypes.filter((t) => t !== "muxed");
  }

  // 4. Prefix check
  const firstChar = trimmed[0];
  if (firstChar !== "G" && firstChar !== "C" && firstChar !== "M") {
    errors.push(
      `Invalid address prefix: "${firstChar}". Expected "G" (account), "C" (contract), or "M" (muxed).`
    );
    const result: AddressValidationResult = { valid: false, errors };
    recordValidation(address, result);
    return result;
  }

  const detectedType = detectAddressType(trimmed);

  // 5. Length check
  if (!detectedType) {
    const expectedLen =
      firstChar === "M"
        ? STELLAR_ADDRESS_LENGTHS.muxed
        : STELLAR_ADDRESS_LENGTHS.account;
    errors.push(
      `Invalid address length for "${firstChar}" address: got ${trimmed.length} characters, expected ${expectedLen}.`
    );
    const result: AddressValidationResult = { valid: false, errors };
    recordValidation(address, result);
    return result;
  }

  // 6. Character set check (RFC 4648 Base32)
  if (!BASE32_ALPHABET.test(trimmed)) {
    const invalidChars = Array.from(new Set(trimmed.replace(/[A-Z2-7]/g, ""))).join(", ");
    errors.push(
      `Address contains invalid Base32 characters: ${invalidChars}. Stellar addresses may only contain uppercase letters A-Z and digits 2-7.`
    );
    const result: AddressValidationResult = { valid: false, errors, type: detectedType };
    recordValidation(address, result);
    return result;
  }

  // 7. Allowed types restriction check
  if (!allowedTypes.includes(detectedType)) {
    errors.push(
      `Address type "${detectedType}" is not allowed. Allowed types: ${allowedTypes.join(", ")}.`
    );
    const result: AddressValidationResult = { valid: false, errors, type: detectedType };
    recordValidation(address, result);
    return result;
  }

  // 8. CRC16 Checksum validation
  const checksumValid = verifyAddressChecksum(trimmed);
  if (!checksumValid) {
    errors.push(
      `Address checksum validation failed. The address format is syntactically valid but the CRC16 checksum does not match (potential typo or corruption).`
    );
    const result: AddressValidationResult = { valid: false, errors, type: detectedType };
    recordValidation(address, result);
    return result;
  }

  const result: AddressValidationResult = {
    valid: true,
    type: detectedType,
    errors: [],
    normalizedAddress: trimmed,
  };
  recordValidation(address, result);
  return result;
}

/**
 * Validate a Stellar address and throw {@link AddressValidationError} if invalid.
 *
 * @param address - The candidate address to validate.
 * @param options - Optional validation configuration.
 * @returns The normalized address string.
 * @throws {AddressValidationError} If validation fails.
 */
export function validateAddressOrThrow(
  address: unknown,
  options?: AddressValidationOptions
): string {
  const result = validateAddress(address, options);
  if (!result.valid || !result.normalizedAddress) {
    throw new AddressValidationError(result.errors.join("; "), {
      errors: result.errors,
      address,
    });
  }
  return result.normalizedAddress;
}

/**
 * Convenience helper returning `true` if an address is valid.
 *
 * @param address - Candidate address.
 * @param options - Optional validation configuration.
 * @returns `true` if valid, `false` otherwise.
 */
export function isStellarAddress(address: unknown, options?: AddressValidationOptions): boolean {
  return validateAddress(address, options).valid;
}

/**
 * Validate a Soroban contract address ('C...').
 *
 * Enforces the C-prefix, 56-character length, RFC 4648 Base32 alphabet, and
 * CRC16-XModem checksum by delegating to the shared contract validator in
 * `src/contractAddressValidator.ts`.
 *
 * @param address - The candidate contract address.
 * @returns A {@link ContractAddressValidationResult} object.
 */
export function validateContractAddress(address: unknown): ContractAddressValidationResult {
  return validateSorobanContractAddress(address);
}

/**
 * Convenience helper returning `true` if an address is a valid Soroban contract address.
 *
 * @param address - Candidate contract address.
 * @returns `true` if valid, `false` otherwise.
 */
export function isSorobanContractAddress(address: unknown): boolean {
  return isSorobanContractAddressShared(address);
}

/**
 * Reusable validator instance for validating addresses with pre-configured rules.
 */
export class AddressValidator {
  constructor(private readonly defaultOptions?: AddressValidationOptions) {}

  /**
   * Validate an address using configured defaults combined with per-call overrides.
   */
  validate(address: unknown, options?: AddressValidationOptions): AddressValidationResult {
    return validateAddress(address, { ...this.defaultOptions, ...options });
  }

  /**
   * Validate an address or throw {@link AddressValidationError}.
   */
  validateOrThrow(address: unknown, options?: AddressValidationOptions): string {
    return validateAddressOrThrow(address, { ...this.defaultOptions, ...options });
  }

  /**
   * Validate an address and verify the account exists on-chain via Horizon.
   *
   * Performs synchronous format/checksum validation first, then (for account
   * addresses) queries Horizon to confirm the account exists.
   */
  async validateWithAccountVerification(
    address: unknown,
    options?: AddressValidationOptions,
    verificationOptions?: AccountVerificationOptions
  ): Promise<AddressValidationResult> {
    const result = this.validate(address, options);
    if (!result.valid || !result.normalizedAddress) {
      return result;
    }
    if (result.type !== "account") {
      return result;
    }
    const exists = await verifyAccountExists(result.normalizedAddress, verificationOptions);
    if (!exists) {
      return {
        valid: false,
        type: result.type,
        errors: ["Account does not exist on the Stellar network."],
      };
    }
    return result;
  }
}
