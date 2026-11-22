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
 */

export * from "./deadlineValidator.js";
export * from "./amountValidator.js";
export * from "./addressValidator.js";
export * from "./signatureValidator.js";
export * from "./splitRatioValidator.js";
export * from "./invoiceMetadataValidator.js";
export * from "./recipientDeduplicator.js";

// Signature validation tracking and scheme APIs (Issue #1255)
export {
  validateSignature,
  getValidationStats as getSignatureValidationStats,
} from "./signatureValidator.js";

// Address validation tracking and account verification APIs (Issue #1256)
export {
  getAddressValidationStats,
  verifyAccountExists,
} from "./addressValidator.js";

// Amount validation tracking APIs (Issue #1257)
export {
  getAmountValidationStats,
} from "./amountValidator.js";

// Deadline validation tracking APIs (Issue #1258)
export {
  getDeadlineValidationStats,
} from "./deadlineValidator.js";