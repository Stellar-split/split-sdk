# SDK Telemetry Hooks

> **Issue #362**: Add opt-in telemetry hooks for error and performance monitoring

## Overview

The telemetry hooks system allows application developers to integrate their own monitoring solutions (Sentry, Datadog, custom telemetry) without the SDK having any direct dependencies on third-party monitoring libraries.

All hooks are **fire-and-forget** — exceptions within hooks do not propagate to SDK callers, ensuring your monitoring code never breaks your application.

## Features

- ✅ `onError` hook called before every SDK error is thrown
- ✅ `onCallStart` hook called before each RPC call
- ✅ `onCallEnd` hook called after each RPC call (success or failure)
- ✅ Fire-and-forget semantics (hook exceptions are logged but don't propagate)
- ✅ Full TypeScript type safety
- ✅ Zero dependencies
- ✅ Opt-in (no performance impact when not configured)

## Installation

Telemetry hooks are included in the main SDK package:

```typescript
import { StellarSplitClient } from "@stellar-split/sdk";
import type {
  TelemetryHooks,
  TelemetryErrorContext,
  TelemetryCallStartParams,
  TelemetryCallEndParams,
} from "@stellar-split/sdk";
```

## Basic Usage

### Register Hooks

```typescript
const client = new StellarSplitClient({
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "CBQHNAXSI55GX2GN6D67GK7BHVPSLJUGZQEU7WJ5LKR5PNUCGLIMAO4K",
});

client.setTelemetryHooks({
  onError: (error, context) => {
    console.error(`[${context.method}] Error:`, error.message);
  },
  onCallStart: ({ method, timestamp }) => {
    console.log(`[${timestamp}] Starting ${method}`);
  },
  onCallEnd: ({ method, durationMs, success }) => {
    console.log(`[${method}] Completed in ${durationMs}ms (${success ? "✓" : "✗"})`);
  },
});
```

### Clear Hooks

```typescript
client.clearTelemetryHooks();
```

## Hook Signatures

### `onError`

Called whenever an SDK error is thrown, before it propagates to the caller.

```typescript
onError?: (error: StellarSplitError, context: TelemetryErrorContext) => void;
```

**Parameters:**
- `error`: The `StellarSplitError` instance that was thrown
- `context`: Object containing:
  - `method`: The SDK method name (e.g., "createInvoice", "pay")
  - `args`: Sanitized method arguments (no sensitive data)
  - `timestamp`: When the error occurred (milliseconds since epoch)

### `onCallStart`

Called before each SDK method invocation that makes an RPC call.

```typescript
onCallStart?: (params: TelemetryCallStartParams) => void;
```

**Parameters:**
- `params`: Object containing:
  - `method`: The SDK method name being invoked
  - `args`: Sanitized method arguments (optional)
  - `timestamp`: When the call started (milliseconds since epoch)

### `onCallEnd`

Called after each SDK method invocation completes (success or failure).

```typescript
onCallEnd?: (params: TelemetryCallEndParams) => void;
```

**Parameters:**
- `params`: Object containing:
  - `method`: The SDK method name that was invoked
  - `durationMs`: Duration of the call in milliseconds
  - `success`: `true` if the call succeeded, `false` if it threw an error
  - `error`: The error instance (only present when `success` is `false`)
  - `timestamp`: When the call ended (milliseconds since epoch)

## Integration Examples

### Sentry

```typescript
import * as Sentry from "@sentry/browser";

client.setTelemetryHooks({
  onError: (error, context) => {
    Sentry.captureException(error, {
      tags: {
        method: context.method,
        sdk: "@stellar-split/sdk",
      },
      extra: context,
    });
  },
  onCallEnd: ({ method, durationMs, success }) => {
    Sentry.addBreadcrumb({
      category: "sdk.rpc",
      message: `${method} ${success ? "succeeded" : "failed"}`,
      level: success ? "info" : "error",
      data: { durationMs },
    });
  },
});
```

### Datadog

```typescript
import { datadogRum } from "@datadog/browser-rum";

client.setTelemetryHooks({
  onError: (error, context) => {
    datadogRum.addError(error, {
      method: context.method,
      source: "stellar-split-sdk",
    });
  },
  onCallStart: ({ method, timestamp }) => {
    datadogRum.addTiming(`sdk.${method}.start`, timestamp);
  },
  onCallEnd: ({ method, durationMs, success }) => {
    datadogRum.addTiming(`sdk.${method}.duration`, durationMs);
    datadogRum.addAction(`sdk.${method}`, {
      success,
      durationMs,
    });
  },
});
```

### Custom Analytics

```typescript
class SDKAnalytics {
  private errors: Array<{ method: string; error: string; timestamp: number }> = [];
  private metrics: Map<string, { totalCalls: number; totalDuration: number; failures: number }> = new Map();

  trackError(method: string, error: Error, timestamp: number) {
    this.errors.push({ method, error: error.message, timestamp });
  }

  trackCall(method: string, durationMs: number, success: boolean) {
    const metric = this.metrics.get(method) ?? {
      totalCalls: 0,
      totalDuration: 0,
      failures: 0,
    };

    metric.totalCalls++;
    metric.totalDuration += durationMs;
    if (!success) metric.failures++;

    this.metrics.set(method, metric);
  }

  getReport() {
    return {
      errors: this.errors,
      metrics: Object.fromEntries(this.metrics),
    };
  }
}

const analytics = new SDKAnalytics();

client.setTelemetryHooks({
  onError: (error, context) => {
    analytics.trackError(context.method, error, context.timestamp);
  },
  onCallEnd: ({ method, durationMs, success }) => {
    analytics.trackCall(method, durationMs, success);
  },
});

// Later, retrieve analytics
console.log(analytics.getReport());
```

### Performance Monitoring

```typescript
const performanceMonitor = {
  slowCallThresholdMs: 2000,
  
  checkPerformance: ({ method, durationMs, success }: TelemetryCallEndParams) => {
    if (durationMs > performanceMonitor.slowCallThresholdMs) {
      console.warn(
        `⚠️ Slow SDK call detected: ${method} took ${durationMs}ms (threshold: ${performanceMonitor.slowCallThresholdMs}ms)`
      );
      
      // Send to your monitoring backend
      fetch("/api/monitoring/slow-calls", {
        method: "POST",
        body: JSON.stringify({ method, durationMs, success }),
      });
    }
  },
};

client.setTelemetryHooks({
  onCallEnd: performanceMonitor.checkPerformance,
});
```

## Advanced Patterns

### Conditional Hook Execution

```typescript
client.setTelemetryHooks({
  onError: (error, context) => {
    // Only track production errors
    if (process.env.NODE_ENV === "production") {
      trackError(error, context);
    }
  },
});
```

### Sampling

```typescript
const SAMPLE_RATE = 0.1; // Track 10% of calls

client.setTelemetryHooks({
  onCallEnd: (params) => {
    if (Math.random() < SAMPLE_RATE) {
      sendToAnalytics(params);
    }
  },
});
```

### Combining Multiple Monitoring Solutions

```typescript
client.setTelemetryHooks({
  onError: (error, context) => {
    // Send to multiple destinations
    Sentry.captureException(error, { extra: context });
    logToCloudWatch(error, context);
    notifySlack(error, context);
  },
});
```

## Fire-and-Forget Behavior

All hooks are fire-and-forget. If a hook throws an exception, it will be logged to the console but **will not** break your application:

```typescript
client.setTelemetryHooks({
  onError: (error, context) => {
    // This throws, but won't crash your app
    throw new Error("Monitoring service unavailable");
  },
});

// This still works normally
try {
  await client.getInvoice("123");
} catch (error) {
  // You'll catch the SDK error, not the hook error
  console.error(error);
}
```

Console output:
```
[TelemetryHook] onError hook threw an exception: Error: Monitoring service unavailable
```

## Performance Considerations

- **Zero overhead when not configured**: Hooks have no performance impact when not registered
- **Minimal overhead when configured**: Hook execution is synchronous and fast
- **Fire-and-forget**: Hook errors never block SDK operations
- **No memory leaks**: Hooks are properly cleaned up when cleared

## TypeScript Support

All hook types are fully typed for IDE autocomplete and type safety:

```typescript
import type {
  TelemetryHooks,
  TelemetryErrorContext,
  TelemetryCallStartParams,
  TelemetryCallEndParams,
} from "@stellar-split/sdk";

const hooks: TelemetryHooks = {
  onError: (error, context) => {
    // `error` is typed as StellarSplitError
    // `context` is typed as TelemetryErrorContext
    console.log(error.code, context.method);
  },
  onCallStart: (params) => {
    // `params` is typed as TelemetryCallStartParams
    console.log(params.method, params.timestamp);
  },
  onCallEnd: (params) => {
    // `params` is typed as TelemetryCallEndParams
    console.log(params.success, params.durationMs);
  },
};
```

## Best Practices

1. **Keep hooks lightweight**: Avoid heavy computation in hooks
2. **Use async operations carefully**: If you need to make async calls, don't await them in hooks
3. **Handle hook errors gracefully**: Expect hooks to fail occasionally (network issues, etc.)
4. **Sanitize sensitive data**: The SDK provides basic sanitization, but you may want additional filtering
5. **Test your hooks**: Ensure your monitoring code doesn't introduce bugs

## Troubleshooting

### Hook not being called

Ensure the hook is registered before making SDK calls:

```typescript
client.setTelemetryHooks({ onError });
await client.createInvoice(params); // Hook will be called
```

### Hook exceptions appearing in console

This is expected fire-and-forget behavior. Fix the exception in your hook code:

```typescript
client.setTelemetryHooks({
  onError: (error, context) => {
    try {
      // Your monitoring code
      sendToSentry(error);
    } catch (err) {
      // Handle gracefully
      console.warn("Failed to send error to Sentry:", err);
    }
  },
});
```

## Migration Guide

If you were using custom error handling before:

```typescript
// Before
try {
  await client.createInvoice(params);
} catch (error) {
  trackError(error);
  throw error;
}
```

```typescript
// After
client.setTelemetryHooks({
  onError: (error, context) => trackError(error, context),
});

await client.createInvoice(params); // Error tracking happens automatically
```

## API Reference

### `client.setTelemetryHooks(hooks: TelemetryHooks): void`

Register telemetry hooks. Replaces any previously registered hooks.

### `client.clearTelemetryHooks(): void`

Remove all registered telemetry hooks.

## Related Issues

- [#362: Add SDK telemetry hooks for error and performance monitoring](https://github.com/Stellar-split/split-sdk/issues/362)

## License

MIT
