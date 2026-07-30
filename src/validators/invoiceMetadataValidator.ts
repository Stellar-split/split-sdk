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
