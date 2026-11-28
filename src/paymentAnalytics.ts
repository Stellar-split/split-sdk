/**
 * Payment and Invoice Performance Analytics Module (#1055)
 *
 * Provides comprehensive aggregation, reporting, and visualizations for payments
 * and invoice lifecycle performance.
 */

import type { Invoice, Payment } from "./types.js";
import { AnalyticsTracker } from "./analyticsTracking.js";
import { MetricsRegistry } from "./metrics.js";
import { AnalyticsDashboardExporter } from "./analyticsDashboardExporter.js";

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

/** Options for wiring analytics tracking and metrics into the engine. */
export interface PaymentAnalyticsEngineOptions {
  /** Optional analytics tracker for emitting analytics events. */
  tracker?: AnalyticsTracker;
  /** Optional metrics registry for recording counters and histograms. */
  metrics?: MetricsRegistry;
  /** Optional dashboard exporter for CSV/JSON serialization. */
  exporter?: AnalyticsDashboardExporter;
}

/** Filter criteria for payment analytics queries. */
export interface PaymentAnalyticsFilter {
  /** Filter by token address. */
  token?: string;
  /** Filter by creator address. */
  creator?: string;
  /** Filter by invoice status. */
  status?: string | string[];
  /** Minimum creation timestamp (epoch ms or seconds). */
  startDate?: number;
  /** Maximum creation timestamp (epoch ms or seconds). */
  endDate?: number;
}

/** Distribution across an invoice lifecycle status. */
export interface StatusDistribution {
  status: string;
  count: number;
  percentage: number;
  totalFunded: bigint;
}

/** Breakdown of volume and payments by token. */
export interface TokenDistribution {
  token: string;
  invoiceCount: number;
  paymentCount: number;
  totalFunded: bigint;
}

/** Numerical statistics for payment amounts. */
export interface PaymentDistributionStats {
  min: bigint;
  max: bigint;
  mean: bigint;
  median: bigint;
  totalCount: number;
}

/** Timing and completion metrics. */
export interface PaymentTimingMetrics {
  /** Average milliseconds from invoice creation to release or completion. */
  averageSettlementTimeMs: number | null;
  /** Total payments made before or at deadline. */
  onTimePayments: number;
  /** Total payments made past deadline. */
  latePayments: number;
  /** Percentage of payments made on-time (0 - 100). */
  onTimeRate: number;
}

/** Comprehensive payment and invoice summary. */
export interface PaymentAnalyticsSummary {
  /** Total number of invoices analysed. */
  totalInvoices: number;
  /** Total target owed amount across all invoices (in stroops). */
  totalTarget: bigint;
  /** Total amount funded across all invoices (in stroops). */
  totalFunded: bigint;
  /** Total outstanding / unfunded amount (in stroops). */
  totalOutstanding: bigint;
  /** Funding completion rate in basis points (0–10 000). */
  fundingRateBps: number;
  /** Funding completion rate percentage (0–100). */
  fundingRatePercent: number;
  /** Total count of individual payments. */
  totalPayments: number;
  /** Total count of unique payer addresses. */
  uniquePayers: number;
  /** Payment amount statistics (min, max, mean, median). */
  paymentStats: PaymentDistributionStats;
  /** Invoices and volume grouped by lifecycle status. */
  statusBreakdown: StatusDistribution[];
  /** Invoices and volume grouped by token. */
  tokenBreakdown: TokenDistribution[];
  /** Settlement velocity and timeliness metrics. */
  timingMetrics: PaymentTimingMetrics;
}

/** Aggregated analytics for a single payer address. */
export interface PayerAnalyticsRecord {
  /** Stellar address of the payer. */
  address: string;
  /** Total stroops paid across all invoices. */
  totalPaid: bigint;
  /** Number of individual payments. */
  paymentCount: number;
  /** Number of distinct invoices contributed to. */
  invoiceCount: number;
  /** Percentage of overall payment volume (0 - 100). */
  percentageOfVolume: number;
  /** First payment timestamp recorded (if available). */
  firstPaymentTime?: number;
  /** Last payment timestamp recorded (if available). */
  lastPaymentTime?: number;
}

/** Summary of payer behavior and retention. */
export interface PayerCohortSummary {
  totalUniquePayers: number;
  repeatPayers: number;
  repeatPayerRate: number;
  topPayers: PayerAnalyticsRecord[];
}

/** Time-series data point bucket. */
export interface TimeSeriesDataPoint {
  /** Timestamp at start of bucket (Unix ms). */
  timestamp: number;
  /** Human-readable label (e.g. "2026-10-15"). */
  label: string;
  /** Volume funded in this bucket (stroops). */
  volume: bigint;
  /** Number of payments in this bucket. */
  paymentCount: number;
  /** Number of distinct payers in this bucket. */
  uniquePayers: number;
}

/** Individual invoice performance evaluation. */
export interface InvoicePerformanceRecord {
  id: string;
  status: string;
  token: string;
  targetAmount: bigint;
  fundedAmount: bigint;
  fundingPercentage: number;
  paymentCount: number;
  uniquePayers: number;
  createdAt?: number;
  deadline: number;
  health: "completed" | "on-track" | "at-risk" | "overdue";
}

/** Full analytics report bundle. */
export interface PaymentAnalyticsReport {
  generatedAt: number;
  summary: PaymentAnalyticsSummary;
  payers: PayerCohortSummary;
  timeSeries: TimeSeriesDataPoint[];
  invoices: InvoicePerformanceRecord[];
}

/** Chart datasets formatted for web visualization libraries (Chart.js / Recharts). */
export interface StructuredChartData {
  labels: string[];
  datasets: Array<{
    label: string;
    data: number[];
    unit?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MS_DETECTION_THRESHOLD = 1e12;

function normalizeTimestamp(ts?: number): number | undefined {
  if (typeof ts !== "number" || !Number.isFinite(ts) || ts <= 0) return undefined;
  return ts > MS_DETECTION_THRESHOLD ? ts : ts * 1000;
}

function calculateMedian(values: bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[mid]!;
  }
  return (sorted[mid - 1]! + sorted[mid]!) / 2n;
}

// ---------------------------------------------------------------------------
// PaymentAnalyticsEngine
// ---------------------------------------------------------------------------

/**
 * Advanced analytics engine for evaluating invoice payments, funding velocity,
 * payer behavior, and lifecycle performance.
 */
export class PaymentAnalyticsEngine {
  private readonly tracker?: AnalyticsTracker;
  private readonly metrics?: MetricsRegistry;
  private readonly exporter?: AnalyticsDashboardExporter;

  constructor(options?: PaymentAnalyticsEngineOptions) {
    this.tracker = options?.tracker;
    this.metrics = options?.metrics;
    this.exporter = options?.exporter;
  }

  /**
   * Emit an analytics tracking event, tolerating a missing tracker.
   */
  private track(event: string, properties?: Record<string, unknown>): void {
    if (!this.tracker) return;
    try {
      this.tracker.trackEvent({ name: event, properties });
    } catch {
      // Tracking must never break analytics computation.
    }
  }

  /**
   * Record a counter metric, tolerating a missing registry.
   */
  private incrementCounter(name: string, value = 1, _tags?: Record<string, string>): void {
    if (!this.metrics) return;
    try {
      this.metrics.counter(name).inc(value);
    } catch {
      // Metrics must never break analytics computation.
    }
  }

  /**
   * Record a histogram observation, tolerating a missing registry.
   */
  private observeHistogram(name: string, value: number, _tags?: Record<string, string>): void {
    if (!this.metrics) return;
    try {
      this.metrics.histogram(name).observe(value);
    } catch {
      // Metrics must never break analytics computation.
    }
  }

  /**
   * Normalize an invoice or array of invoices into a filtered array.
   */
  private filterInvoices(
    input: Invoice | Invoice[],
    filter?: PaymentAnalyticsFilter,
  ): Invoice[] {
    const list = Array.isArray(input) ? input : [input];
    if (!filter) return list;

    return list.filter((inv) => {
      if (filter.token && inv.token !== filter.token) return false;
      if (filter.creator && inv.creator !== filter.creator) return false;
      if (filter.status) {
        const statuses = Array.isArray(filter.status) ? filter.status : [filter.status];
        if (!statuses.includes(inv.status)) return false;
      }
      if (filter.startDate) {
        const created = normalizeTimestamp(inv.createdAt) ?? 0;
        const start = normalizeTimestamp(filter.startDate) ?? 0;
        if (created < start) return false;
      }
      if (filter.endDate) {
        const created = normalizeTimestamp(inv.createdAt) ?? 0;
        const end = normalizeTimestamp(filter.endDate) ?? 0;
        if (created > end) return false;
      }
      return true;
    });
  }

  /**
   * Aggregate payment metrics across invoices.
   *
   * @param input  - Single invoice or array of invoices.
   * @param filter - Optional filters for token, creator, status, dates.
   */
  aggregate(
    input: Invoice | Invoice[],
    filter?: PaymentAnalyticsFilter,
  ): PaymentAnalyticsSummary {
    const startedAt = Date.now();
    const invoices = this.filterInvoices(input, filter);

    this.track("payment_analytics.aggregate", {
      invoiceCount: invoices.length,
      hasFilter: Boolean(filter),
    });

    if (invoices.length === 0) {
      this.incrementCounter("payment_analytics.aggregate.empty");
      this.observeHistogram("payment_analytics.aggregate.duration_ms", Date.now() - startedAt);
      return {
        totalInvoices: 0,
        totalTarget: 0n,
        totalFunded: 0n,
        totalOutstanding: 0n,
        fundingRateBps: 0,
        fundingRatePercent: 0,
        totalPayments: 0,
        uniquePayers: 0,
        paymentStats: { min: 0n, max: 0n, mean: 0n, median: 0n, totalCount: 0 },
        statusBreakdown: [],
        tokenBreakdown: [],
        timingMetrics: { averageSettlementTimeMs: null, onTimePayments: 0, latePayments: 0, onTimeRate: 100 },
      };
    }

    let totalTarget = 0n;
    let totalFunded = 0n;
    let totalPayments = 0;
    const allPaymentAmounts: bigint[] = [];
    const uniquePayers = new Set<string>();

    const statusCounts = new Map<string, { count: number; funded: bigint }>();
    const tokenCounts = new Map<string, { invoices: number; payments: number; funded: bigint }>();

    let onTimePayments = 0;
    let latePayments = 0;
    const settlementDurations: number[] = [];

    for (const inv of invoices) {
      const target = inv.recipients.reduce((sum, r) => sum + r.amount, 0n);
      totalTarget += target;
      totalFunded += inv.funded;

      // Status distribution
      const sEntry = statusCounts.get(inv.status) ?? { count: 0, funded: 0n };
      sEntry.count++;
      sEntry.funded += inv.funded;
      statusCounts.set(inv.status, sEntry);

      // Token distribution
      const tEntry = tokenCounts.get(inv.token) ?? { invoices: 0, payments: 0, funded: 0n };
      tEntry.invoices++;
      tEntry.funded += inv.funded;

      // Timing & Settlement
      const createdMs = normalizeTimestamp(inv.createdAt);
      if (inv.status === "Released" && createdMs) {
        // Last payment or current time as settlement
        const lastPayTs = inv.payments.reduce((max, p) => {
          const t = normalizeTimestamp(p.timestamp);
          return t && t > max ? t : max;
        }, createdMs);
        settlementDurations.push(lastPayTs - createdMs);
      }

      // Payments
      const deadlineMs = normalizeTimestamp(inv.deadline);
      for (const p of inv.payments) {
        totalPayments++;
        tEntry.payments++;
        uniquePayers.add(p.payer);
        allPaymentAmounts.push(p.amount);

        const payTs = normalizeTimestamp(p.timestamp);
        if (payTs && deadlineMs) {
          if (payTs <= deadlineMs) {
            onTimePayments++;
          } else {
            latePayments++;
          }
        } else {
          onTimePayments++;
        }
      }

      tokenCounts.set(inv.token, tEntry);
    }

    const totalOutstanding = totalTarget > totalFunded ? totalTarget - totalFunded : 0n;
    const fundingRateBps =
      totalTarget > 0n
        ? Number((totalFunded * 10_000n) / totalTarget > 10_000n ? 10_000n : (totalFunded * 10_000n) / totalTarget)
        : 0;
    const fundingRatePercent = Number((fundingRateBps / 100).toFixed(2));

    // Payment stats
    let min = 0n;
    let max = 0n;
    let mean = 0n;
    if (allPaymentAmounts.length > 0) {
      min = allPaymentAmounts.reduce((a, b) => (a < b ? a : b), allPaymentAmounts[0]!);
      max = allPaymentAmounts.reduce((a, b) => (a > b ? a : b), allPaymentAmounts[0]!);
      const sum = allPaymentAmounts.reduce((a, b) => a + b, 0n);
      mean = sum / BigInt(allPaymentAmounts.length);
    }
    const median = calculateMedian(allPaymentAmounts);

    // Status breakdown array
    const statusBreakdown: StatusDistribution[] = Array.from(statusCounts.entries())
      .map(([status, entry]) => ({
        status,
        count: entry.count,
        percentage: Number(((entry.count / invoices.length) * 100).toFixed(2)),
        totalFunded: entry.funded,
      }))
      .sort((a, b) => b.count - a.count);

    // Token breakdown array
    const tokenBreakdown: TokenDistribution[] = Array.from(tokenCounts.entries())
      .map(([token, entry]) => ({
        token,
        invoiceCount: entry.invoices,
        paymentCount: entry.payments,
        totalFunded: entry.funded,
      }))
      .sort((a, b) => (b.totalFunded > a.totalFunded ? 1 : -1));

    const avgSettlement =
      settlementDurations.length > 0
        ? Math.round(settlementDurations.reduce((a, b) => a + b, 0) / settlementDurations.length)
        : null;

    const totalTimed = onTimePayments + latePayments;
    const onTimeRate = totalTimed > 0 ? Number(((onTimePayments / totalTimed) * 100).toFixed(2)) : 100;

    this.incrementCounter("payment_analytics.aggregate.completed");
    this.incrementCounter("payment_analytics.payments.count", totalPayments);
    this.observeHistogram("payment_analytics.funding_rate_percent", fundingRatePercent);
    this.observeHistogram("payment_analytics.on_time_rate", onTimeRate);
    this.observeHistogram("payment_analytics.aggregate.duration_ms", Date.now() - startedAt);

    return {
      totalInvoices: invoices.length,
      totalTarget,
      totalFunded,
      totalOutstanding,
      fundingRateBps,
      fundingRatePercent,
      totalPayments,
      uniquePayers: uniquePayers.size,
      paymentStats: {
        min,
        max,
        mean,
        median,
        totalCount: allPaymentAmounts.length,
      },
      statusBreakdown,
      tokenBreakdown,
      timingMetrics: {
        averageSettlementTimeMs: avgSettlement,
        onTimePayments,
        latePayments,
        onTimeRate,
      },
    };
  }

  /**
   * Aggregate payer cohort metrics and rankings.
   */
  aggregatePayers(
    input: Invoice | Invoice[],
    limit = 10,
  ): PayerCohortSummary {
    const startedAt = Date.now();
    const invoices = Array.isArray(input) ? input : [input];
    this.track("payment_analytics.aggregate_payers", {
      invoiceCount: invoices.length,
      limit,
    });
    const payerMap = new Map<string, {
      totalPaid: bigint;
      payments: number;
      invoices: Set<string>;
      firstTime?: number;
      lastTime?: number;
    }>();

    let grandTotalPaid = 0n;

    for (const inv of invoices) {
      for (const p of inv.payments) {
        grandTotalPaid += p.amount;
        let entry = payerMap.get(p.payer);
        if (!entry) {
          entry = {
            totalPaid: 0n,
            payments: 0,
            invoices: new Set(),
            firstTime: undefined,
            lastTime: undefined,
          };
          payerMap.set(p.payer, entry);
        }

        entry.totalPaid += p.amount;
        entry.payments++;
        entry.invoices.add(inv.id);

        const pTs = normalizeTimestamp(p.timestamp);
        if (pTs) {
          if (!entry.firstTime || pTs < entry.firstTime) entry.firstTime = pTs;
          if (!entry.lastTime || pTs > entry.lastTime) entry.lastTime = pTs;
        }
      }
    }

    const allPayers: PayerAnalyticsRecord[] = Array.from(payerMap.entries()).map(([address, data]) => {
      const percentageOfVolume =
        grandTotalPaid > 0n
          ? Number(((data.totalPaid * 10_000n) / grandTotalPaid)) / 100
          : 0;

      return {
        address,
        totalPaid: data.totalPaid,
        paymentCount: data.payments,
        invoiceCount: data.invoices.size,
        percentageOfVolume: Number(percentageOfVolume.toFixed(2)),
        firstPaymentTime: data.firstTime,
        lastPaymentTime: data.lastTime,
      };
    });

    allPayers.sort((a, b) => (a.totalPaid > b.totalPaid ? -1 : a.totalPaid < b.totalPaid ? 1 : 0));

    const repeatPayers = allPayers.filter((p) => p.paymentCount > 1).length;
    const repeatPayerRate =
      allPayers.length > 0 ? Number(((repeatPayers / allPayers.length) * 100).toFixed(2)) : 0;

    this.incrementCounter("payment_analytics.payers.unique", allPayers.length);
    this.observeHistogram("payment_analytics.repeat_payer_rate", repeatPayerRate);
    this.observeHistogram("payment_analytics.aggregate_payers.duration_ms", Date.now() - startedAt);

    return {
      totalUniquePayers: allPayers.length,
      repeatPayers,
      repeatPayerRate,
      topPayers: allPayers.slice(0, limit),
    };
  }

  /**
   * Aggregate payment volume and counts into temporal buckets.
   */
  aggregateTimeSeries(
    input: Invoice | Invoice[],
    options?: { interval?: "hour" | "day" | "week" | "month"; bucketCount?: number },
  ): TimeSeriesDataPoint[] {
    const startedAt = Date.now();
    const invoices = Array.isArray(input) ? input : [input];
    this.track("payment_analytics.aggregate_time_series", {
      invoiceCount: invoices.length,
      interval: options?.interval ?? "day",
    });
    type FlatPayment = { amount: bigint; timestamp: number; payer: string };
    const payments: FlatPayment[] = [];

    for (const inv of invoices) {
      for (const p of inv.payments) {
        const ts = normalizeTimestamp(p.timestamp);
        if (ts) {
          payments.push({ amount: p.amount, timestamp: ts, payer: p.payer });
        }
      }
    }

    if (payments.length === 0) return [];

    payments.sort((a, b) => a.timestamp - b.timestamp);
    const minTs = payments[0]!.timestamp;
    const maxTs = payments[payments.length - 1]!.timestamp;

    const interval = options?.interval ?? "day";
    let bucketMs = 24 * 60 * 60 * 1000;
    if (interval === "hour") bucketMs = 60 * 60 * 1000;
    if (interval === "week") bucketMs = 7 * 24 * 60 * 60 * 1000;
    if (interval === "month") bucketMs = 30 * 24 * 60 * 60 * 1000;

    const count = options?.bucketCount ?? Math.max(1, Math.ceil((maxTs - minTs + 1) / bucketMs));
    const points: TimeSeriesDataPoint[] = [];

    for (let i = 0; i < count; i++) {
      const bucketStart = minTs + i * bucketMs;
      const date = new Date(bucketStart);
      const label = date.toISOString().split("T")[0]!;
      points.push({
        timestamp: bucketStart,
        label,
        volume: 0n,
        paymentCount: 0,
        uniquePayers: 0,
      });
    }

    const bucketPayers = Array.from({ length: points.length }, () => new Set<string>());

    for (const p of payments) {
      const idx = Math.min(
        Math.floor((p.timestamp - minTs) / bucketMs),
        points.length - 1,
      );
      if (idx >= 0 && idx < points.length) {
        points[idx]!.volume += p.amount;
        points[idx]!.paymentCount++;
        bucketPayers[idx]!.add(p.payer);
      }
    }

    for (let i = 0; i < points.length; i++) {
      points[i]!.uniquePayers = bucketPayers[i]!.size;
    }

    this.observeHistogram("payment_analytics.time_series.buckets", points.length);
    this.observeHistogram("payment_analytics.aggregate_time_series.duration_ms", Date.now() - startedAt);

    return points;
  }

  /**
   * Evaluate health and completion performance for individual invoices.
   */
  analyzeInvoicePerformance(input: Invoice | Invoice[]): InvoicePerformanceRecord[] {
    const startedAt = Date.now();
    const invoices = Array.isArray(input) ? input : [input];
    const now = Date.now();
    this.track("payment_analytics.analyze_invoice_performance", {
      invoiceCount: invoices.length,
    });

    const records = invoices.map((inv) => {
      const target = inv.recipients.reduce((s, r) => s + r.amount, 0n);
      const fundingPct = target > 0n ? Number(((inv.funded * 100n) / target)) : 0;
      const deadlineMs = normalizeTimestamp(inv.deadline) ?? 0;
      const isPastDeadline = deadlineMs > 0 && now > deadlineMs;

      let health: "completed" | "on-track" | "at-risk" | "overdue";
      if (inv.status === "Released" || inv.funded >= target) {
        health = "completed";
      } else if (isPastDeadline) {
        health = "overdue";
      } else if (fundingPct < 25 && deadlineMs - now < 86_400_000 * 2) {
        health = "at-risk";
      } else {
        health = "on-track";
      }

      const uniquePayers = new Set(inv.payments.map((p) => p.payer)).size;

      return {
        id: inv.id,
        status: inv.status,
        token: inv.token,
        targetAmount: target,
        fundedAmount: inv.funded,
        fundingPercentage: fundingPct,
        paymentCount: inv.payments.length,
        uniquePayers,
        createdAt: inv.createdAt,
        deadline: inv.deadline,
        health,
      };
    });

    const healthCounts = records.reduce<Record<string, number>>((acc, r) => {
      acc[r.health] = (acc[r.health] ?? 0) + 1;
      return acc;
    }, {});
    for (const [health, count] of Object.entries(healthCounts)) {
      this.incrementCounter("payment_analytics.invoice_health", count, { health });
    }
    this.observeHistogram("payment_analytics.analyze_invoice_performance.duration_ms", Date.now() - startedAt);

    return records;
  }

  /**
   * Generate an end-to-end payment analytics report.
   */
  generateReport(
    input: Invoice | Invoice[],
    filter?: PaymentAnalyticsFilter,
  ): PaymentAnalyticsReport {
    const startedAt = Date.now();
    const invoices = this.filterInvoices(input, filter);
    this.track("payment_analytics.generate_report", {
      invoiceCount: invoices.length,
      hasFilter: Boolean(filter),
    });

    const summary = this.aggregate(invoices);
    const payers = this.aggregatePayers(invoices);
    const timeSeries = this.aggregateTimeSeries(invoices);
    const invoicePerformance = this.analyzeInvoicePerformance(invoices);

    const report: PaymentAnalyticsReport = {
      generatedAt: Date.now(),
      summary,
      payers,
      timeSeries,
      invoices: invoicePerformance,
    };

    this.incrementCounter("payment_analytics.reports.generated");
    this.observeHistogram("payment_analytics.generate_report.duration_ms", Date.now() - startedAt);

    return report;
  }

  /**
   * Build a dashboard bundle of chart-ready series from a report.
   *
   * Produces structured chart data for volume trends, status distribution,
   * token distribution, and payer leaderboards, suitable for direct rendering
   * by Chart.js / Recharts.
   */
  buildDashboard(report: PaymentAnalyticsReport): {
    volumeTrend: StructuredChartData;
    statusDistribution: StructuredChartData;
    tokenDistribution: StructuredChartData;
    payerLeaderboard: StructuredChartData;
    summary: PaymentAnalyticsSummary;
  } {
    this.track("payment_analytics.build_dashboard", {
      invoiceCount: report.summary.totalInvoices,
    });

    const volumeTrend = this.exportChartData(report.summary, report.timeSeries);

    const statusDistribution: StructuredChartData = {
      labels: report.summary.statusBreakdown.map((s) => s.status),
      datasets: [
        {
          label: "Invoices by Status",
          data: report.summary.statusBreakdown.map((s) => s.count),
          unit: "invoices",
        },
        {
          label: "Funded by Status",
          data: report.summary.statusBreakdown.map((s) => Number(s.totalFunded / 10_000_000n)),
          unit: "tokens",
        },
      ],
    };

    const tokenDistribution: StructuredChartData = {
      labels: report.summary.tokenBreakdown.map((t) => t.token),
      datasets: [
        {
          label: "Funded by Token",
          data: report.summary.tokenBreakdown.map((t) => Number(t.totalFunded / 10_000_000n)),
          unit: "tokens",
        },
        {
          label: "Payments by Token",
          data: report.summary.tokenBreakdown.map((t) => t.paymentCount),
          unit: "count",
        },
      ],
    };

    const payerLeaderboard: StructuredChartData = {
      labels: report.payers.topPayers.map(
        (p) => `${p.address.slice(0, 4)}...${p.address.slice(-4)}`,
      ),
      datasets: [
        {
          label: "Paid by Payer",
          data: report.payers.topPayers.map((p) => Number(p.totalPaid / 10_000_000n)),
          unit: "tokens",
        },
      ],
    };

    this.incrementCounter("payment_analytics.dashboards.built");

    return {
      volumeTrend,
      statusDistribution,
      tokenDistribution,
      payerLeaderboard,
      summary: report.summary,
    };
  }

  // ---------------------------------------------------------------------------
  // Visualizations
  // ---------------------------------------------------------------------------

  /**
   * Render an ASCII horizontal bar chart.
   */
  renderAsciiBarChart(
    data: Array<{ label: string; value: number }>,
    options?: { width?: number; showValues?: boolean },
  ): string {
    if (data.length === 0) return "No data available.";
    const width = options?.width ?? 25;
    const showValues = options?.showValues ?? true;

    const maxVal = Math.max(...data.map((d) => d.value), 1);
    const maxLabelLen = Math.max(...data.map((d) => d.label.length), 4);

    return data
      .map((item) => {
        const barLen = Math.round((item.value / maxVal) * width);
        const bar = "█".repeat(barLen).padEnd(width, " ");
        const label = item.label.padEnd(maxLabelLen, " ");
        const valStr = showValues ? ` ${item.value}` : "";
        return `${label} | ${bar}${valStr}`;
      })
      .join("\n");
  }

  /**
   * Render a compact sparkline trend string from an array of numbers.
   */
  renderSparkline(values: number[]): string {
    if (values.length === 0) return "";
    const blocks = [" ", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
    const min = Math.min(...values);
    const max = Math.max(...values);
    const range = max - min;

    return values
      .map((v) => {
        if (range === 0) return blocks[0];
        const idx = Math.min(Math.floor(((v - min) / range) * (blocks.length - 1)), blocks.length - 1);
        return blocks[idx];
      })
      .join("");
  }

  /**
   * Render an ASCII volume chart from time-series points.
   */
  renderVolumeChart(timeSeries: TimeSeriesDataPoint[], options?: { width?: number }): string {
    if (timeSeries.length === 0) return "No time-series data.";
    const chartData = timeSeries.map((d) => ({
      label: d.label,
      value: Number(d.volume / 10_000_000n), // convert stroops to XLM/tokens
    }));
    return this.renderAsciiBarChart(chartData, options);
  }

  /**
   * Render the lifecycle status breakdown as a visual chart.
   */
  renderStatusDistribution(summary: PaymentAnalyticsSummary): string {
    if (summary.statusBreakdown.length === 0) return "No status data.";
    return this.renderAsciiBarChart(
      summary.statusBreakdown.map((s) => ({
        label: s.status,
        value: s.count,
      })),
    );
  }

  /**
   * Render a payer leaderboard visual chart.
   */
  renderPayerLeaderboard(payers: PayerCohortSummary, limit = 5): string {
    if (payers.topPayers.length === 0) return "No payer data.";
    const slice = payers.topPayers.slice(0, limit);
    const data = slice.map((p) => {
      const shortAddr = `${p.address.slice(0, 4)}...${p.address.slice(-4)}`;
      return {
        label: shortAddr,
        value: Number(p.totalPaid / 10_000_000n),
      };
    });
    return this.renderAsciiBarChart(data);
  }

  /**
   * Export structured chart data suitable for Chart.js, Recharts, or Vega.
   */
  exportChartData(summary: PaymentAnalyticsSummary, timeSeries?: TimeSeriesDataPoint[]): StructuredChartData {
    if (timeSeries && timeSeries.length > 0) {
      return {
        labels: timeSeries.map((t) => t.label),
        datasets: [
          {
            label: "Volume",
            data: timeSeries.map((t) => Number(t.volume / 10_000_000n)),
            unit: "tokens",
          },
          {
            label: "Payments",
            data: timeSeries.map((t) => t.paymentCount),
            unit: "count",
          },
        ],
      };
    }

    return {
      labels: summary.statusBreakdown.map((s) => s.status),
      datasets: [
        {
          label: "Invoices by Status",
          data: summary.statusBreakdown.map((s) => s.count),
          unit: "invoices",
        },
      ],
    };
  }

  // ---------------------------------------------------------------------------
  // Reporting Formats
  // ---------------------------------------------------------------------------

  /**
   * Format an analytics report into a clean human-readable text document.
   */
  formatReport(report: PaymentAnalyticsReport): string {
    const s = report.summary;
    const lines: string[] = [
      "============================================================",
      "                PAYMENT & PERFORMANCE REPORT                ",
      "============================================================",
      `Generated At:     ${new Date(report.generatedAt).toISOString()}`,
      `Total Invoices:   ${s.totalInvoices}`,
      `Total Target:     ${s.totalTarget.toString()} stroops`,
      `Total Funded:     ${s.totalFunded.toString()} stroops (${s.fundingRatePercent}%)`,
      `Outstanding:      ${s.totalOutstanding.toString()} stroops`,
      `Total Payments:   ${s.totalPayments}`,
      `Unique Payers:    ${s.uniquePayers}`,
      `On-time Rate:     ${s.timingMetrics.onTimeRate}%`,
      "",
      "--- Status Breakdown ---",
      this.renderStatusDistribution(s),
      "",
      "--- Payer Leaderboard ---",
      this.renderPayerLeaderboard(report.payers),
      "============================================================",
    ];
    return lines.join("\n");
  }

  /**
   * Export the full report as a JSON string.
   */
  exportJson(report: PaymentAnalyticsReport, pretty = true): string {
    this.track("payment_analytics.export_json", { pretty });
    this.incrementCounter("payment_analytics.reports.exported", 1, { format: "json" });

    return JSON.stringify(
      report,
      (_, val) => (typeof val === "bigint" ? val.toString() : val),
      pretty ? 2 : undefined,
    );
  }

  /**
   * Export invoice performance data as CSV.
   */
  exportCsv(report: PaymentAnalyticsReport): string {
    this.track("payment_analytics.export_csv", {
      invoiceCount: report.invoices.length,
    });
    this.incrementCounter("payment_analytics.reports.exported", 1, { format: "csv" });

    const headers = [
      "InvoiceId",
      "Status",
      "Token",
      "TargetAmount",
      "FundedAmount",
      "FundingPct",
      "Payments",
      "UniquePayers",
      "Health",
    ];
    const rows = report.invoices.map((inv) => [
      inv.id,
      inv.status,
      inv.token,
      inv.targetAmount.toString(),
      inv.fundedAmount.toString(),
      `${inv.fundingPercentage}%`,
      inv.paymentCount,
      inv.uniquePayers,
      inv.health,
    ]);

    return [headers.join(","), ...rows.map((r) => r.join(","))].join("\n");
  }
}
