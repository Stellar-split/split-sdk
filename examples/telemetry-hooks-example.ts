/**
 * Example: Using SDK Telemetry Hooks
 * 
 * Demonstrates how to integrate monitoring solutions like Sentry, Datadog,
 * or custom analytics with the StellarSplit SDK.
 */

import { StellarSplitClient } from "@stellar-split/sdk";
import type {
  TelemetryHooks,
  TelemetryErrorContext,
  TelemetryCallEndParams,
} from "@stellar-split/sdk";

// Initialize the SDK client
const client = new StellarSplitClient({
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K",
});

// Example 1: Basic console logging
console.log("=== Example 1: Basic Logging ===");
client.setTelemetryHooks({
  onError: (error, context) => {
    console.error(`❌ [${context.method}] Error: ${error.message}`);
  },
  onCallStart: ({ method, timestamp }) => {
    console.log(`🚀 [${new Date(timestamp).toISOString()}] Starting ${method}`);
  },
  onCallEnd: ({ method, durationMs, success }) => {
    const icon = success ? "✅" : "❌";
    console.log(`${icon} [${method}] Completed in ${durationMs}ms`);
  },
});

// Example 2: Performance monitoring
console.log("\n=== Example 2: Performance Monitoring ===");

class PerformanceMonitor {
  private metrics = new Map<string, number[]>();

  track(method: string, durationMs: number) {
    const durations = this.metrics.get(method) ?? [];
    durations.push(durationMs);
    this.metrics.set(method, durations);
  }

  getStats(method: string) {
    const durations = this.metrics.get(method) ?? [];
    if (durations.length === 0) return null;

    const sorted = [...durations].sort((a, b) => a - b);
    const sum = durations.reduce((acc, d) => acc + d, 0);

    return {
      calls: durations.length,
      avg: sum / durations.length,
      min: sorted[0],
      max: sorted[sorted.length - 1],
      p50: sorted[Math.floor(sorted.length * 0.5)],
      p95: sorted[Math.floor(sorted.length * 0.95)],
    };
  }

  report() {
    console.log("\n📊 Performance Report:");
    for (const [method, durations] of this.metrics) {
      const stats = this.getStats(method);
      if (stats) {
        console.log(`  ${method}:`);
        console.log(`    Calls: ${stats.calls}`);
        console.log(`    Avg: ${stats.avg.toFixed(2)}ms`);
        console.log(`    P50: ${stats.p50}ms, P95: ${stats.p95}ms`);
        console.log(`    Range: ${stats.min}ms - ${stats.max}ms`);
      }
    }
  }
}

const perfMonitor = new PerformanceMonitor();

client.setTelemetryHooks({
  onCallEnd: ({ method, durationMs }) => {
    perfMonitor.track(method, durationMs);
  },
});

// Example 3: Error tracking with context
console.log("\n=== Example 3: Error Tracking ===");

class ErrorTracker {
  private errors: Array<{
    method: string;
    error: string;
    code: string;
    timestamp: number;
  }> = [];

  track(error: any, context: TelemetryErrorContext) {
    this.errors.push({
      method: context.method,
      error: error.message,
      code: error.code ?? "UNKNOWN",
      timestamp: context.timestamp,
    });
  }

  report() {
    console.log("\n🔴 Error Report:");
    if (this.errors.length === 0) {
      console.log("  No errors recorded ✨");
      return;
    }

    const errorsByMethod = new Map<string, number>();
    for (const err of this.errors) {
      errorsByMethod.set(err.method, (errorsByMethod.get(err.method) ?? 0) + 1);
    }

    for (const [method, count] of errorsByMethod) {
      console.log(`  ${method}: ${count} error(s)`);
    }

    console.log("\n  Recent errors:");
    this.errors.slice(-3).forEach((err) => {
      console.log(`    [${err.method}] ${err.code}: ${err.error}`);
    });
  }
}

const errorTracker = new ErrorTracker();

client.setTelemetryHooks({
  onError: (error, context) => {
    errorTracker.track(error, context);
  },
});

// Example 4: Slow call detection
console.log("\n=== Example 4: Slow Call Detection ===");

const SLOW_THRESHOLD_MS = 1000;

client.setTelemetryHooks({
  onCallEnd: ({ method, durationMs, success }: TelemetryCallEndParams) => {
    if (durationMs > SLOW_THRESHOLD_MS) {
      console.warn(
        `⚠️  Slow call detected: ${method} took ${durationMs}ms (threshold: ${SLOW_THRESHOLD_MS}ms)`
      );
    }
  },
});

// Example 5: Sentry integration (mock)
console.log("\n=== Example 5: Sentry Integration (Mock) ===");

const MockSentry = {
  captureException: (error: Error, options?: any) => {
    console.log(`[Sentry] Captured exception:`, error.message);
    if (options?.extra) {
      console.log(`[Sentry] Extra context:`, options.extra);
    }
  },
  addBreadcrumb: (breadcrumb: any) => {
    console.log(`[Sentry] Breadcrumb:`, breadcrumb.message);
  },
};

client.setTelemetryHooks({
  onError: (error, context) => {
    MockSentry.captureException(error, {
      tags: {
        method: context.method,
        sdk: "@stellar-split/sdk",
      },
      extra: context,
    });
  },
  onCallEnd: ({ method, durationMs, success }) => {
    MockSentry.addBreadcrumb({
      category: "sdk.rpc",
      message: `${method} ${success ? "succeeded" : "failed"}`,
      level: success ? "info" : "error",
      data: { durationMs },
    });
  },
});

// Example 6: Custom analytics aggregator
console.log("\n=== Example 6: Custom Analytics ===");

class AnalyticsAggregator {
  private stats = {
    totalCalls: 0,
    successfulCalls: 0,
    failedCalls: 0,
    totalDuration: 0,
    errors: 0,
  };

  trackCall(params: TelemetryCallEndParams) {
    this.stats.totalCalls++;
    this.stats.totalDuration += params.durationMs;
    
    if (params.success) {
      this.stats.successfulCalls++;
    } else {
      this.stats.failedCalls++;
    }
  }

  trackError() {
    this.stats.errors++;
  }

  report() {
    const successRate = (this.stats.successfulCalls / this.stats.totalCalls) * 100;
    const avgDuration = this.stats.totalDuration / this.stats.totalCalls;

    console.log("\n📈 Analytics Summary:");
    console.log(`  Total Calls: ${this.stats.totalCalls}`);
    console.log(`  Success Rate: ${successRate.toFixed(1)}%`);
    console.log(`  Failed Calls: ${this.stats.failedCalls}`);
    console.log(`  Total Errors: ${this.stats.errors}`);
    console.log(`  Avg Duration: ${avgDuration.toFixed(2)}ms`);
  }
}

const analytics = new AnalyticsAggregator();

client.setTelemetryHooks({
  onError: () => analytics.trackError(),
  onCallEnd: (params) => analytics.trackCall(params),
});

// Example usage: Make some SDK calls
async function demonstrateHooks() {
  console.log("\n=== Running SDK Operations ===\n");

  try {
    // This will trigger hooks
    await client.getInvoice("123");
  } catch (error) {
    console.log("Expected error caught in main code");
  }

  try {
    await client.getInvoice("456");
  } catch (error) {
    console.log("Expected error caught in main code");
  }

  // Generate reports
  perfMonitor.report();
  errorTracker.report();
  analytics.report();

  // Clear hooks when done
  console.log("\n=== Clearing Hooks ===");
  client.clearTelemetryHooks();
  console.log("✅ Telemetry hooks cleared");
}

// Run the demonstration
demonstrateHooks().catch(console.error);

// Example 7: Fire-and-forget behavior demonstration
console.log("\n=== Example 7: Fire-and-Forget ===");

client.setTelemetryHooks({
  onError: (error, context) => {
    // This hook intentionally throws
    throw new Error("Hook failure - this won't crash your app!");
  },
  onCallStart: () => {
    console.log("✅ onCallStart executed successfully");
  },
});

console.log("\nEven if hooks throw exceptions, SDK operations continue normally.");
console.log("Hook exceptions are logged to console but don't propagate to your code.");

export { client, perfMonitor, errorTracker, analytics };
