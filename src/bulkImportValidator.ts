import type { CreateInvoiceParams } from "./types.js";

/**
 * Schema versions that this SDK version accepts for bulk import payloads.
 * Callers can inspect this list to pre-screen payloads before submission.
 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly number[] = [1, 2];

/**
 * Describes a single validation error on a specific row and field.
 */
export interface BulkImportRowError {
  /** Zero-based row index in the input array. */
  row: number;
  /** The field that failed validation. */
  field: string;
  /** Human-readable description of the problem. */
  message: string;
}

/**
 * Result returned by {@link validateBulkImport}.
 */
export interface BulkImportValidationResult {
  /** Indices (zero-based) of rows that passed all validations. */
  validRows: number[];
  /** All validation errors collected across every row. */
  errors: BulkImportRowError[];
}

/**
 * A bulk import payload that carries a `schemaVersion` alongside the rows.
 * When this overload is used the version is validated before row-level checks.
 */
export interface BulkImportPayload {
  /** Must be one of the values in {@link SUPPORTED_SCHEMA_VERSIONS}. */
  schemaVersion: number;
  rows: CreateInvoiceParams[];
}

/**
 * Validate an array of invoice-creation rows (or a versioned payload) against
 * the same constraints the contract's `_create_invoice_inner` enforces:
 *
 * 0. **Schema version present and supported** – when a
 *    {@link BulkImportPayload} is supplied, `schemaVersion` must appear in
 *    {@link SUPPORTED_SCHEMA_VERSIONS}.  Absent or unsupported versions cause
 *    an immediate error before any row-level validation runs.
 * 1. **Positive amounts** – every recipient amount must be > 0.
 * 2. **Recipients present** – `recipients` array must not be empty.
 * 3. **Future deadline** – `deadline` must be in the future (greater than
 *    `Date.now() / 1000`).
 *
 * Unlike a fail-fast approach, *all* rows are always validated so the caller
 * can surface every problem in one pass.
 *
 * @param input - Either a raw array of {@link CreateInvoiceParams} rows, or a
 *   {@link BulkImportPayload} object that also carries a `schemaVersion`.
 * @returns A {@link BulkImportValidationResult} with valid row indices and
 *          collected per-row errors.
 */
export function validateBulkImport(
  input: CreateInvoiceParams[] | BulkImportPayload,
): BulkImportValidationResult {
  // Unwrap a versioned payload, validating the schema version first.
  let rows: CreateInvoiceParams[];

  if (Array.isArray(input)) {
    rows = input;
  } else {
    const { schemaVersion, rows: payloadRows } = input;

    if (schemaVersion === undefined || schemaVersion === null) {
      return {
        validRows: [],
        errors: [
          {
            row: -1,
            field: "schemaVersion",
            message:
              `schemaVersion is required. Supported versions: [${SUPPORTED_SCHEMA_VERSIONS.join(", ")}]`,
          },
        ],
      };
    }

    if (!(SUPPORTED_SCHEMA_VERSIONS as readonly number[]).includes(schemaVersion)) {
      return {
        validRows: [],
        errors: [
          {
            row: -1,
            field: "schemaVersion",
            message:
              `Unsupported schemaVersion ${schemaVersion}. Supported versions: [${SUPPORTED_SCHEMA_VERSIONS.join(", ")}]`,
          },
        ],
      };
    }

    rows = payloadRows;
  }

  // --- row-level validation (unchanged) ---
  const validRows: number[] = [];
  const errors: BulkImportRowError[] = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    let rowValid = true;

    // --- recipients must be present ---
    if (!row.recipients || row.recipients.length === 0) {
      errors.push({
        row: i,
        field: "recipients",
        message: "Recipients array must not be empty",
      });
      rowValid = false;
    } else {
      // --- every recipient amount must be positive ---
      for (let j = 0; j < row.recipients.length; j++) {
        const recipient = row.recipients[j];
        if (recipient.amount <= 0n) {
          errors.push({
            row: i,
            field: `recipients[${j}].amount`,
            message: `Recipient amount must be positive, got ${recipient.amount}`,
          });
          rowValid = false;
        }
      }
    }

    // --- deadline must be in the future ---
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (row.deadline <= nowSeconds) {
      errors.push({
        row: i,
        field: "deadline",
        message: `Deadline must be in the future, got ${row.deadline} but current time is ${nowSeconds}`,
      });
      rowValid = false;
    }

    if (rowValid) {
      validRows.push(i);
    }
  }

  return { validRows, errors };
}
