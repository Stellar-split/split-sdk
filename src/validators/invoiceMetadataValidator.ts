/**
 * Invoice metadata JSON Schema validator.
 *
 * Invoices carry an open-ended `metadata` object for integrator-defined
 * fields (PO numbers, project codes, tax IDs, etc). Without validation,
 * malformed metadata silently propagates through storage, rendering, and
 * webhook delivery. This validator compiles an integrator-supplied JSON
 * Schema once and reuses it for every create/update call.
 */

import Ajv from "ajv";
import type { ErrorObject, ValidateFunction } from "ajv";
import { MetadataValidationError } from "../errors.js";

/** Result of validating a metadata payload against the registered schema. */
export interface MetadataValidationResult {
  valid: boolean;
  errors?: ErrorObject[];
}

/**
 * Validates invoice metadata against a JSON Schema registered at SDK
 * construction time. When no schema is configured, `validate()` is a no-op
 * that always reports success.
 */
export class InvoiceMetadataValidator {
  private readonly validateFn: ValidateFunction | null;
  private readonly throwOnInvalid: boolean;

  /**
   * @param schema         - JSON Schema object to validate metadata against. When
   *                         omitted, validation is a no-op.
   * @param throwOnInvalid - Whether {@link validate} throws
   *                         {@link MetadataValidationError} on failure. Defaults to true.
   */
  constructor(schema?: object, throwOnInvalid: boolean = true) {
    this.validateFn = schema ? new Ajv({ allErrors: true }).compile(schema) : null;
    this.throwOnInvalid = throwOnInvalid;
  }

  /**
   * Validate `metadata` against the registered schema.
   *
   * @throws {MetadataValidationError} When invalid and `throwOnInvalid` is true.
   */
  validate(metadata: unknown): MetadataValidationResult {
    if (!this.validateFn) {
      return { valid: true };
    }

    const valid = this.validateFn(metadata);
    if (valid) {
      return { valid: true };
    }

    const errors = this.validateFn.errors ?? [];
    if (this.throwOnInvalid) {
      throw new MetadataValidationError(errors);
    }
    return { valid: false, errors };
  }
}

/** Maximum allowed length for custom metadata keys. */
export const MAX_METADATA_KEY_LENGTH = 64;

/**
 * Validate that all custom metadata keys are within the allowed length.
 *
 * @param customKeys - Record of custom metadata key-value pairs.
 * @returns An object with `valid` boolean and optional `error` message.
 */
export function validateMetadataKeys(
  customKeys: Record<string, unknown> | undefined
): { valid: boolean; error?: string } {
  if (!customKeys) return { valid: true };

  for (const key of Object.keys(customKeys)) {
    if (key.length > MAX_METADATA_KEY_LENGTH) {
      return {
        valid: false,
        error: `Custom metadata key "${key}" exceeds maximum length of ${MAX_METADATA_KEY_LENGTH} characters (got ${key.length})`,
      };
    }

    const value = customKeys[key];
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const nested = value as Record<string, unknown>;
      for (const nestedKey of Object.keys(nested)) {
        if (nestedKey.length > MAX_METADATA_KEY_LENGTH) {
          return {
            valid: false,
            error: `Custom metadata key "${nestedKey}" exceeds maximum length of ${MAX_METADATA_KEY_LENGTH} characters (got ${nestedKey.length})`,
          };
        }
      }
    }
  }

  return { valid: true };
}
