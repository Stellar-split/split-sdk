/**
 * Soroban contract address validation for StellarSplit (issue #1065).
 *
 * Validates contract identifiers (`C...` addresses) against the Stellar
 * StrKey standard before they are used to build or submit transactions, so
 * mistyped or corrupt contract IDs fail fast locally instead of producing
 * on-chain failures.
 *
 * ## Validation rules
 *
 * A valid Soroban contract address must satisfy all of the following:
 *
 * 1. **Type** — a non-empty string (`typeof address === "string"`).
 * 2. **Length** — exactly 56 characters.
 * 3. **Prefix** — starts with `C` (the contract StrKey version byte).
 * 4. **Alphabet** — every character is in the RFC 4648 base32 alphabet
 *    (`A`–`Z`, `2`–`7`); base32 is case-sensitive, so lowercase is rejected.
 * 5. **Checksum** — the trailing two characters encode a CRC16-XModem
 *    checksum over the version byte plus the 32-byte payload, as defined by
 *    the StrKey specification (CAP-0005 / SEP-0023).
 *
 * Rules 2–4 are reported as the `format` check; rule 5 is reported as the
 * `checksum` check. Both must pass for the address to be valid.
 *
 * @example
 * ```ts
 * import { validateContractAddress, isValidContractAddress } from "@stellar-split/sdk";
 *
 * isValidContractAddress("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"); // true
 *
 * const result = validateContractAddress("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC5");
 * result.format;    // true  — well-formed, only the checksum is broken
 * result.checksum;  // false
 * result.errors;    // ["Contract address failed CRC16 checksum validation"]
 * ```
 */

import { StrKey } from "@stellar/stellar-sdk";
import { InvalidContractAddressError } from "./errors.js";
import { Cache } from "./cache.js";

/** Total length of a StrKey-encoded contract address, in characters. */
export const CONTRACT_ADDRESS_LENGTH = 56;

/** Required leading character of a contract (`C...`) address. */
export const CONTRACT_ADDRESS_PREFIX = "C";

/** RFC 4648 base32 alphabet used by StrKey (uppercase, case-sensitive). */
const BASE32_PATTERN = /^[A-Z2-7]+$/;

/** Detailed outcome of validating a contract address. */
export interface ContractAddressValidationResult {
  /** `true` when both the format and checksum checks pass. */
  valid: boolean;
  /** The value that was validated (stringified for non-string input). */
  address: string;
  /** `true` when length, prefix, and base32 alphabet checks pass. */
  format: boolean;
  /** `true` when the StrKey CRC16 checksum verifies (only checked when `format` is `true`). */
  checksum: boolean;
  /** Human-readable descriptions of every failed rule. */
  errors: string[];
}

/**
 * Validate a Soroban contract address against the StrKey standard.
 *
 * Performs format validation (type, length, prefix, base32 alphabet) followed
 * by CRC16 checksum validation via the stellar-sdk `StrKey` codec. Never
 * throws — all failures are reported in the returned result.
 *
 * @param address - Candidate contract address (any value; non-strings fail).
 * @returns A {@link ContractAddressValidationResult} describing which rules
 *   passed and why any failed.
 */
export function validateContractAddress(address: unknown): ContractAddressValidationResult {
  if (typeof address !== "string" || address.length === 0) {
    return {
      valid: false,
      address: String(address),
      format: false,
      checksum: false,
      errors: ["Contract address must be a non-empty string"],
    };
  }

  const errors: string[] = [];
  let format = true;

  if (address.length !== CONTRACT_ADDRESS_LENGTH) {
    format = false;
    errors.push(
      `Contract address must be exactly ${CONTRACT_ADDRESS_LENGTH} characters (got ${address.length})`,
    );
  }
  if (!address.startsWith(CONTRACT_ADDRESS_PREFIX)) {
    format = false;
    errors.push(
      `Contract address must start with '${CONTRACT_ADDRESS_PREFIX}' (got '${address.slice(0, 1)}')`,
    );
  }
  if (!BASE32_PATTERN.test(address)) {
    format = false;
    errors.push(
      "Contract address must contain only uppercase base32 characters (A-Z, 2-7)",
    );
  }

  // Only attempt checksum validation once the address is well-formed;
  // StrKey.decodeContract throws on any structural or checksum mismatch.
  let checksum = false;
  if (format) {
    try {
      StrKey.decodeContract(address);
      checksum = true;
    } catch {
      errors.push("Contract address failed CRC16 checksum validation");
    }
  }

  return {
    valid: format && checksum,
    address,
    format,
    checksum,
    errors,
  };
}

/**
 * Report whether `address` is a valid Soroban contract address.
 *
 * Shorthand for `validateContractAddress(address).valid`.
 *
 * @param address - Candidate contract address string.
 *
 * @example
 * ```ts
 * isValidContractAddress("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4"); // true
 * isValidContractAddress("GA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVSGZ"); // false — G-address
 * isValidContractAddress(""); // false
 * ```
 */
export function isValidContractAddress(address: string): boolean {
  return validateContractAddress(address).valid;
}

/** Alias of {@link isValidContractAddress} accepting `unknown`, for callers validating untyped input. */
export function isSorobanContractAddress(address: unknown): boolean {
  return validateContractAddress(address).valid;
}

/**
 * Assert that `address` is a valid Soroban contract address, throwing
 * {@link InvalidContractAddressError} with every violated rule when it is not.
 *
 * @param address - Candidate contract address string.
 * @throws {InvalidContractAddressError} If the address fails any rule.
 */
export function assertValidContractAddress(address: string): void {
  const result = validateContractAddress(address);
  if (!result.valid) {
    throw new InvalidContractAddressError(address, result.errors);
  }
}

/** Default time-to-live for cached validation results, in milliseconds. */
export const DEFAULT_VALIDATION_CACHE_TTL_MS = 5 * 60 * 1000;

/**
 * Performs an on-chain contract existence check (e.g. via RPC
 * `getContractData`). Resolves `true` when the contract exists.
 */
export type ContractVerifier = (address: string) => Promise<boolean>;

/** Options accepted by {@link ContractAddressValidator}. */
export interface ContractAddressValidatorOptions {
  /**
   * Optional on-chain verifier. When omitted, addresses are only checked for
   * format and checksum and `verified` is reported as `false`.
   */
  verifier?: ContractVerifier;
  /** TTL for cached validation results, in milliseconds. */
  cacheTtlMs?: number;
  /** Custom cache instance; defaults to a new {@link Cache}. */
  cache?: Cache<boolean>;
}

/** Detailed outcome of a full contract address validation. */
export interface ContractValidationResult {
  /** `true` when format, checksum, and (if a verifier is configured) verification pass. */
  valid: boolean;
  /** The address that was validated. */
  address: string;
  /** `true` when length, prefix, and base32 alphabet checks pass. */
  format: boolean;
  /** `true` when the StrKey CRC16 checksum verifies. */
  checksum: boolean;
  /** `true` when the on-chain verifier confirmed the contract exists. */
  verified: boolean;
  /** `true` when the result was served from the cache. */
  cached: boolean;
  /** Human-readable descriptions of every failed rule. */
  errors: string[];
}

/** Aggregate validation counters exposed by {@link ContractAddressValidator.getStats}. */
export interface ContractValidationStats {
  /** Total number of `validate` calls. */
  total: number;
  /** Number of calls that produced a valid result. */
  valid: number;
  /** Number of calls that produced an invalid result. */
  invalid: number;
  /** Number of calls served from the cache. */
  cached: number;
  /** Number of calls that invoked the on-chain verifier. */
  verified: number;
}

/**
 * Stateful Soroban contract address validation service.
 *
 * Combines the stateless {@link validateContractAddress} format/checksum
 * checks with optional on-chain verification and result caching, and tracks
 * aggregate validation counters.
 *
 * @example
 * ```ts
 * const validator = new ContractAddressValidator({
 *   verifier: async (addr) => rpcServer.getContractData(addr, ...).then(() => true, () => false),
 * });
 * const result = await validator.validate("C...");
 * ```
 */
export class ContractAddressValidator {
  private readonly verifier?: ContractVerifier;
  private readonly cacheTtlMs: number;
  private readonly cache: Cache<boolean>;
  private stats: ContractValidationStats = {
    total: 0,
    valid: 0,
    invalid: 0,
    cached: 0,
    verified: 0,
  };

  constructor(options: ContractAddressValidatorOptions = {}) {
    this.verifier = options.verifier;
    this.cacheTtlMs = options.cacheTtlMs ?? DEFAULT_VALIDATION_CACHE_TTL_MS;
    this.cache = options.cache ?? new Cache<boolean>();
  }

  /**
   * Validate a contract address.
   *
   * Format and checksum are checked first; the on-chain verifier (when
   * configured) is only invoked for format-valid addresses. Results are
   * cached by address. Never throws — verification failures are reported in
   * the returned result.
   *
   * @param address - Candidate contract address (any value; non-strings fail).
   */
  async validate(address: unknown): Promise<ContractValidationResult> {
    this.stats.total++;

    const base = validateContractAddress(address);
    const key = base.address;

    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.stats.cached++;
      const result: ContractValidationResult = {
        valid: cached,
        address: key,
        format: base.format,
        checksum: base.checksum,
        verified: cached && base.format && this.verifier !== undefined,
        cached: true,
        errors: cached ? [] : base.errors,
      };
      if (result.valid) {
        this.stats.valid++;
      } else {
        this.stats.invalid++;
      }
      return result;
    }

    const errors = [...base.errors];
    let verified = false;

    if (base.format && this.verifier) {
      this.stats.verified++;
      try {
        verified = await this.verifier(key);
        if (!verified) {
          errors.push("Contract address could not be verified on-chain");
        }
      } catch (err) {
        verified = false;
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Contract address verification failed: ${message}`);
      }
    }

    const valid = base.valid && (this.verifier ? verified : true);
    this.cache.set(key, valid, this.cacheTtlMs);

    if (valid) {
      this.stats.valid++;
    } else {
      this.stats.invalid++;
    }

    return {
      valid,
      address: key,
      format: base.format,
      checksum: base.checksum,
      verified,
      cached: false,
      errors,
    };
  }

  /**
   * Validate a contract address, throwing {@link InvalidContractAddressError}
   * with every violated rule when it is not valid.
   *
   * @param address - Candidate contract address string.
   * @throws {InvalidContractAddressError} If the address fails any rule.
   */
  async validateOrThrow(address: string): Promise<ContractValidationResult> {
    const result = await this.validate(address);
    if (!result.valid) {
      throw new InvalidContractAddressError(address, result.errors);
    }
    return result;
  }

  /** Return a snapshot of the aggregate validation counters. */
  getStats(): ContractValidationStats {
    return { ...this.stats };
  }

  /** Reset all aggregate validation counters to zero. */
  resetStats(): void {
    this.stats = { total: 0, valid: 0, invalid: 0, cached: 0, verified: 0 };
  }

  /** Clear every cached validation result. */
  clearCache(): void {
    this.cache.clear();
  }
}

// ---------------------------------------------------------------------------
// Module-level singleton (issue #1259) — convenience wrappers for callers
// that don't need a dedicated ContractAddressValidator instance.
// ---------------------------------------------------------------------------

let defaultValidator: ContractAddressValidator | undefined;

function getDefaultValidator(): ContractAddressValidator {
  defaultValidator ??= new ContractAddressValidator();
  return defaultValidator;
}

/** Validate a contract address using the shared default {@link ContractAddressValidator}, caching results. */
export function validateContractAddressCached(address: unknown): Promise<ContractValidationResult> {
  return getDefaultValidator().validate(address);
}

/** Clear the shared default validator's cache. */
export function clearContractAddressCache(): void {
  getDefaultValidator().clearCache();
}

/** Snapshot of the shared default validator's aggregate counters. */
export function getContractAddressValidationStats(): ContractValidationStats {
  return getDefaultValidator().getStats();
}
