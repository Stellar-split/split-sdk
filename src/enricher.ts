import type { Invoice } from "./types.js";
import { InvoiceFetcherNotRegisteredError } from "./errors.js";

export interface EnrichedInvoice extends Invoice {
  metadata: Record<string, unknown> | null;
}

type InvoiceFetcher = (invoiceId: string) => Promise<Invoice>;
let invoiceFetcher: InvoiceFetcher | null = null;

export function registerInvoiceFetcher(fetcher: InvoiceFetcher): void {
  invoiceFetcher = fetcher;
}

function parseIpfsCid(memo?: string): string | null {
  if (!memo) {
    return null;
  }

  const match = memo.match(/ipfs:([^\s]+)/i);
  return match?.[1] ?? null;
}

async function fetchIpfsMetadata(cid: string): Promise<Record<string, unknown> | null> {
  const url = `https://ipfs.io/ipfs/${cid}`;
  const response = await fetch(url);
  if (!response.ok) {
    return null;
  }

  const payload = await response.json();
  if (typeof payload !== "object" || payload === null) {
    return null;
  }

  return payload as Record<string, unknown>;
}

export async function enrichInvoice(
  invoiceId: string,
  getInvoice?: InvoiceFetcher
): Promise<EnrichedInvoice> {
  const fetcher = getInvoice ?? invoiceFetcher;
  if (!fetcher) {
    throw new InvoiceFetcherNotRegisteredError();
  }

  const invoice = await fetcher(invoiceId);
  const cid = parseIpfsCid(invoice.memo);
  const metadata = cid ? await fetchIpfsMetadata(cid) : null;

  return {
    ...invoice,
    metadata,
  };
}