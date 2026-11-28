/**
 * SDK metrics and statistics collection.
 *
 * Provides a small, dependency-free metrics registry with counters, gauges,
 * and histograms, plus export and analysis helpers for monitoring.
 */

export type MetricType = 'counter' | 'gauge' | 'histogram';

export interface MetricSnapshot {
  name: string;
  type: MetricType;
  help?: string;
  value: number | HistogramSnapshot;
}

export interface HistogramSnapshot {
  count: number;
  sum: number;
  min: number;
  max: number;
  mean: number;
  buckets: Record<string, number>;
  percentiles: Record<string, number>;
}

export interface MetricsExport {
  timestamp: string;
  metrics: MetricSnapshot[];
}

export interface MetricAnalysis {
  totalMetrics: number;
  counters: number;
  gauges: number;
  histograms: number;
  summary: string[];
}

/** A monotonically increasing counter. */
export class Counter {
  readonly type: MetricType = 'counter';
  private current = 0;

  constructor(readonly name: string, readonly help?: string) {}

  /** Increment by a non-negative amount (default 1). */
  inc(amount = 1): void {
    if (amount < 0) {
      throw new Error(`Counter "${this.name}" cannot be decremented`);
    }
    this.current += amount;
  }

  get value(): number {
    return this.current;
  }

  reset(): void {
    this.current = 0;
  }

  snapshot(): MetricSnapshot {
    return { name: this.name, type: this.type, help: this.help, value: this.current };
  }
}

/** A gauge that can be set, incremented, or decremented. */
export class Gauge {
  readonly type: MetricType = 'gauge';
  private current = 0;

  constructor(readonly name: string, readonly help?: string) {}

  set(value: number): void {
    this.current = value;
  }

  inc(amount = 1): void {
    this.current += amount;
  }

  dec(amount = 1): void {
    this.current -= amount;
  }

  get value(): number {
    return this.current;
  }

  reset(): void {
    this.current = 0;
  }

  snapshot(): MetricSnapshot {
    return { name: this.name, type: this.type, help: this.help, value: this.current };
  }
}

const DEFAULT_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];
const DEFAULT_PERCENTILES = [0.5, 0.9, 0.95, 0.99];

/** A histogram tracking value distribution across configurable buckets. */
export class Histogram {
  readonly type: MetricType = 'histogram';
  private readonly buckets: number[];
  private readonly bucketCounts: number[];
  private readonly observations: number[] = [];
  private count = 0;
  private sum = 0;
  private min = Infinity;
  private max = -Infinity;

  constructor(
    readonly name: string,
    readonly help?: string,
    buckets: number[] = DEFAULT_BUCKETS,
  ) {
    this.buckets = [...buckets].sort((a, b) => a - b);
    this.bucketCounts = new Array(this.buckets.length).fill(0);
  }

  observe(value: number): void {
    this.count += 1;
    this.sum += value;
    this.min = Math.min(this.min, value);
    this.max = Math.max(this.max, value);
    this.observations.push(value);
    for (let i = 0; i < this.buckets.length; i += 1) {
      if (value <= this.buckets[i]!) {
        this.bucketCounts[i]! += 1;
      }
    }
  }

  reset(): void {
    this.count = 0;
    this.sum = 0;
    this.min = Infinity;
    this.max = -Infinity;
    this.observations.length = 0;
    this.bucketCounts.fill(0);
  }

  snapshot(): MetricSnapshot {
    return { name: this.name, type: this.type, help: this.help, value: this.summary() };
  }

  summary(): HistogramSnapshot {
    const buckets: Record<string, number> = {};
    this.buckets.forEach((bound, i) => {
      buckets[String(bound)] = this.bucketCounts[i]!;
    });

    const percentiles: Record<string, number> = {};
    const sorted = [...this.observations].sort((a, b) => a - b);
    for (const p of DEFAULT_PERCENTILES) {
      percentiles[String(p)] = this.percentile(sorted, p);
    }

    return {
      count: this.count,
      sum: this.sum,
      min: this.count === 0 ? 0 : this.min,
      max: this.count === 0 ? 0 : this.max,
      mean: this.count === 0 ? 0 : this.sum / this.count,
      buckets,
      percentiles,
    };
  }

  private percentile(sorted: number[], p: number): number {
    if (sorted.length === 0) {
      return 0;
    }
    const idx = Math.min(sorted.length - 1, Math.floor(p * sorted.length));
    return sorted[idx]!;
  }
}

/** Registry that owns and exposes all metrics. */
export class MetricsRegistry {
  private readonly metrics = new Map<string, Counter | Gauge | Histogram>();

  private getOrCreate<T extends Counter | Gauge | Histogram>(name: string, create: () => T): T {
    let metric = this.metrics.get(name);
    if (!metric) {
      metric = create();
      this.metrics.set(name, metric);
    }
    return metric as T;
  }

  counter(name: string, help?: string): Counter {
    return this.getOrCreate(name, () => new Counter(name, help)) as Counter;
  }

  gauge(name: string, help?: string): Gauge {
    return this.getOrCreate(name, () => new Gauge(name, help)) as Gauge;
  }

  histogram(name: string, help?: string, buckets?: number[]): Histogram {
    return this.getOrCreate(name, () => new Histogram(name, help, buckets)) as Histogram;
  }

  get(name: string): Counter | Gauge | Histogram | undefined {
    return this.metrics.get(name);
  }

  reset(): void {
    this.metrics.forEach((metric) => metric.reset());
  }

  /** Export all metrics as a serializable snapshot. */
  export(): MetricsExport {
    const metrics: MetricSnapshot[] = [];
    this.metrics.forEach((metric) => metrics.push(metric.snapshot()));
    return { timestamp: new Date().toISOString(), metrics };
  }

  /** Produce a human-readable analysis of the collected metrics. */
  analyze(): MetricAnalysis {
    let counters = 0;
    let gauges = 0;
    let histograms = 0;
    const summary: string[] = [];

    this.metrics.forEach((metric) => {
      if (metric instanceof Counter) {
        counters += 1;
        summary.push(`counter ${metric.name} = ${metric.value}`);
      } else if (metric instanceof Gauge) {
        gauges += 1;
        summary.push(`gauge ${metric.name} = ${metric.value}`);
      } else if (metric instanceof Histogram) {
        histograms += 1;
        const s = metric.summary();
        summary.push(
          `histogram ${metric.name}: count=${s.count} mean=${s.mean.toFixed(4)} max=${s.max}`,
        );
      }
    });

    return {
      totalMetrics: this.metrics.size,
      counters,
      gauges,
      histograms,
      summary,
    };
  }
}

/** Shared default registry for SDK-wide metrics. */
export const metrics = new MetricsRegistry();
