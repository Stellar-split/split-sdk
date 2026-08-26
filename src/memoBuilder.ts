/**
 * Helpers for building and parsing Stellar transaction memos used on invoice
 * payment transactions.
 *
 * Stellar memo text is limited to 28 bytes (UTF-8). `buildPaymentMemo`
 * truncates at the last full character boundary that keeps the result within
 * that limit. `parsePaymentMemo` handles truncated memos gracefully: if the
 * tranche suffix was cut off the tranche is simply absent from the result; if
 * the invoiceId was itself truncated the truncated value is returned.
 */

const MEMO_PREFIX = "split:";
const MEMO_MAX_BYTES = 28;

/**
 * Truncate `str` so that Buffer.byteLength(result, 'utf8') <= maxBytes,
 * never cutting in the middle of a multi-byte UTF-8 sequence.
 */
function truncateToBytes(str: string, maxBytes: number): string {
  if (Buffer.byteLength(str, "utf8") <= maxBytes) return str;
  // Walk character-by-character (handles surrogate pairs via codePointAt)
  let bytes = 0;
  let i = 0;
  while (i < str.length) {
    const cp = str.codePointAt(i)!;
    // Determine byte width of this code point in UTF-8
    const charBytes = cp > 0xffff ? 4 : cp > 0x7ff ? 3 : cp > 0x7f ? 2 : 1;
    if (bytes + charBytes > maxBytes) break;
    bytes += charBytes;
    i += cp > 0xffff ? 2 : 1; // surrogate pairs occupy 2 JS chars
  }
  return str.slice(0, i);
}

/**
 * Build a Stellar memo string for a split payment transaction.
 *
 * Format: `split:{invoiceId}` or `split:{invoiceId}:t{tranche}`
 *
 * The result is guaranteed to be ≤ 28 bytes (UTF-8). If the full string
 * exceeds 28 bytes it is truncated at the last full character boundary.
 */
export function buildPaymentMemo(
  invoiceId: string,
  opts?: { tranche?: number }
): string {
  const base =
    opts?.tranche !== undefined
      ? `${MEMO_PREFIX}${invoiceId}:t${opts.tranche}`
      : `${MEMO_PREFIX}${invoiceId}`;
  return truncateToBytes(base, MEMO_MAX_BYTES);
}

/**
 * Parse a Stellar memo produced by `buildPaymentMemo`.
 *
 * Returns `null` for any memo that does not start with the `split:` prefix.
 *
 * Edge-case behaviour for truncated memos:
 * - If truncation removed the entire `:t{tranche}` suffix the result has no
 *   `tranche` field.
 * - If truncation removed only part of the `:t{tranche}` suffix (e.g. cut
 *   inside the digits) the tranche field is omitted and the invoiceId is
 *   returned as-is up to the last `:t` boundary.
 * - If truncation cut into the invoiceId itself the truncated invoiceId is
 *   returned without a tranche.
 */
export function parsePaymentMemo(
  memo: string
): { invoiceId: string; tranche?: number } | null {
  if (!memo.startsWith(MEMO_PREFIX)) return null;

  const body = memo.slice(MEMO_PREFIX.length); // everything after "split:"

  // Look for the tranche separator ":t" followed by digits
  const trancheMatch = body.match(/^(.*):t(\d+)$/);
  if (trancheMatch) {
    const invoiceId = trancheMatch[1]!;
    const tranche = parseInt(trancheMatch[2]!, 10);
    return { invoiceId, tranche };
  }

  // No tranche — plain invoiceId (may be truncated, but we return it as-is)
  return { invoiceId: body };
}
