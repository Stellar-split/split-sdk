import type { Invoice } from "./types.js";

const _index = new Map<string, Invoice>();

export function indexInvoice(invoice: Invoice): void {
  _index.set(invoice.id, invoice);
}

export function searchInvoices(query: string): Invoice[] {
  const q = query.toLowerCase();
  return Array.from(_index.values()).filter(
    (inv) =>
      inv.creator.toLowerCase().includes(q) ||
      (inv.memo !== undefined && inv.memo.toLowerCase().includes(q)) ||
      inv.recipients.some((r) => r.address.toLowerCase().includes(q))
  );
}

export function getIndexedInvoices(): Invoice[] {
  return Array.from(_index.values());
}
