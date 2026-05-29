import type { InvoiceStatus } from "./types.js";
import { InvalidTransitionError } from "./types.js";

const TRANSITIONS: Record<InvoiceStatus, InvoiceStatus[]> = {
  Pending: ["Released", "Refunded", "Cancelled"],
  Released: [],
  Refunded: [],
  Cancelled: [],
};

export function validateTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  const allowed = TRANSITIONS[from];
  if (!allowed || !allowed.includes(to)) {
    throw new InvalidTransitionError(from, to);
  }
  return true;
}
