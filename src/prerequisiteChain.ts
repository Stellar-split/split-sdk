import type { Invoice, PrerequisiteChainEntry } from "./types.js";
import { ChainTooDeepError, CircularPrerequisiteError } from "./errors.js";

/** Minimal client interface needed to traverse a prerequisite chain. */
interface PrerequisiteChainClient {
  getInvoice(id: string): Promise<Invoice>;
}

/** Maximum prerequisite chain depth before {@link ChainTooDeepError} is thrown. */
export const MAX_PREREQUISITE_CHAIN_DEPTH = 20;

/**
 * Traverse the `prerequisite_id` chain for an invoice and return the full
 * dependency list in order, flagging which prerequisites are still blocking.
 *
 * The starting invoice itself is not included — only its prerequisites are.
 * Entries are returned root-first (the deepest prerequisite appears first),
 * matching natural dependency order.
 *
 * Intermediate invoice fetches are cached so a shared `cache` can be reused
 * across calls to minimise RPC round trips. Circular chains raise
 * {@link CircularPrerequisiteError}; chains deeper than
 * {@link MAX_PREREQUISITE_CHAIN_DEPTH} raise {@link ChainTooDeepError}.
 *
 * @param invoiceId - The invoice whose prerequisite chain to resolve.
 * @param client    - A client that can fetch invoices.
 * @param cache     - Optional invoice cache reused across traversals.
 * @returns The dependency chain in order.
 */
export async function resolvePrerequisiteChain(
  invoiceId: string,
  client: PrerequisiteChainClient,
  cache: Map<string, Invoice> = new Map()
): Promise<PrerequisiteChainEntry[]> {
  const fetch = async (id: string): Promise<Invoice> => {
    const cached = cache.get(id);
    if (cached) return cached;
    const invoice = await client.getInvoice(id);
    cache.set(id, invoice);
    return invoice;
  };

  const visited = new Set<string>([invoiceId]);
  const chain: PrerequisiteChainEntry[] = [];

  let current = await fetch(invoiceId);
  let depth = 0;

  while (current.prerequisite_id) {
    depth += 1;
    if (depth > MAX_PREREQUISITE_CHAIN_DEPTH) {
      throw new ChainTooDeepError(MAX_PREREQUISITE_CHAIN_DEPTH);
    }

    const nextId = current.prerequisite_id;
    if (visited.has(nextId)) {
      throw new CircularPrerequisiteError(nextId);
    }
    visited.add(nextId);

    const prerequisite = await fetch(nextId);
    chain.push({
      id: prerequisite.id,
      status: prerequisite.status,
      isBlocking: prerequisite.status !== "Released",
    });

    current = prerequisite;
  }

  // Root-first dependency order.
  return chain.reverse();
}
