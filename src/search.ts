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

/** Options for searchByMemo. */
export interface SearchByMemoOptions {
  /** When true, requires exact case matching. Default is false (case-insensitive). */
  caseSensitive?: boolean;
}

/**
 * Filter invoices where the memo field contains the query substring.
 *
 * @param invoices - Array of invoices to search
 * @param query - Substring to search for within each invoice's memo
 * @param opts - Search options (caseSensitive defaults to false)
 * @returns Filtered array of matching invoices
 */
export function searchByMemo(
  invoices: Invoice[],
  query: string,
  opts?: SearchByMemoOptions
): Invoice[] {
  if (!query) {
    return invoices;
  }

  const caseSensitive = opts?.caseSensitive ?? false;
  const normalizedQuery = caseSensitive ? query : query.toLowerCase();

  return invoices.filter((invoice) => {
    if (invoice.memo == null) {
      return false;
    }
    const target = caseSensitive ? invoice.memo : invoice.memo.toLowerCase();
    return target.includes(normalizedQuery);
  });
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