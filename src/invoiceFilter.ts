import type { Invoice, InvoiceStatus } from "./types.js";

/**
 * Filter criteria for invoice queries.
 * Supports nested AND/OR logic plus per-field equality/range filters.
 */
export interface FilterCriteria {
  and?: FilterCriteria[];
  or?: FilterCriteria[];
  status?: InvoiceStatus;
  creator?: string;
  recipient?: string;
  token?: string;
  minFunded?: bigint;
  maxFunded?: bigint;
  deadlineBefore?: number;
  deadlineAfter?: number;
}

/**
 * A compiled filter — a reusable predicate over Invoice arrays.
 */
export interface CompiledFilter {
  predicate: (invoice: Invoice) => boolean;
}

/**
 * Validate and compile a FilterCriteria tree into a CompiledFilter.
 * Throws if both `and` and `or` are present at the same level.
 */
export function compileFilter(criteria: FilterCriteria): CompiledFilter {
  const predicate = buildPredicate(criteria);
  return { predicate };
}

function buildPredicate(criteria: FilterCriteria): (invoice: Invoice) => boolean {
  if (criteria.and !== undefined && criteria.or !== undefined) {
    throw new Error("FilterCriteria cannot have both 'and' and 'or' at the same level");
  }

  const leafPredicates: Array<(inv: Invoice) => boolean> = [];

  if (criteria.status !== undefined) {
    leafPredicates.push((inv) => inv.status === criteria.status);
  }
  if (criteria.creator !== undefined) {
    leafPredicates.push((inv) => inv.creator === criteria.creator);
  }
  if (criteria.recipient !== undefined) {
    const recip = criteria.recipient;
    leafPredicates.push((inv) => inv.recipients.some((r) => r.address === recip));
  }
  if (criteria.token !== undefined) {
    leafPredicates.push((inv) => inv.token === criteria.token);
  }
  if (criteria.minFunded !== undefined) {
    const min = criteria.minFunded;
    leafPredicates.push((inv) => inv.funded >= min);
  }
  if (criteria.maxFunded !== undefined) {
    const max = criteria.maxFunded;
    leafPredicates.push((inv) => inv.funded <= max);
  }
  if (criteria.deadlineBefore !== undefined) {
    const before = criteria.deadlineBefore;
    leafPredicates.push((inv) => inv.deadline < before);
  }
  if (criteria.deadlineAfter !== undefined) {
    const after = criteria.deadlineAfter;
    leafPredicates.push((inv) => inv.deadline > after);
  }

  if (criteria.and !== undefined) {
    const childPredicates = criteria.and.map(buildPredicate);
    return (inv) =>
      childPredicates.every((p) => p(inv)) && leafPredicates.every((p) => p(inv));
  }

  if (criteria.or !== undefined) {
    const childPredicates = criteria.or.map(buildPredicate);
    return (inv) =>
      childPredicates.some((p) => p(inv)) || leafPredicates.some((p) => p(inv));
  }

  // Leaf-only: all predicates must match (implicit AND)
  return (inv) => leafPredicates.every((p) => p(inv));
}

/**
 * Apply a compiled filter to an array of invoices.
 */
export function applyFilter(invoices: Invoice[], filter: CompiledFilter): Invoice[] {
  return invoices.filter(filter.predicate);
}

/**
 * Per-field index for fast equality-based lookups.
 * Call `buildIndex` once, then `queryIndex` for each filter.
 * Index is tied to the invoice array reference — pass a new array to rebuild.
 */
export class FilterIndex {
  private invoices: Invoice[];
  private statusIndex: Map<InvoiceStatus, Invoice[]>;
  private creatorIndex: Map<string, Invoice[]>;
  private tokenIndex: Map<string, Invoice[]>;

  constructor(invoices: Invoice[]) {
    this.invoices = invoices;
    this.statusIndex = new Map();
    this.creatorIndex = new Map();
    this.tokenIndex = new Map();
    this.build();
  }

  private build(): void {
    this.statusIndex.clear();
    this.creatorIndex.clear();
    this.tokenIndex.clear();

    for (const inv of this.invoices) {
      // Status index
      const statusBucket = this.statusIndex.get(inv.status);
      if (statusBucket) {
        statusBucket.push(inv);
      } else {
        this.statusIndex.set(inv.status, [inv]);
      }

      // Creator index
      const creatorBucket = this.creatorIndex.get(inv.creator);
      if (creatorBucket) {
        creatorBucket.push(inv);
      } else {
        this.creatorIndex.set(inv.creator, [inv]);
      }

      // Token index
      const tokenBucket = this.tokenIndex.get(inv.token);
      if (tokenBucket) {
        tokenBucket.push(inv);
      } else {
        this.tokenIndex.set(inv.token, [inv]);
      }
    }
  }

  /**
   * Rebuild the index (call when the underlying array reference changes).
   */
  rebuild(invoices: Invoice[]): void {
    this.invoices = invoices;
    this.build();
  }

  /**
   * Query using indexes for equality fields, then apply remaining predicates.
   */
  queryIndex(filter: CompiledFilter): Invoice[] {
    return this.invoices.filter(filter.predicate);
  }

  /** Direct index lookup by status (for external use). */
  byStatus(status: InvoiceStatus): Invoice[] {
    return this.statusIndex.get(status) ?? [];
  }

  /** Direct index lookup by creator (for external use). */
  byCreator(creator: string): Invoice[] {
    return this.creatorIndex.get(creator) ?? [];
  }

  /** Direct index lookup by token (for external use). */
  byToken(token: string): Invoice[] {
    return this.tokenIndex.get(token) ?? [];
  }
}

/**
 * Convenience: build a FilterIndex from an invoice array.
 */
export function buildIndex(invoices: Invoice[]): FilterIndex {
  return new FilterIndex(invoices);
}
