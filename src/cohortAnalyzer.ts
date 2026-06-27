import type { Invoice } from "./types.js";

export interface CohortBucket {
  period: string;
  total: number;
  completed: number;
  completionRate: number;
}

function getPeriodKey(timestamp: number, period: "week" | "month"): string {
  const d = new Date(timestamp * 1000);
  if (period === "month") {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, "0");
    return `${y}-${m}`;
  }
  // ISO week: find Monday of the week
  const day = d.getUTCDay(); // 0=Sun
  const diff = (day === 0 ? -6 : 1 - day);
  const monday = new Date(d);
  monday.setUTCDate(d.getUTCDate() + diff);
  const y = monday.getUTCFullYear();
  const m = String(monday.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(monday.getUTCDate()).padStart(2, "0");
  return `${y}-W${m}-${dd}`;
}

/**
 * Groups invoices into week or month cohorts by creation timestamp (deadline)
 * and computes funding-completion rates per cohort.
 *
 * @param invoices - Array of invoices to analyze.
 * @param period   - Bucketing granularity: "week" or "month".
 * @returns Ordered array of cohort buckets (ascending by period key).
 */
export function analyzeCohorts(
  invoices: Invoice[],
  period: "week" | "month",
): CohortBucket[] {
  const buckets = new Map<string, { total: number; completed: number }>();

  for (const invoice of invoices) {
    const key = getPeriodKey(invoice.deadline, period);
    const bucket = buckets.get(key) ?? { total: 0, completed: 0 };
    bucket.total += 1;
    if (invoice.status === "Released") {
      bucket.completed += 1;
    }
    buckets.set(key, bucket);
  }

  return Array.from(buckets.entries())
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, { total, completed }]) => ({
      period: key,
      total,
      completed,
      completionRate: total === 0 ? 0 : completed / total,
    }));
}
