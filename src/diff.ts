/**
 * Invoice diff utility — compare two invoice states.
 * 
 * Pure function with no RPC calls or side effects.
 * Returns structured diff showing only changed fields.
 */

import type { Invoice } from "./types.js";

/**
 * A single field change in an invoice diff.
 */
export interface InvoiceDiffEntry {
  /** The field name that changed. */
  field: string;
  /** The value before the change. */
  before: unknown;
  /** The value after the change. */
  after: unknown;
}

/**
 * Type alias for the diff result array.
 */
export type InvoiceDiff = InvoiceDiffEntry[];

/**
 * Check if a value is a plain object (not null, not array, not Date, etc.).
 */
function isPlainObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null && !Array.isArray(val) && !(val instanceof Date);
}

/**
 * Compare two values for equality, with special handling for bigint.
 */
function valuesEqual(a: unknown, b: unknown): boolean {
  // Handle bigint comparison numerically
  if (typeof a === "bigint" && typeof b === "bigint") {
    return a === b;
  }
  
  // Handle bigint vs number (convert number to bigint for comparison)
  if (typeof a === "bigint" && typeof b === "number") {
    return a === BigInt(b);
  }
  
  if (typeof a === "number" && typeof b === "bigint") {
    return BigInt(a) === b;
  }
  
  // Handle arrays
  if (Array.isArray(a) && Array.isArray(b)) {
    return arraysEqual(a, b);
  }
  
  // Handle plain objects
  if (isPlainObject(a) && isPlainObject(b)) {
    return objectsEqual(a, b);
  }
  
  // Handle primitives and other types
  return a === b;
}

/**
 * Deep equality check for arrays.
 */
function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, i) => valuesEqual(val, b[i]));
}

/**
 * Deep equality check for plain objects.
 */
function objectsEqual(a: Record<string, unknown>, b: Record<string, unknown>): boolean {
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  
  if (keysA.length !== keysB.length) return false;
  
  return keysA.every(key => {
    if (!(key in b)) return false;
    return valuesEqual(a[key], b[key]);
  });
}

/**
 * All possible invoice fields to compare.
 */
const INVOICE_FIELDS: Array<keyof Invoice> = [
  "id",
  "creator",
  "recipients",
  "token",
  "deadline",
  "funded",
  "status",
  "payments",
  "recurring",
  "memo",
  "scheduledReleaseDate",
  "clonedFrom",
  "groupId",
  "lastModifiedLedger",
  "prerequisites",
  "parentInvoiceId",
  "cloneDepth",
  "nft_gate",
  "forward_invoice_id",
  "penalty_deadline",
  "penalty_tiers",
  "allowed_callers",
  "split_rules",
  "auto_resolve_rules",
  "prerequisite_id",
];

/**
 * Compare two invoice objects and return a structured diff.
 * 
 * Pure function with no RPC calls or side effects. Only changed fields are listed.
 * Handles nested objects (recipients list, options), arrays (payment history),
 * and bigint fields (compared numerically, not by reference).
 * 
 * @param a - The first invoice (typically the "before" or older state).
 * @param b - The second invoice (typically the "after" or newer state).
 * @returns Array of changed fields with before and after values.
 * 
 * @example
 * ```typescript
 * const oldInvoice = await client.getInvoice("123");
 * // ... time passes ...
 * const newInvoice = await client.getInvoice("123");
 * 
 * const diff = diffInvoices(oldInvoice, newInvoice);
 * console.log(diff);
 * // [
 * //   { field: "funded", before: 1000000n, after: 2000000n },
 * //   { field: "status", before: "Pending", after: "Released" }
 * // ]
 * ```
 */
export function diffInvoices(a: Invoice, b: Invoice): InvoiceDiff {
  const diff: InvoiceDiff = [];
  
  for (const field of INVOICE_FIELDS) {
    const before = a[field];
    const after = b[field];
    
    // Skip if both are undefined
    if (before === undefined && after === undefined) {
      continue;
    }
    
    // If one is undefined and the other isn't, it's a change
    if (before === undefined || after === undefined) {
      if (before !== after) {
        diff.push({ field, before, after });
      }
      continue;
    }
    
    // Compare values
    if (!valuesEqual(before, after)) {
      diff.push({ field, before, after });
    }
  }
  
  return diff;
}

/**
 * Convenience function to check if two invoices have any differences.
 * 
 * @param a - The first invoice.
 * @param b - The second invoice.
 * @returns `true` if the invoices differ, `false` if they are identical.
 * 
 * @example
 * ```typescript
 * if (hasDiff(cachedInvoice, freshInvoice)) {
 *   console.log("Invoice has changed, updating cache...");
 *   updateCache(freshInvoice);
 * }
 * ```
 */
export function hasDiff(a: Invoice, b: Invoice): boolean {
  return diffInvoices(a, b).length > 0;
}
