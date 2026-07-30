import type { InvoiceStatus } from "./types.js";
import { InvoiceStateMachine } from "./state/InvoiceStateMachine.js";

const defaultStateMachine = new InvoiceStateMachine();

/** @deprecated Use InvoiceStateMachine (src/state/InvoiceStateMachine.ts) directly. */
export function validateTransition(from: InvoiceStatus, to: InvoiceStatus): boolean {
  return defaultStateMachine.validate(from, to);
}
