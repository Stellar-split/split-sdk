import type { Invoice, InvoiceRelationships } from "./types.js";
import { RelationshipTrackerNotInitializedError } from "./errors.js";

interface RelationshipClient {
  getInvoice(id: string): Promise<Invoice>;
  getInvoicesByCreator(creator: string): Promise<{ items: string[] }>;
}

let _client: RelationshipClient | null = null;

export function initRelationshipTracker(client: RelationshipClient): void {
  _client = client;
}

export async function trackRelationships(invoiceId: string): Promise<InvoiceRelationships> {
  if (!_client) {
    throw new RelationshipTrackerNotInitializedError();
  }
  const client = _client;
  const invoice = await client.getInvoice(invoiceId);

  const groupId = invoice.groupId ?? null;
  const prerequisites = invoice.prerequisites ?? [];

  // Scan creator's invoices for any cloned from this one
  const clones: string[] = [];
  const page = await client.getInvoicesByCreator(invoice.creator);
  const candidates = await Promise.all(
    page.items
      .filter((id) => id !== invoiceId)
      .map((id) => client.getInvoice(id).catch(() => null))
  );
  for (const candidate of candidates) {
    if (candidate?.clonedFrom === invoiceId) {
      clones.push(candidate.id);
    }
  }

  return { invoiceId, clones, groupId, prerequisites };
}
