import type { InvoiceEvent, InvoiceEventType } from "./types.js";

/** Inclusive numeric range used for ledger and timestamp constraints. */
export interface EventNumberRange {
  min?: number;
  max?: number;
}

/**
 * Composable constraints for locally filtering invoice events.
 *
 * All direct constraints must match. `all` adds AND clauses, `any` adds OR
 * clauses, and `not` excludes events matching the nested expression.
 */
export interface InvoiceEventFilter {
  types?: readonly InvoiceEventType[];
  invoiceIds?: readonly string[];
  ledger?: EventNumberRange;
  timestamp?: EventNumberRange;
  predicate?: (event: InvoiceEvent) => boolean;
  all?: readonly InvoiceEventFilter[];
  any?: readonly InvoiceEventFilter[];
  not?: InvoiceEventFilter;
}

/** Counters for filter usage, useful for tuning high-volume subscriptions. */
export interface EventFilterStats {
  queries: number;
  examined: number;
  matched: number;
  rejected: number;
}

function includesRange(value: number, range?: EventNumberRange): boolean {
  return (range?.min === undefined || value >= range.min) &&
    (range?.max === undefined || value <= range.max);
}

/** Compiles a filter once so callers can efficiently reuse it for a stream. */
export function compileInvoiceEventFilter(filter: InvoiceEventFilter = {}): (event: InvoiceEvent) => boolean {
  const types = filter.types ? new Set(filter.types) : undefined;
  const invoiceIds = filter.invoiceIds ? new Set(filter.invoiceIds) : undefined;
  const all = filter.all?.map(compileInvoiceEventFilter) ?? [];
  const any = filter.any?.map(compileInvoiceEventFilter) ?? [];
  const not = filter.not ? compileInvoiceEventFilter(filter.not) : undefined;

  return (event: InvoiceEvent): boolean => {
    if (types && !types.has(event.type)) return false;
    if (invoiceIds && !invoiceIds.has(event.invoiceId)) return false;
    if (!includesRange(event.ledger, filter.ledger)) return false;
    if (!includesRange(event.timestamp, filter.timestamp)) return false;
    if (filter.predicate && !filter.predicate(event)) return false;
    if (all.some((matches) => !matches(event))) return false;
    if (any.length > 0 && !any.some((matches) => matches(event))) return false;
    return !not || !not(event);
  };
}

/** Filters an event collection without mutating its input. */
export function filterInvoiceEvents(
  events: readonly InvoiceEvent[],
  filter: InvoiceEventFilter = {},
): InvoiceEvent[] {
  const matches = compileInvoiceEventFilter(filter);
  return events.filter(matches);
}

/**
 * Reusable filter with bounded, in-memory usage statistics. The engine stores
 * no event payloads, so enabling metrics does not retain invoice data.
 */
export class InvoiceEventFilterEngine {
  private readonly matches: (event: InvoiceEvent) => boolean;
  private stats: EventFilterStats = { queries: 0, examined: 0, matched: 0, rejected: 0 };

  constructor(filter: InvoiceEventFilter = {}) {
    this.matches = compileInvoiceEventFilter(filter);
  }

  test(event: InvoiceEvent): boolean {
    this.stats.examined++;
    const matched = this.matches(event);
    if (matched) this.stats.matched++;
    else this.stats.rejected++;
    return matched;
  }

  filter(events: readonly InvoiceEvent[]): InvoiceEvent[] {
    this.stats.queries++;
    return events.filter((event) => this.test(event));
  }

  getStats(): EventFilterStats {
    return { ...this.stats };
  }

  resetStats(): void {
    this.stats = { queries: 0, examined: 0, matched: 0, rejected: 0 };
  }
}
