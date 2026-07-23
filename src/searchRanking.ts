import type { Invoice } from "./types.js";

export interface QueryContext {
  /** The raw query string used to find these results. */
  query: string;
  /** Current unix timestamp in seconds (injectable for testing). */
  nowSecs?: number;
}

// Named weight constants — independently testable
export const WEIGHT_EXACT_MATCH = 100;
export const WEIGHT_FUNDING_PROGRESS = 50;
export const WEIGHT_RECENCY = 30;

/**
 * Compute a relevance score for a single invoice given the query context.
 * Higher = more relevant.
 */
export function scoreInvoice(invoice: Invoice, ctx: QueryContext): number {
  const now = ctx.nowSecs ?? Math.floor(Date.now() / 1000);
  const q = ctx.query.toLowerCase();
  let score = 0;

  // Exact match: id, creator, or memo exactly equals query
  const exactTargets = [invoice.id, invoice.creator, invoice.memo ?? ""];
  if (exactTargets.some((t) => t.toLowerCase() === q)) {
    score += WEIGHT_EXACT_MATCH;
  }

  // Funding progress: 0–1 ratio of funded / total owed
  const total = invoice.recipients.reduce((s, r) => s + r.amount, 0n);
  if (total > 0n) {
    const progress = Number(invoice.funded) / Number(total);
    score += WEIGHT_FUNDING_PROGRESS * Math.min(progress, 1);
  }

  // Recency: invoices with deadlines closer to now score higher.
  // Score decays linearly over 30 days; past-deadline invoices score 0.
  const secsUntilDeadline = invoice.deadline - now;
  if (secsUntilDeadline > 0) {
    const THIRTY_DAYS = 30 * 24 * 3600;
    score += WEIGHT_RECENCY * Math.max(0, 1 - secsUntilDeadline / THIRTY_DAYS);
  }

  return score;
}

/**
 * Rank a filtered invoice result set by descending relevance score.
 * Uses a stable sort — equal-scoring invoices preserve their input order.
 */
export function rankResults(invoices: Invoice[], ctx: QueryContext): Invoice[] {
  const scored = invoices.map((inv, idx) => ({
    inv,
    score: scoreInvoice(inv, ctx),
    idx,
  }));
  scored.sort((a, b) => b.score - a.score || a.idx - b.idx);
  return scored.map((s) => s.inv);
}
