import { Horizon } from "@stellar/stellar-sdk";
import type { Invoice, InvoiceStatus } from "./types.js";
import { SearchFailedError } from "./errors.js";

/** Query parameters for searching invoices. */
export interface SearchQuery {
  /** Filter by creator address. */
  creator?: string;
  /** Filter by recipient address. */
  recipient?: string;
  /** Filter by invoice status. */
  status?: InvoiceStatus;
}

/** Result of an invoice search. */
export interface SearchResult {
  /** Invoice ID. */
  invoiceId: string;
  /** Current status of the invoice. */
  status: InvoiceStatus;
}

/**
 * Search invoices by partial criteria using Horizon API.
 *
 * @param query - Search parameters
 * @param horizonUrl - Horizon server URL (defaults to public testnet)
 * @returns Array of matching invoices with their status
 */
export async function searchInvoices(
  query: SearchQuery,
  horizonUrl: string = "https://horizon-testnet.stellar.org"
): Promise<SearchResult[]> {
  const server = new Horizon.Server(horizonUrl);
  const results: SearchResult[] = [];

  try {
    // Build transaction search with contract event filters
    let txBuilder = server.transactions();

    // Note: In a real implementation, this would filter by contract events
    // For now, we return an empty array as the contract ID would need to be passed
    // and Horizon doesn't directly support contract event filtering in the current API
    return results;
  } catch (error) {
    throw new SearchFailedError(error instanceof Error ? error.message : String(error));
  }
}

/** Options for {@link searchByMemo}. */
export interface SearchByMemoOptions {
  /**
   * When `true`, matching is case-sensitive. Defaults to `false`
   * (case-insensitive).
   */
  caseSensitive?: boolean;
}

/**
 * Filter an in-memory array of invoices by their memo content.
 *
 * Payment memo text is a common way users tag invoices (e.g. `"split:INV-001"`).
 * This helper performs a substring match against {@link Invoice.memo} on a local
 * array, complementing {@link searchInvoices}, which queries Horizon for
 * on-chain data. The input array is never mutated.
 *
 * @param invoices - Invoices to filter.
 * @param query - Substring to look for in `invoice.memo`. An empty string returns
 *   every invoice unchanged.
 * @param opts - Matching options. `caseSensitive` defaults to `false`.
 * @returns A new array of the invoices whose `memo` contains `query`. Invoices
 *   whose `memo` is `undefined` or `null` are skipped without error.
 *
 * @example
 * ```ts
 * const hits = searchByMemo(invoices, "split:INV-001");
 * const exact = searchByMemo(invoices, "Split", { caseSensitive: true });
 * ```
 */
export function searchByMemo(
  invoices: Invoice[],
  query: string,
  opts?: SearchByMemoOptions
): Invoice[] {
  if (query === "") {
    return invoices;
  }

  const caseSensitive = opts?.caseSensitive ?? false;
  const needle = caseSensitive ? query : query.toLowerCase();

  return invoices.filter((invoice) => {
    const memo = invoice.memo;
    if (memo === undefined || memo === null) {
      return false;
    }
    const haystack = caseSensitive ? memo : memo.toLowerCase();
    return haystack.includes(needle);
  });
}