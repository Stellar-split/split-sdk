/**
 * Anonymous telemetry module for SDK usage tracking.
 * No PII (addresses, amounts) is collected.
 */

export interface TelemetryEvent {
  method: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
  /**
   * ID of the span this event was emitted within, enabling tracing backends to
   * reconstruct parent-child relationships. `undefined` when the event was
   * emitted outside of any active span.
   */
  parentSpanId?: string;
}

interface TelemetryConfig {
  endpoint: string;
  optOut?: boolean;
}

/**
 * Aggregated counters for a single method, used for Prometheus export.
 */
interface MethodMetrics {
  calls: number;
  successes: number;
  failures: number;
  durationMsSum: number;
}

class Telemetry {
  private config: TelemetryConfig | null = null;
  private events: TelemetryEvent[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private readonly FLUSH_INTERVAL_MS = 60000;
  /** Stack of active span IDs; the top is the current span for new events. */
  private spanStack: string[] = [];
  /** Per-method aggregated metrics, keyed by method name. */
  private metrics = new Map<string, MethodMetrics>();

  /**
   * Initialize telemetry with configuration.
   */
  init(config: TelemetryConfig): void {
    this.config = config;

    if (!config.optOut) {
      this.flushInterval = setInterval(() => {
        this.flush();
      }, this.FLUSH_INTERVAL_MS);
    }
  }

  /**
   * Mark a span as active. Events recorded until the matching {@link endSpan}
   * (or {@link runInSpan} scope exit) inherit `spanId` as their `parentSpanId`.
   * No-op when telemetry is uninitialized or opted out.
   */
  startSpan(spanId: string): void {
    if (!this.config || this.config.optOut) {
      return;
    }
    this.spanStack.push(spanId);
  }

  /**
   * End the most recently started span. When `spanId` is given, entries are
   * popped up to and including its first match from the top, tolerating a
   * missed `endSpan` call.
   */
  endSpan(spanId?: string): void {
    if (!this.config || this.config.optOut) {
      return;
    }
    if (spanId === undefined) {
      this.spanStack.pop();
      return;
    }
    const idx = this.spanStack.lastIndexOf(spanId);
    if (idx !== -1) {
      this.spanStack.length = idx;
    }
  }

  /**
   * Run `fn` with `spanId` active, so any telemetry events it records inherit
   * that span as their parent. Works for sync and async `fn`; the span is
   * always ended, including on throw or rejection.
   */
  runInSpan<T>(spanId: string, fn: () => T): T {
    if (!this.config || this.config.optOut) {
      return fn();
    }
    this.startSpan(spanId);
    let result: T;
    try {
      result = fn();
    } catch (error) {
      this.endSpan(spanId);
      throw error;
    }
    if (result instanceof Promise) {
      return result.finally(() => this.endSpan(spanId)) as T;
    }
    this.endSpan(spanId);
    return result;
  }

  /** The span ID new events currently inherit, or `undefined` outside any span. */
  private currentSpanId(): string | undefined {
    return this.spanStack.length > 0 ? this.spanStack[this.spanStack.length - 1] : undefined;
  }

  /**
   * Record a method call. No-op when telemetry is uninitialized or opted out.
   */
  recordMethod(method: string, success: boolean, durationMs: number): void {
    if (!this.config || this.config.optOut) {
      return;
    }

    this.events.push({
      method,
      success,
      durationMs,
      timestamp: Date.now(),
      parentSpanId: this.currentSpanId(),
    });

    this.recordMetric(method, success, durationMs);
  }

  /**
   * Update the aggregated per-method metrics for a recorded call.
   */
  private recordMetric(method: string, success: boolean, durationMs: number): void {
    let entry = this.metrics.get(method);
    if (!entry) {
      entry = { calls: 0, successes: 0, failures: 0, durationMsSum: 0 };
      this.metrics.set(method, entry);
    }
    entry.calls += 1;
    if (success) {
      entry.successes += 1;
    } else {
      entry.failures += 1;
    }
    entry.durationMsSum += durationMs;
  }

  /**
   * Escape a Prometheus label value per the text exposition format.
   */
  private escapeLabelValue(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
  }

  /**
   * Export the collected SDK metrics in the Prometheus text exposition format.
   * Returns an empty string when telemetry is disabled or no metrics exist.
   */
  exportPrometheus(): string {
    if (!this.config || this.config.optOut || this.metrics.size === 0) {
      return "";
    }

    const lines: string[] = [];

    lines.push("# HELP sdk_method_calls_total Total number of SDK method calls.");
    lines.push("# TYPE sdk_method_calls_total counter");
    for (const [method, m] of this.metrics) {
      lines.push(`sdk_method_calls_total{method="${this.escapeLabelValue(method)}"} ${m.calls}`);
    }

    lines.push("# HELP sdk_method_successes_total Total number of successful SDK method calls.");
    lines.push("# TYPE sdk_method_successes_total counter");
    for (const [method, m] of this.metrics) {
      lines.push(
        `sdk_method_successes_total{method="${this.escapeLabelValue(method)}"} ${m.successes}`,
      );
    }

    lines.push("# HELP sdk_method_failures_total Total number of failed SDK method calls.");
    lines.push("# TYPE sdk_method_failures_total counter");
    for (const [method, m] of this.metrics) {
      lines.push(
        `sdk_method_failures_total{method="${this.escapeLabelValue(method)}"} ${m.failures}`,
      );
    }

    lines.push("# HELP sdk_method_duration_ms_sum Total duration of SDK method calls in milliseconds.");
    lines.push("# TYPE sdk_method_duration_ms_sum counter");
    for (const [method, m] of this.metrics) {
      lines.push(
        `sdk_method_duration_ms_sum{method="${this.escapeLabelValue(method)}"} ${m.durationMsSum}`,
      );
    }

    return lines.join("\n") + "\n";
  }

  /**
   * Flush events to the telemetry endpoint.
   */
  private async flush(): Promise<void> {
    if (!this.config || this.config.optOut || this.events.length === 0) {
      return;
    }

    const payload = {
      events: this.events,
    };

    try {
      await fetch(this.config.endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      this.events = [];
    } catch (error) {
      // Silently fail - telemetry should not break the SDK
      console.error("Telemetry flush failed:", error);
    }
  }

  /**
   * Cleanup telemetry resources.
   */
  destroy(): void {
    if (this.flushInterval) {
      clearInterval(this.flushInterval);
      this.flushInterval = null;
    }
    this.flush();
  }
}

export const telemetry = new Telemetry();

/**
 * Test-only handle exposing the singleton's internals so opt-out and metric
 * accuracy can be verified without leaking state between tests.
 */
export const __testing = {
  reset(): void {
    if (telemetry["flushInterval"]) {
      clearInterval(telemetry["flushInterval"]);
    }
    telemetry["flushInterval"] = null;
    telemetry["config"] = null;
    telemetry["events"] = [];
    telemetry["spanStack"] = [];
    telemetry["metrics"] = new Map();
  },
  getEvents(): TelemetryEvent[] {
    return telemetry["events"];
  },
  getMetrics(): Map<string, MethodMetrics> {
    return telemetry["metrics"];
  },
  getSpanStack(): string[] {
    return telemetry["spanStack"];
  },
};
