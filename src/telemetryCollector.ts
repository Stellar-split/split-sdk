/**
 * In-memory telemetry aggregator for SDK operational metrics.
 */

export interface MethodLatencyReport {
  calls: number;
  errors: number;
  p50: number;
  p95: number;
  samples: number;
}

export interface TelemetryReport {
  period: number;
  methods: Record<string, MethodLatencyReport>;
}

interface MethodMetrics {
  count: number;
  errors: number;
  latencies: number[];
}

export class TelemetryCollector {
  private startTime = Date.now();
  private methods = new Map<string, MethodMetrics>();
  private readonly windowSize = 100;

  recordMethod(method: string, success: boolean, durationMs: number): void {
    const metrics = this.methods.get(method) ?? { count: 0, errors: 0, latencies: [] };
    metrics.count += 1;
    if (!success) {
      metrics.errors += 1;
    }
    metrics.latencies.push(durationMs);
    if (metrics.latencies.length > this.windowSize) {
      metrics.latencies.shift();
    }
    this.methods.set(method, metrics);
  }

  getReport(): TelemetryReport {
    const methods: Record<string, MethodLatencyReport> = {};

    for (const [method, metrics] of this.methods.entries()) {
      const sorted = [...metrics.latencies].sort((a, b) => a - b);
      methods[method] = {
        calls: metrics.count,
        errors: metrics.errors,
        samples: sorted.length,
        p50: this.getPercentile(sorted, 50),
        p95: this.getPercentile(sorted, 95),
      };
    }

    return {
      period: Date.now() - this.startTime,
      methods,
    };
  }

  reset(): void {
    this.startTime = Date.now();
    this.methods.clear();
  }

  private getPercentile(sorted: number[], percentile: number): number {
    if (sorted.length === 0) {
      return 0;
    }
    const index = Math.ceil((percentile / 100) * sorted.length) - 1;
    return sorted[Math.min(Math.max(index, 0), sorted.length - 1)] ?? 0;
  }
}
