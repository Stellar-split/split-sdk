/**
 * SDK metrics collection, aggregation and reporting.
 *
 * Provides a dependency-free collector that can record counters, gauges and
 * timings, aggregate them into accurate summaries, emit a structured report
 * with actionable insights, and keep a bounded tracking trail for diagnostics.
 *
 * The collector never retains request payloads or other sensitive data — only
 * numeric values and the caller supplied label strings.
 */

/** The kind of measurement recorded for a metric. */
export type MetricKind = "counter" | "gauge" | "timing";

/** Arbitrary string dimensions attached to a metric. */
export type MetricLabels = Record<string, string>;

/** A single numeric observation. */
interface Observation {
  readonly value: number;
  readonly timestamp: number;
}

/** Internal storage for one name/label combination. */
interface MetricSeries {
  readonly name: string;
  readonly kind: MetricKind;
  readonly labels: MetricLabels;
  readonly observations: Observation[];
  readonly createdAt: number;
}

/** Aggregated statistics for one metric series. */
export interface MetricSeriesSummary {
  name: string;
  kind: MetricKind;
  labels: MetricLabels;
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  p50: number;
  p95: number;
  last: number;
}

/** Aggregated view over every currently registered series. */
export interface MetricsAggregate {
  generatedAt: string;
  series: MetricSeriesSummary[];
  totals: Record<MetricKind, number>;
}

/** A bounded diagnostic record of one metric write. */
export interface TrackedMetricEvent {
  timestamp: number;
  name: string;
  kind: MetricKind;
  value: number;
  labels: MetricLabels;
}

/** Complete reporting output produced by {@link SdkMetricsCollector.report}. */
export interface MetricsReport {
  generatedAt: string;
  collection: {
    totalEvents: number;
    trackedEvents: number;
    trackedEventsTruncated: boolean;
    seriesCount: number;
  };
  aggregate: MetricsAggregate;
  insights: string[];
}

/** Configuration for {@link SdkMetricsCollector}. */
export interface MetricsCollectorOptions {
  /** When false all recording calls become no-ops. Defaults to true. */
  enabled?: boolean;
  /** Maximum number of distinct name/label series. Defaults to 200. */
  maxSeries?: number;
  /** Maximum observations retained per series. Defaults to 1000. */
  maxObservationsPerSeries?: number;
  /** Maximum tracking events retained. Defaults to 500. */
  maxTrackedEvents?: number;
  /** Labels merged into every recorded metric. */
  labels?: MetricLabels;
  /** Injectable clock, primarily for deterministic tests. */
  now?: () => number;
}

const DEFAULTS = {
  enabled: true,
  maxSeries: 200,
  maxObservationsPerSeries: 1000,
  maxTrackedEvents: 500,
} as const;

/** Deterministic key for a name/label pair (label order independent). */
function seriesKey(name: string, labels: MetricLabels): string {
  const suffix = Object.keys(labels)
    .sort()
    .map((key) => `${key}=${labels[key]}`)
    .join(",");
  return suffix.length > 0 ? `${name}{${suffix}}` : name;
}

/** Linear-interpolation percentile over an already sorted array. */
function percentile(sorted: readonly number[], fraction: number): number {
  if (sorted.length === 0) {
    return 0;
  }
  if (sorted.length === 1) {
    return sorted[0]!;
  }
  const position = (sorted.length - 1) * fraction;
  const lower = Math.floor(position);
  const upper = Math.ceil(position);
  const lowerValue = sorted[lower]!;
  const upperValue = sorted[upper]!;
  return lowerValue + (upperValue - lowerValue) * (position - lower);
}

/**
 * In-memory metrics collector with bounded retention.
 *
 * @example
 * ```ts
 * const metrics = new SdkMetricsCollector();
 * const done = metrics.startTimer("rpc.request", { method: "getAccount" });
 * // ... perform the request ...
 * done();
 * metrics.increment("payments.sent");
 * console.log(metrics.report().insights);
 * ```
 */
export class SdkMetricsCollector {
  private readonly series = new Map<string, MetricSeries>();
  private readonly tracked: TrackedMetricEvent[] = [];
  private readonly options: Required<Omit<MetricsCollectorOptions, "labels" | "now">> & {
    labels: MetricLabels;
    now: () => number;
  };
  private totalEvents = 0;
  private truncatedEvents = false;
  private enabled: boolean;

  constructor(options: MetricsCollectorOptions = {}) {
    this.enabled = options.enabled ?? DEFAULTS.enabled;
    this.options = {
      enabled: this.enabled,
      maxSeries: options.maxSeries ?? DEFAULTS.maxSeries,
      maxObservationsPerSeries:
        options.maxObservationsPerSeries ?? DEFAULTS.maxObservationsPerSeries,
      maxTrackedEvents: options.maxTrackedEvents ?? DEFAULTS.maxTrackedEvents,
      labels: { ...(options.labels ?? {}) },
      now: options.now ?? (() => Date.now()),
    };
  }

  /** Whether the collector currently accepts observations. */
  isEnabled(): boolean {
    return this.enabled;
  }

  /** Enable or disable collection at runtime without dropping existing data. */
  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
  }

  /** Number of distinct series currently stored. */
  get size(): number {
    return this.series.size;
  }

  /** Total number of observations accepted since creation or reset. */
  get events(): number {
    return this.totalEvents;
  }

  /** Record one observation for an arbitrary metric kind. */
  record(name: string, value: number, kind: MetricKind, labels: MetricLabels = {}): void {
    if (!this.enabled || !Number.isFinite(value)) {
      return;
    }

    const mergedLabels = { ...this.options.labels, ...labels };
    const key = seriesKey(name, mergedLabels);
    let entry = this.series.get(key);

    if (!entry) {
      if (this.series.size >= this.options.maxSeries) {
        // Drop the oldest series to keep memory bounded.
        const oldestKey = this.series.keys().next().value;
        if (oldestKey !== undefined) {
          this.series.delete(oldestKey);
        }
      }
      entry = {
        name,
        kind,
        labels: mergedLabels,
        observations: [],
        createdAt: this.options.now(),
      };
      this.series.set(key, entry);
    }

    entry.observations.push({ value, timestamp: this.options.now() });
    if (entry.observations.length > this.options.maxObservationsPerSeries) {
      entry.observations.shift();
    }

    this.totalEvents += 1;
    if (this.tracked.length >= this.options.maxTrackedEvents) {
      this.tracked.shift();
      this.truncatedEvents = true;
    }
    this.tracked.push({
      timestamp: this.options.now(),
      name,
      kind,
      value,
      labels: { ...mergedLabels },
    });
  }

  /** Increment a counter. Negative deltas are ignored. */
  increment(name: string, amount = 1, labels: MetricLabels = {}): void {
    if (amount < 0) {
      return;
    }
    this.record(name, amount, "counter", labels);
  }

  /** Set or update a gauge value. */
  gauge(name: string, value: number, labels: MetricLabels = {}): void {
    this.record(name, value, "gauge", labels);
  }

  /** Record a duration in milliseconds. Negative durations are ignored. */
  timing(name: string, durationMs: number, labels: MetricLabels = {}): void {
    if (durationMs < 0) {
      return;
    }
    this.record(name, durationMs, "timing", labels);
  }

  /**
   * Start a timer and return a callable that records the elapsed duration.
   * The returned function is idempotent: calling it twice records once.
   */
  startTimer(name: string, labels: MetricLabels = {}): () => number {
    const start = this.options.now();
    let finished = false;
    return () => {
      if (finished) {
        return 0;
      }
      finished = true;
      const duration = Math.max(0, this.options.now() - start);
      this.timing(name, duration, labels);
      return duration;
    };
  }

  /** Copy of the bounded tracking trail, oldest first. */
  trackedEvents(): TrackedMetricEvent[] {
    return this.tracked.map((event) => ({ ...event, labels: { ...event.labels } }));
  }

  /** Compute accurate aggregated statistics for every series. */
  aggregate(): MetricsAggregate {
    const summaries: MetricSeriesSummary[] = [];
    const totals: Record<MetricKind, number> = { counter: 0, gauge: 0, timing: 0 };

    for (const entry of this.series.values()) {
      const values = entry.observations.map((observation) => observation.value);
      const sorted = [...values].sort((a, b) => a - b);
      const sum = values.reduce((acc, value) => acc + value, 0);
      const last = values[values.length - 1] ?? 0;

      summaries.push({
        name: entry.name,
        kind: entry.kind,
        labels: { ...entry.labels },
        count: values.length,
        sum,
        min: sorted[0] ?? 0,
        max: sorted[sorted.length - 1] ?? 0,
        mean: values.length === 0 ? 0 : sum / values.length,
        p50: percentile(sorted, 0.5),
        p95: percentile(sorted, 0.95),
        last,
      });
      totals[entry.kind] += values.length;
    }

    summaries.sort((a, b) => a.name.localeCompare(b.name));

    return {
      generatedAt: new Date(this.options.now()).toISOString(),
      series: summaries,
      totals,
    };
  }

  /** Build a complete report including actionable insights. */
  report(): MetricsReport {
    const aggregate = this.aggregate();
    const insights: string[] = [];

    for (const entry of aggregate.series) {
      if (entry.kind === "timing" && entry.count > 0) {
        insights.push(
          `${entry.name}: p50 ${entry.p50.toFixed(1)}ms, p95 ${entry.p95.toFixed(1)}ms over ${entry.count} samples` +
            (entry.p95 > entry.p50 * 1.5
              ? " — high tail latency, investigate slowest calls"
              : " — stable latency profile"),
        );
      } else if (entry.kind === "counter" && entry.count > 0) {
        insights.push(`${entry.name}: ${entry.sum} events recorded across ${entry.count} observations`);
      } else if (entry.kind === "gauge" && entry.count > 0) {
        insights.push(`${entry.name}: current ${entry.last}, peak ${entry.max}`);
      }
    }

    if (aggregate.series.length === 0) {
      insights.push("No metrics recorded yet — instrument SDK operations to enable reporting");
    }
    if (this.truncatedEvents) {
      insights.push(
        `Tracking trail truncated at ${this.options.maxTrackedEvents} events; increase maxTrackedEvents for longer diagnostics`,
      );
    }

    return {
      generatedAt: aggregate.generatedAt,
      collection: {
        totalEvents: this.totalEvents,
        trackedEvents: this.tracked.length,
        trackedEventsTruncated: this.truncatedEvents,
        seriesCount: this.series.size,
      },
      aggregate,
      insights,
    };
  }

  /** Clear all observations and tracking history. */
  reset(): void {
    this.series.clear();
    this.tracked.length = 0;
    this.totalEvents = 0;
    this.truncatedEvents = false;
  }
}

/** Shared default collector for SDK-wide instrumentation. */
export const sdkMetrics = new SdkMetricsCollector();
