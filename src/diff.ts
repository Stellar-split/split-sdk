import type { Invoice, InvoiceDiff } from "./types.js";

function isObject(val: unknown): val is Record<string, unknown> {
  return typeof val === "object" && val !== null;
}

function arraysEqual(a: unknown[], b: unknown[]): boolean {
  if (a.length !== b.length) return false;
  return a.every((val, i) => {
    if (isObject(val) && isObject(b[i])) {
      return JSON.stringify(val) === JSON.stringify(b[i]);
    }
    return val === b[i];
  });
}

const INVOICE_KEYS: Array<keyof Invoice> = [
  "id", "creator", "recipients", "token", "deadline",
  "funded", "status", "payments", "recurring",
];

export function diffInvoice(oldInvoice: Invoice, newInvoice: Invoice): InvoiceDiff {
  const changed: InvoiceDiff["changed"] = [];

  for (const key of INVOICE_KEYS) {
    const oldVal = oldInvoice[key];
    const newVal = newInvoice[key];

    if (Array.isArray(oldVal) && Array.isArray(newVal)) {
      if (!arraysEqual(oldVal, newVal)) {
        changed.push({ field: key, from: oldVal, to: newVal });
      }
    } else if (oldVal !== newVal) {
      changed.push({ field: key, from: oldVal, to: newVal });
    }
  }

  return { changed };
}
