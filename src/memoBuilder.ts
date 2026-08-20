/**
 * Structured memo builder for StellarSplit invoice payments.
 *
 * Encodes invoice ID, split protocol version, and payer identity into a
 * canonical memo format that fits within Stellar's 28-byte text memo limit.
 *
 * Format: `SS:v{version}:{invoiceId}:{payerSuffix}`
 * - "SS:" prefix (3 bytes) identifies StellarSplit memos
 * - `v{version}` – split protocol version
 * - `{invoiceId}` – the full invoice ID
 * - `{payerSuffix}` – last 8 characters of the payer G-address
 * - Total: 3 + len(version) + 1 + len(invoiceId) + 1 + 8 ≤ 28 bytes
 */

import { Memo } from "@stellar/stellar-sdk";
import type { ParsedMemo, SplitConfig } from "./types.js";

/** Magic prefix identifying StellarSplit-encoded memos. */
export const MEMO_PREFIX = "SS:";

/** Maximum length of a Stellar text memo in bytes. */
const MAX_MEMO_BYTES = 28;

/** Number of trailing payer-address characters stored in the memo. */
const PAYER_SUFFIX_LENGTH = 8;

/**
 * Build a canonical text memo encoding invoice ID, split version, and payer
 * identity for use with {@link TransactionBuilder.addMemo}.
 *
 * @param invoiceId - The invoice ID to encode.
 * @param config - Split configuration containing the protocol version.
 * @param payerAddress - Stellar G-address of the payer.
 * @returns A {@link Memo} instance suitable for transaction attachment.
 * @throws If the encoded memo exceeds Stellar's 28-byte text memo limit.
 */
export function buildMemo(
  invoiceId: string,
  config: SplitConfig,
  payerAddress: string,
): Memo {
  if (!payerAddress || payerAddress.length < PAYER_SUFFIX_LENGTH) {
    throw new Error(
      `Payer address must be at least ${PAYER_SUFFIX_LENGTH} characters`,
    );
  }

  const payerSuffix = payerAddress.slice(-PAYER_SUFFIX_LENGTH);
  const memo = `${MEMO_PREFIX}v${config.version}:${invoiceId}:${payerSuffix}`;

  const encoder = new TextEncoder();
  const bytes = encoder.encode(memo);
  if (bytes.length > MAX_MEMO_BYTES) {
    throw new Error(
      `Memo exceeds ${MAX_MEMO_BYTES} bytes (${bytes.length} bytes): "${memo}"`,
    );
  }

  return Memo.text(memo);
}

/**
 * Build a {@link Memo.hash} from the structured invoice payment data.
 *
 * Uses the first 32 bytes of the canonical UTF-8 encoding as the hash
 * memo value. Memo.hash allows up to 32 bytes and is useful when the
 * text representation would exceed the 28-byte limit.
 *
 * @param invoiceId - The invoice ID to encode.
 * @param config - Split configuration containing the protocol version.
 * @param payerAddress - Stellar G-address of the payer.
 * @returns A Memo.hash instance.
 */
export function buildHashMemo(
  invoiceId: string,
  config: SplitConfig,
  payerAddress: string,
): Memo {
  const encoder = new TextEncoder();
  const data = `${MEMO_PREFIX}v${config.version}:${invoiceId}:${payerAddress}`;
  const encoded = encoder.encode(data);
  // Take up to 32 bytes for the hash memo
  const hashBuffer = new Uint8Array(32);
  hashBuffer.set(encoded.slice(0, Math.min(encoded.length, 32)));
  return Memo.hash(Buffer.from(hashBuffer));
}

/**
 * Build a {@link Memo.id} from a numeric invoice ID.
 *
 * Memo.id stores a uint64 identifier directly on the ledger. This is
 * the most space-efficient option when only the invoice ID is needed.
 *
 * @param invoiceId - Numeric invoice ID (must fit in uint64).
 * @returns A Memo.id instance.
 */
export function buildIdMemo(invoiceId: string | number): Memo {
  const id = BigInt(invoiceId);
  return Memo.id(id.toString());
}

/**
 * Parse a Stellar memo back into its structured components.
 *
 * Attempts to extract invoice ID, version, and payer suffix from the
 * canonical `SS:v{version}:{invoiceId}:{payerSuffix}` format.
 *
 * @param memo - The Stellar memo to parse.
 * @returns A {@link ParsedMemo} with extracted fields.
 * @throws If the memo is not a text memo or does not match the expected format.
 */
export function parseMemo(memo: Memo): ParsedMemo {
  if (memo.type !== "text") {
    throw new Error(
      `Cannot parse memo of type "${memo.type}": only text memos are supported`,
    );
  }

  const value = memo.value as string;
  if (!value || !value.startsWith(MEMO_PREFIX)) {
    throw new Error(
      `Memo does not start with expected prefix "${MEMO_PREFIX}": "${value}"`,
    );
  }

  const payload = value.slice(MEMO_PREFIX.length); // e.g. "v1:42:ABCDEFGH"
  const versionMatch = payload.match(/^v(\d+):/);
  if (!versionMatch) {
    throw new Error(`Invalid memo format: missing version in "${value}"`);
  }

  const version = parseInt(versionMatch[1]!, 10);
  const afterVersion = payload.slice(versionMatch[0].length); // e.g. "42:ABCDEFGH"

  const lastColon = afterVersion.lastIndexOf(":");
  if (lastColon < 0) {
    throw new Error(`Invalid memo format: missing payer suffix in "${value}"`);
  }

  const invoiceId = afterVersion.slice(0, lastColon);
  const payerId = afterVersion.slice(lastColon + 1);

  if (!invoiceId) {
    throw new Error(`Invalid memo format: empty invoice ID in "${value}"`);
  }

  if (payerId.length !== PAYER_SUFFIX_LENGTH) {
    throw new Error(
      `Invalid memo format: payer suffix must be ${PAYER_SUFFIX_LENGTH} characters in "${value}"`,
    );
  }

  return { invoiceId, version, payerId };
}

/**
 * Check whether a Memo matches the StellarSplit canonical format
 * without throwing.
 *
 * @param memo - The memo to check.
 * @returns True if the memo is a text memo starting with the "SS:" prefix.
 */
export function isStellarSplitMemo(memo: Memo): boolean {
  if (memo.type !== "text") return false;
  const value = memo.value as string;
  return typeof value === "string" && value.startsWith(MEMO_PREFIX);
}

// ---------------------------------------------------------------------------
// #610 — Simple invoice payment memo builder and parser
// ---------------------------------------------------------------------------

const PAYMENT_MEMO_PREFIX = "split:";
const MAX_TEXT_MEMO_BYTES = 28;

/**
 * Build a canonical text memo string for an invoice payment.
 *
 * Format: `split:{invoiceId}` base case, or `split:{invoiceId}:t{tranche}`
 * when a tranche number is provided. The result is truncated to 28 bytes
 * (Stellar text memo limit) — the truncation avoids cutting a multi-byte UTF-8
 * character in the middle.
 *
 * @param invoiceId - The invoice ID to encode.
 * @param opts - Optional tranche number.
 * @returns A string no longer than 28 bytes when UTF-8 encoded.
 */
export function buildPaymentMemo(
  invoiceId: string,
  opts?: { tranche?: number },
): string {
  let memo = opts?.tranche !== undefined
    ? `${PAYMENT_MEMO_PREFIX}${invoiceId}:t${opts.tranche}`
    : `${PAYMENT_MEMO_PREFIX}${invoiceId}`;

  // Truncate to 28 bytes, avoiding mid-UTF-8-character cut
  while (Buffer.byteLength(memo, "utf8") > MAX_TEXT_MEMO_BYTES) {
    // Remove the last character (handles surrogate pairs as a unit)
    const lastChar = memo.codePointAt(memo.length - 1);
    memo = memo.slice(0, -(lastChar !== undefined && memo.length > 1 && memo.codePointAt(memo.length - 2)! >= 0xd800 && lastChar <= 0xdfff ? 2 : 1));
  }

  return memo;
}

/**
 * Parse a payment memo string back into its components.
 *
 * @param memo - The memo string to parse.
 * @returns An object with `invoiceId` and optional `tranche`, or `null` if the
 *   memo does not start with the `split:` prefix.
 */
export function parsePaymentMemo(
  memo: string,
): { invoiceId: string; tranche?: number } | null {
  if (!memo.startsWith(PAYMENT_MEMO_PREFIX)) {
    return null;
  }

  const payload = memo.slice(PAYMENT_MEMO_PREFIX.length); // e.g. "inv_123:t1"

  // Check for tranche pattern: ":t<NUMBER>" at the end
  const trancheMatch = payload.match(/^(.+?):t(\d+)$/);
  if (trancheMatch) {
    return {
      invoiceId: trancheMatch[1]!,
      tranche: parseInt(trancheMatch[2]!, 10),
    };
  }

  return { invoiceId: payload };
}
