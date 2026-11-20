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
 * - Soroban contract addresses (Issue #1259)
 */

export * from "./deadlineValidator.js";
export * from "./amountValidator.js";
export * from "./addressValidator.js";
export * from "./signatureValidator.js";
export * from "./splitRatioValidator.js";
export * from "./invoiceMetadataValidator.js";
export * from "./recipientDeduplicator.js";
export {
  ContractAddressValidator,
  validateContractAddress,
  isValidContractAddress,
  assertValidContractAddress,
} from "../contractAddressValidator.js";
export type {
  ContractAddressValidatorOptions,
  ContractAddressValidationResult,
} from "../contractAddressValidator.js";