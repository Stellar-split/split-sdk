/**
 * Invoice enrichment module for fetching and merging IPFS metadata.
 *
 * Provides functionality to:
 * - Enrich invoices with IPFS metadata
 * - Parse IPFS CIDs from invoice memos
 * - Merge on-chain invoice data with off-chain metadata
 */

import type { Invoice, InvoiceMetadata, IPFSConfig } from "./types.js";
import { InvoiceFetcherNotRegisteredError } from "./errors.js";
import { parseIPFSCid, fetchInvoiceMetadata, verifyCID } from "./ipfs.js";

/**
 * An invoice enriched with resolved IPFS metadata.
 */
export interface EnrichedInvoice extends Invoice {
  /** The resolved IPFS metadata, or null if not available. */
  metadata: InvoiceMetadata | Record<string, unknown> | null;
  /** The CID that was resolved, if any. */
  metadataCID?: string;
  /** Whether the metadata content was verified against the CID. */
  metadataVerified?: boolean;
}

/** Function type for fetching an invoice by ID. */
export type InvoiceFetcher = (invoiceId: string) => Promise<Invoice>;

/** Global invoice fetcher registration. */
let invoiceFetcher: InvoiceFetcher | null = null;

/**
 * Register a global invoice fetcher function.
 *
 * @param fetcher - Function that fetches an invoice by ID.
 */
export function registerInvoiceFetcher(fetcher: InvoiceFetcher): void {
  invoiceFetcher = fetcher;
}

/**
 * Parse an IPFS CID from an invoice memo.
 * Supports formats: "ipfs:Qm...", "ipfs:bafy...", etc.
 *
 * @deprecated Use parseIPFSCid from ipfs.ts instead.
 * @param memo - The memo string to parse.
 * @returns The extracted CID or null if not found.
 */
function parseIpfsCid(memo?: string): string | null {
  return parseIPFSCid(memo);
}

/**
 * Fetch IPFS metadata from a public gateway.
 * This is a legacy function for backward compatibility.
 *
 * @param cid - The CID to fetch.
 * @returns The parsed metadata or null if fetch fails.
 */
async function fetchIpfsMetadata(cid: string): Promise<Record<string, unknown> | null> {
  const url = `https://ipfs.io/ipfs/${cid}`;
  try {
    const response = await fetch(url);
    if (!response.ok) {
      return null;
    }

    const payload = await response.json();
    if (typeof payload !== "object" || payload === null) {
      return null;
    }

    return payload as Record<string, unknown>;
  } catch {
    return null;
  }
}

/**
 * Options for enriching an invoice.
 */
export interface EnrichOptions {
  /** IPFS configuration override. */
  ipfsConfig?: Partial<IPFSConfig>;
  /** Whether to verify the metadata content against the CID. */
  verifyContent?: boolean;
  /** Whether to throw errors or return null metadata on failure. */
  throwOnError?: boolean;
}

/**
 * Enrich an invoice with resolved IPFS metadata.
 *
 * Fetches the invoice using the provided fetcher (or global fetcher),
 * extracts the IPFS CID from the memo field, fetches the metadata,
 * and returns a merged object.
 *
 * @param invoiceId - The invoice ID to enrich.
 * @param getInvoice - Optional invoice fetcher function.
 * @param options - Optional enrichment options.
 * @returns The enriched invoice with metadata.
 * @throws {InvoiceFetcherNotRegisteredError} If no fetcher is available.
 */
export async function enrichInvoice(
  invoiceId: string,
  getInvoice?: InvoiceFetcher,
  options?: EnrichOptions
): Promise<EnrichedInvoice> {
  const fetcher = getInvoice ?? invoiceFetcher;
  if (!fetcher) {
    throw new InvoiceFetcherNotRegisteredError();
  }

  const invoice = await fetcher(invoiceId);
  const cid = parseIpfsCid(invoice.memo);

  if (!cid) {
    return {
      ...invoice,
      metadata: null,
    };
  }

  try {
    // Try to fetch structured metadata first
    let metadata: InvoiceMetadata | Record<string, unknown> | null = null;
    let verified = false;

    if (options?.ipfsConfig) {
      // Use the new IPFS module with custom config
      metadata = await fetchInvoiceMetadata(cid, options.ipfsConfig);

      if (options.verifyContent && metadata) {
        verified = await verifyCID(cid, metadata, options.ipfsConfig);
      }
    } else {
      // Use legacy gateway fetch for backward compatibility
      metadata = await fetchIpfsMetadata(cid);
    }

    return {
      ...invoice,
      metadata,
      metadataCID: cid,
      metadataVerified: options?.verifyContent ? verified : undefined,
    };
  } catch (err) {
    if (options?.throwOnError) {
      throw err;
    }

    return {
      ...invoice,
      metadata: null,
      metadataCID: cid,
      metadataVerified: false,
    };
  }
}

/**
 * Enrich multiple invoices in parallel.
 *
 * @param invoiceIds - Array of invoice IDs to enrich.
 * @param getInvoice - Optional invoice fetcher function.
 * @param options - Optional enrichment options.
 * @returns Array of enriched invoices.
 */
export async function enrichInvoices(
  invoiceIds: string[],
  getInvoice?: InvoiceFetcher,
  options?: EnrichOptions
): Promise<EnrichedInvoice[]> {
  return Promise.all(
    invoiceIds.map((id) => enrichInvoice(id, getInvoice, options))
  );
}

/**
 * Check if an invoice has IPFS metadata attached.
 *
 * @param invoice - The invoice to check.
 * @returns True if the invoice memo contains an IPFS CID.
 */
export function hasIPFSMetadata(invoice: Invoice): boolean {
  return parseIpfsCid(invoice.memo) !== null;
}

/**
 * Extract the IPFS CID from an invoice if present.
 *
 * @param invoice - The invoice to extract from.
 * @returns The CID or null.
 */
export function getInvoiceMetadataCID(invoice: Invoice): string | null {
  return parseIpfsCid(invoice.memo);
}
