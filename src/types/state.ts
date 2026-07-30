/**
 * Types for InvoiceStateMachine (src/state/InvoiceStateMachine.ts).
 */

export type { InvoiceStatus, Invoice, TransitionRecord } from "../types.js";
export { InvalidTransitionError } from "../types.js";
import type { InvoiceStatus } from "../types.js";

/** Directed graph of allowed status transitions, keyed by source status. */
export type TransitionGraph = Record<InvoiceStatus, InvoiceStatus[]>;

/** Constructor options for InvoiceStateMachine. */
export interface StateMachineConfig {
  /**
   * Overrides the default transition graph entirely when provided.
   * Statuses omitted from this object are treated as terminal (no
   * outgoing transitions). Validation logic (validate/transition) is
   * unaffected — it simply consults this graph instead of the default.
   */
  transitions?: Partial<TransitionGraph>;
}
