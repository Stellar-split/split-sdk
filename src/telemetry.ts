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

class Telemetry {
  private config: TelemetryConfig | null = null;
  private events: TelemetryEvent[] = [];
  private flushInterval: ReturnType<typeof setInterval> | null = null;
  private readonly FLUSH_INTERVAL_MS = 60000;
  /** Stack of active span IDs; the top is the current span for new events. */
  private spanStack: string[] = [];

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
   */
  startSpan(spanId: string): void {
    this.spanStack.push(spanId);
  }

  /**
   * End the most recently started span. When `spanId` is given, entries are
   * popped up to and including its first match from the top, tolerating a
   * missed `endSpan` call.
   */
  endSpan(spanId?: string): void {
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
   * Record a method call.
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
