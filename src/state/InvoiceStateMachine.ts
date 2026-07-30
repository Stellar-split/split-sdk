/**
 * InvoiceStateMachine — validates and applies invoice status transitions.
 *
 * Invoice.status was previously assignable to any InvoiceStatus value by
 * callers, allowing nonsensical transitions such as Released -> Pending.
 * This class centralizes the allowed-transition graph so every status
 * change (in particular SplitClient.updateInvoiceStatus()) is validated
 * consistently, and emits lifecycle hooks for observability.
 */

import type { Invoice, InvoiceStatus, TransitionRecord } from "../types.js";
import { InvalidTransitionError } from "../types.js";
import type { StateMachineConfig, TransitionGraph } from "../types/state.js";
import { TypedEventEmitter } from "../events/TypedEventEmitter.js";

/**
 * The real StellarSplit invoice lifecycle has 4 statuses (Pending, Released,
 * Refunded, Cancelled). Released/Refunded/Cancelled are terminal outcomes of
 * an on-chain settlement or cancellation and have no valid outgoing edges;
 * only a Pending invoice can move to one of the three terminal states.
 */
const DEFAULT_TRANSITIONS: TransitionGraph = {
  Pending: ["Released", "Refunded", "Cancelled"],
  Released: [],
  Refunded: [],
  Cancelled: [],
};

const ALL_STATUSES: InvoiceStatus[] = ["Pending", "Released", "Refunded", "Cancelled"];

/** Payload emitted after a successful transition. */
export interface TransitionEvent {
  invoiceId: string;
  from: InvoiceStatus;
  to: InvoiceStatus;
  before: Invoice;
  after: Invoice;
}

/** Payload emitted when a transition is rejected. */
export interface InvalidTransitionEvent {
  invoiceId: string;
  from: InvoiceStatus;
  to: InvoiceStatus;
  allowed: InvoiceStatus[];
}

export type InvoiceStateMachineEventMap = {
  transition: TransitionEvent;
  invalidTransition: InvalidTransitionEvent;
};

export class InvoiceStateMachine extends TypedEventEmitter<InvoiceStateMachineEventMap> {
  private readonly graph: TransitionGraph;

  constructor(config?: StateMachineConfig) {
    super();
    const overrides = config?.transitions;
    if (overrides) {
      const merged = {} as TransitionGraph;
      for (const status of ALL_STATUSES) {
        merged[status] = overrides[status] ?? [];
      }
      this.graph = merged;
    } else {
      this.graph = DEFAULT_TRANSITIONS;
    }
  }

  /** The statuses `from` is currently allowed to transition to. */
  allowedFrom(from: InvoiceStatus): InvoiceStatus[] {
    return this.graph[from] ?? [];
  }

  /**
   * Checks whether `from` -> `to` is a legal transition.
   * Returns `true` for a legal transition; throws InvalidTransitionError
   * (carrying `{ from, to, allowed }`) otherwise.
   */
  validate(from: InvoiceStatus, to: InvoiceStatus): true {
    const allowed = this.allowedFrom(from);
    if (!allowed.includes(to)) {
      throw new InvalidTransitionError(from, to, allowed);
    }
    return true;
  }

  /**
   * Applies a validated status transition, returning a NEW Invoice with
   * `status` updated and a TransitionRecord appended to `statusHistory`.
   * The input invoice (and its statusHistory array) is never mutated.
   *
   * Throws InvalidTransitionError for illegal transitions; in that case
   * an `invalidTransition` event is emitted and the invoice is untouched.
   */
  transition(invoice: Invoice, to: InvoiceStatus): Invoice {
    const from = invoice.status;
    try {
      this.validate(from, to);
    } catch (err) {
      if (err instanceof InvalidTransitionError) {
        this.emit("invalidTransition", {
          invoiceId: invoice.id,
          from,
          to,
          allowed: err.allowed,
        });
      }
      throw err;
    }

    const record: TransitionRecord = { from, to, at: Math.floor(Date.now() / 1000) };
    const after: Invoice = {
      ...invoice,
      status: to,
      statusHistory: [...(invoice.statusHistory ?? []), record],
    };

    this.emit("transition", { invoiceId: invoice.id, from, to, before: invoice, after });
    return after;
  }
}
