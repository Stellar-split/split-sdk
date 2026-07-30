import type { CreateInvoiceParams } from "./types.js";

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
 * Validate an array of invoice-creation rows against the same constraints
 * the contract's `_create_invoice_inner` enforces:
 *
 * 1. **Positive amounts** – every recipient amount must be > 0.
 * 2. **Recipients present** – `recipients` array must not be empty.
 * 3. **Future deadline** – `deadline` must be in the future (greater than
 *    `Date.now() / 1000`).
 *
 * Unlike a fail-fast approach, *all* rows are always validated so the caller
 * can surface every problem in one pass.
 *
 * @param rows - Array of {@link CreateInvoiceParams}-like objects to validate.
 * @returns A {@link BulkImportValidationResult} with valid row indices and
 *          collected per-row errors.
 */
export function validateBulkImport(
  rows: CreateInvoiceParams[],
): BulkImportValidationResult {
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
