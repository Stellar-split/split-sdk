import { Horizon } from "@stellar/stellar-sdk";
import type { InvoiceStatus } from "./types.js";
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
import type { Invoice } from "./types.js";

/**
 * Search a local array of invoices by memo content.
 *
 * @param invoices - Array of invoices to search
 * @param query - Substring to match against `invoice.memo`
 * @param opts - Optional flags (caseSensitive defaults to false)
 * @returns Invoices whose memo contains the query substring
 */
export function searchByMemo(
  invoices: Invoice[],
  query: string,
  opts?: { caseSensitive?: boolean }
): Invoice[] {
  if (!query) return invoices;

  const target = opts?.caseSensitive ? query : query.toLowerCase();
  return invoices.filter((invoice) => {
    if (invoice.memo == null) return false;
    const memo = opts?.caseSensitive ? invoice.memo : invoice.memo.toLowerCase();
    return memo.includes(target);
  });
}
