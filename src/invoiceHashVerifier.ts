/**
 * Invoice Hash Verifier — deterministic content hashing for invoice integrity.
 *
 * Computes SHA-256 hashes of canonically serialised (sorted-key JSON) invoice
 * data so that the SDK can detect tampering between creation and payment.
 * Uses Web Crypto API (crypto.subtle.digest) in browsers or Node's crypto
 * module, following the field-level canonicalisation patterns from src/merkle.ts.
 */

import type { Invoice } from "./types.js";

/**
 * Canonical invoice record used for hashing.
 * All fields are serialised with sorted keys to guarantee deterministic output
 * regardless of runtime key-insertion order.
 */
export interface InvoiceRecord extends Invoice {
  /** SHA-256 hex digest of the canonical invoice JSON, set at creation time. */
  contentHash?: string;
}

/**
 * Produce a deterministic, hex-encoded SHA-256 digest of an invoice.
 *
 * The invoice is serialised to JSON with keys sorted alphabetically (recursively),
 * then hashed with SHA-256. Whitespace in the JSON is normalised so that
 * semantically identical objects produce the same hash.
 *
 * @param invoice - Invoice to hash (without the contentHash field itself).
 * @returns Hex-encoded SHA-256 hash (64 hex characters).
 */
export async function hashInvoice(invoice: Invoice): Promise<string> {
  const canonical = canonicalJson(invoice);
  const hashHex = await sha256Hex(canonical);
  return hashHex;
}

/**
 * Verify that the computed hash of an invoice matches an expected hash.
 *
 * @param invoice      - Invoice whose integrity is being checked.
 * @param expectedHash - Previously computed hash to compare against.
 * @returns `true` when the hashes match, `false` otherwise (and logs a warning).
 */
export async function verifyInvoiceHash(
  invoice: Invoice,
  expectedHash: string,
): Promise<boolean> {
  const computed = await hashInvoice(invoice);
  if (computed !== expectedHash) {
    console.warn(
      `[invoiceHashVerifier] Hash mismatch for invoice ${invoice.id}: ` +
        `expected ${expectedHash.slice(0, 16)}…, got ${computed.slice(0, 16)}…`,
    );
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/**
 * Serialise an object to JSON with keys sorted recursively (canonical form).
 * Normalises whitespace away so the same logical invoice always hashes identically.
 */
function canonicalJson(value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "number") return String(value);
  if (typeof value === "boolean") return String(value);
  if (typeof value === "string") return JSON.stringify(value);

  if (Array.isArray(value)) {
    const items = value.map((v) => canonicalJson(v));
    return `[${items.join(",")}]`;
  }

  if (typeof value === "object") {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    const pairs = keys.map((k) => {
      const v = (value as Record<string, unknown>)[k];
      // Skip contentHash itself so we can hash an invoice at any time
      if (k === "contentHash") return null;
      return `${JSON.stringify(k)}:${canonicalJson(v)}`;
    });
    return `{${pairs.filter(Boolean).join(",")}}`;
  }

  return String(value);
}

/**
 * Compute SHA-256 hex digest of a string.
 * Uses Web Crypto API when available (browsers), Node crypto as fallback.
 */
async function sha256Hex(input: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(input);

  // Web Crypto API path (browsers, Deno, Node 19+)
  if (typeof globalThis.crypto !== "undefined" && globalThis.crypto.subtle) {
    const hashBuffer = await globalThis.crypto.subtle.digest("SHA-256", data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
  }

  // Node.js crypto fallback
  const { createHash } = await import("crypto");
  return createHash("sha256").update(data).digest("hex");
}
