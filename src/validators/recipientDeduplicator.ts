/**
 * Recipient Deduplicator — detects and consolidates duplicate Stellar account
 * IDs in invoice split configurations.
 *
 * Prevents double-payment of the same account by either merging duplicate
 * entries (summing their ratios) or rejecting them outright.
 */

import { DuplicateRecipientError } from "../errors.js";
import type { Recipient } from "../types.js";

/**
 * Deduplication mode.
 *
 * - `merge`  – Consolidate duplicate accounts by summing their ratios.
 * - `reject` – Throw DuplicateRecipientError when duplicates are found.
 */
export type DedupMode = "merge" | "reject";

/**
 * Normalise a Stellar account ID for case-insensitive comparison.
 * Stellar account IDs start with 'G' and are base32-encoded, but callers
 * sometimes pass them in mixed case.
 */
function normalizeAccountId(address: string): string {
  return address.toUpperCase();
}

/**
 * Deduplicate a list of recipients.
 *
 * In `merge` mode, duplicate account IDs have their `amount` values summed
 * and appear as a single entry.  In `reject` mode, any duplicate throws
 * a {@link DuplicateRecipientError}.
 *
 * Comparison is case-insensitive — both "GABC..." and "gabc..." are treated
 * as the same account.
 *
 * @param recipients - The raw list of recipient shares.
 * @param mode       - How to handle duplicates.
 * @returns A deduplicated list of recipients.
 * @throws DuplicateRecipientError when mode is `reject` and duplicates exist.
 */
export function deduplicateRecipients(
  recipients: Recipient[],
  mode: DedupMode = "merge"
): Recipient[] {
  // Count occurrences of each normalized address
  const counts = new Map<string, number>();
  const firstEntry = new Map<string, Recipient>();

  for (const r of recipients) {
    const norm = normalizeAccountId(r.address);
    counts.set(norm, (counts.get(norm) ?? 0) + 1);
    if (!firstEntry.has(norm)) {
      firstEntry.set(norm, { address: r.address, amount: r.amount });
    } else if (mode === "merge") {
      const existing = firstEntry.get(norm)!;
      existing.amount += r.amount;
    }
  }

  if (mode === "reject") {
    const duplicates: string[] = [];
    for (const [norm, count] of counts) {
      if (count > 1) {
        duplicates.push(firstEntry.get(norm)!.address);
      }
    }
    if (duplicates.length > 0) {
      throw new DuplicateRecipientError(duplicates);
    }
  }

  // Return entries in original order (first occurrence of each address)
  const result: Recipient[] = [];
  const added = new Set<string>();
  for (const r of recipients) {
    const norm = normalizeAccountId(r.address);
    if (added.has(norm)) continue;
    result.push(firstEntry.get(norm)!);
    added.add(norm);
  }

  return result;
}
