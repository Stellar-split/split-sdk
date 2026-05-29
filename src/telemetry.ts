/**
 * Anonymous telemetry module for SDK usage tracking.
 * No PII (addresses, amounts) is collected.
 */

interface TelemetryEvent {
  method: string;
  success: boolean;
  durationMs: number;
  timestamp: number;
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
