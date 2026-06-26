/**
 * Anonymous feature-usage analytics collector.
 *
 * Wraps a StellarSplitClient instance with a Proxy that counts method
 * invocations by name. Zero arguments are captured. Strictly opt-in via
 * config.usageAnalytics.enabled === true.
 */

import type { StellarSplitClientConfig } from "./client.js";

export interface UsageAnalyticsConfig {
  enabled: boolean;
  endpoint?: string;
  flushIntervalMs?: number;
}

/** Snapshot of accumulated call counts, keyed by method name. */
export type FeatureCountSnapshot = Record<string, number>;

export class UsageAnalyticsCollector {
  private readonly counts: Record<string, number> = {};
  private readonly config: UsageAnalyticsConfig;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(config: UsageAnalyticsConfig) {
    this.config = config;
    if (config.enabled && (config.flushIntervalMs ?? 60_000) > 0) {
      this.timer = setInterval(
        () => void this.flush(),
        config.flushIntervalMs ?? 60_000
      );
      // Don't block Node.js exit
      if (typeof this.timer === "object" && this.timer !== null && "unref" in this.timer) {
        (this.timer as NodeJS.Timeout).unref();
      }
    }
  }

  /** Increment the counter for a method name. No-op when disabled. */
  record(method: string): void {
    if (!this.config.enabled) return;
    this.counts[method] = (this.counts[method] ?? 0) + 1;
  }

  /** Return a copy of the current counts. */
  getCounts(): FeatureCountSnapshot {
    return { ...this.counts };
  }

  /**
   * Dispatch accumulated counts to the configured endpoint and reset.
   * Safe to call even when disabled (becomes a no-op).
   */
  async flush(): Promise<void> {
    if (!this.config.enabled) return;

    const snapshot = this.getCounts();
    // Reset before sending so the next window starts clean even on send failure
    for (const key of Object.keys(this.counts)) {
      delete this.counts[key];
    }

    if (this.config.endpoint && Object.keys(snapshot).length > 0) {
      try {
        await fetch(this.config.endpoint, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ featureCounts: snapshot }),
        });
      } catch {
        // Non-blocking; analytics failures must never surface to the caller.
      }
    }
  }

  /** Stop the background flush timer. */
  destroy(): void {
    if (this.timer !== null) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Wrap a StellarSplitClient instance with a Proxy that records method calls.
 * If usageAnalytics is disabled the original instance is returned unchanged.
 *
 * @param client   - The client instance to wrap.
 * @param config   - Full client config (analytics config read from .usageAnalytics).
 * @param collector - Pre-constructed collector (allows injection in tests).
 * @returns The (possibly proxied) client and the collector.
 */
export function wrapWithAnalytics<T extends object>(
  client: T,
  config: Pick<StellarSplitClientConfig, "usageAnalytics">,
  collector?: UsageAnalyticsCollector
): { proxy: T; collector: UsageAnalyticsCollector } {
  const analyticsConfig: UsageAnalyticsConfig = {
    enabled: config.usageAnalytics?.enabled ?? false,
    endpoint: config.usageAnalytics?.endpoint,
    flushIntervalMs: config.usageAnalytics?.flushIntervalMs,
  };

  const instance = collector ?? new UsageAnalyticsCollector(analyticsConfig);

  if (!analyticsConfig.enabled) {
    return { proxy: client, collector: instance };
  }

  const proxy = new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value === "function" && typeof prop === "string") {
        return function (this: unknown, ...args: unknown[]) {
          instance.record(prop);
          return (value as (...a: unknown[]) => unknown).apply(this ?? target, args);
        };
      }
      return value;
    },
  });

  return { proxy, collector: instance };
}
