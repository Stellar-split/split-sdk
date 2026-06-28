import type { Invoice, InvoiceStatus } from "./types.js";
import { ValidationError } from "./errors.js";

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

export interface CompiledFilter {
  predicate: (invoice: Invoice) => boolean;
  criteria: FilterCriteria;
}

function buildLeafPredicate(c: FilterCriteria): (invoice: Invoice) => boolean {
  const checks: Array<(invoice: Invoice) => boolean> = [];

  if (c.status !== undefined) {
    const v = c.status;
    checks.push((inv) => inv.status === v);
  }
  if (c.creator !== undefined) {
    const v = c.creator;
    checks.push((inv) => inv.creator === v);
  }
  if (c.recipient !== undefined) {
    const v = c.recipient;
    checks.push((inv) => inv.recipients.some((r) => r.address === v));
  }
  if (c.token !== undefined) {
    const v = c.token;
    checks.push((inv) => inv.token === v);
  }
  if (c.minFunded !== undefined) {
    const v = c.minFunded;
    checks.push((inv) => inv.funded >= v);
  }
  if (c.maxFunded !== undefined) {
    const v = c.maxFunded;
    checks.push((inv) => inv.funded <= v);
  }
  if (c.deadlineBefore !== undefined) {
    const v = c.deadlineBefore;
    checks.push((inv) => inv.deadline < v);
  }
  if (c.deadlineAfter !== undefined) {
    const v = c.deadlineAfter;
    checks.push((inv) => inv.deadline > v);
  }

  return (inv) => checks.every((check) => check(inv));
}

function buildPredicate(criteria: FilterCriteria): (invoice: Invoice) => boolean {
  if (criteria.and !== undefined && criteria.or !== undefined) {
    throw new ValidationError('FilterCriteria cannot have both "and" and "or" at the same level');
  }

  if (criteria.and !== undefined) {
    const predicates = criteria.and.map(buildPredicate);
    return (inv) => predicates.every((p) => p(inv));
  }

  if (criteria.or !== undefined) {
    const predicates = criteria.or.map(buildPredicate);
    return (inv) => predicates.some((p) => p(inv));
  }

  return buildLeafPredicate(criteria);
}

export function compileFilter(criteria: FilterCriteria): CompiledFilter {
  return { predicate: buildPredicate(criteria), criteria };
}

export function applyFilter(invoices: Invoice[], filter: CompiledFilter): Invoice[] {
  return invoices.filter(filter.predicate);
}

function intersect<T>(a: Set<T>, b: Set<T>): Set<T> {
  const result = new Set<T>();
  for (const item of a) {
    if (b.has(item)) result.add(item);
  }
  return result;
}

export class FilterIndex {
  private statusIndex = new Map<string, Set<Invoice>>();
  private creatorIndex = new Map<string, Set<Invoice>>();
  private tokenIndex = new Map<string, Set<Invoice>>();
  private invoicesRef: Invoice[] | null = null;

  buildIndex(invoices: Invoice[]): this {
    if (this.invoicesRef === invoices) return this;

    this.invoicesRef = invoices;
    this.statusIndex = new Map();
    this.creatorIndex = new Map();
    this.tokenIndex = new Map();

    for (const inv of invoices) {
      this._add(this.statusIndex, inv.status, inv);
      this._add(this.creatorIndex, inv.creator, inv);
      this._add(this.tokenIndex, inv.token, inv);
    }

    return this;
  }

  queryIndex(filter: CompiledFilter): Invoice[] {
    if (!this.invoicesRef) return [];

    const c = filter.criteria;
    let candidates: Set<Invoice> | null = null;

    // Use pre-built indexes only for top-level leaf equality fields
    if (c.and === undefined && c.or === undefined) {
      if (c.status !== undefined) {
        const s = this.statusIndex.get(c.status) ?? new Set<Invoice>();
        candidates = candidates ? intersect(candidates, s) : new Set(s);
      }
      if (c.creator !== undefined) {
        const s = this.creatorIndex.get(c.creator) ?? new Set<Invoice>();
        candidates = candidates ? intersect(candidates, s) : new Set(s);
      }
      if (c.token !== undefined) {
        const s = this.tokenIndex.get(c.token) ?? new Set<Invoice>();
        candidates = candidates ? intersect(candidates, s) : new Set(s);
      }
    }

    const pool = candidates ? [...candidates] : this.invoicesRef;
    return pool.filter(filter.predicate);
  }

  private _add(map: Map<string, Set<Invoice>>, key: string, inv: Invoice): void {
    if (!map.has(key)) map.set(key, new Set());
    map.get(key)!.add(inv);
  }
}