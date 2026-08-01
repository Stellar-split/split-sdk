import { xdr } from "@stellar/stellar-sdk";

/**
 * Result of classifying two footprint key sets against each other.
 */
export interface FootprintDiff {
  /** Keys present in the minimal (simulation) set but absent from the original. */
  added: xdr.LedgerKey[];
  /** Keys present in the original footprint but absent from the minimal set. */
  removed: xdr.LedgerKey[];
  /** Keys present in both sets. */
  unchanged: xdr.LedgerKey[];
}

/**
 * Classifies the difference between an original declared footprint and the
 * minimal key set reported by a simulation.
 *
 * `original` is the set of ledger keys currently declared on the transaction
 * (read-only + read-write combined); `minimal` is the trimmed set reported by
 * `simulateTransaction`. Ledger keys are compared by their canonical base64
 * XDR encoding so structurally identical keys from different builders are
 * treated as the same key.
 *
 * @example
 * ```ts
 * const { added, removed, unchanged } = footprintDiff(
 *   [keyA, keyB],
 *   [keyB, keyC],
 * );
 * // removed === [keyA], added === [keyC], unchanged === [keyB]
 * ```
 */
export function footprintDiff(
  original: xdr.LedgerKey[],
  minimal: xdr.LedgerKey[],
): FootprintDiff {
  const originalByEncoding = new Map<string, xdr.LedgerKey>();
  for (const key of original) {
    originalByEncoding.set(key.toXDR("base64"), key);
  }

  const minimalByEncoding = new Map<string, xdr.LedgerKey>();
  for (const key of minimal) {
    minimalByEncoding.set(key.toXDR("base64"), key);
  }

  const added: xdr.LedgerKey[] = [];
  const removed: xdr.LedgerKey[] = [];
  const unchanged: xdr.LedgerKey[] = [];

  for (const [encoding, key] of originalByEncoding) {
    if (minimalByEncoding.has(encoding)) {
      unchanged.push(key);
    } else {
      removed.push(key);
    }
  }
  for (const [encoding, key] of minimalByEncoding) {
    if (!originalByEncoding.has(encoding)) {
      added.push(key);
    }
  }

  return { added, removed, unchanged };
}
