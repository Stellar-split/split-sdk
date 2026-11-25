# SDK Advanced Usage Guide

This guide builds on [SDK_TUTORIALS.md](./SDK_TUTORIALS.md) and covers the patterns, best practices and
optimizations used by production integrations of `@stellar-split/sdk`.

## Table of Contents

1. [Usage Patterns](#usage-patterns)
2. [Examples](#examples)
3. [Best Practices](#best-practices)
4. [Optimization Guide](#optimization-guide)
5. [Reference](#reference)

---

## Usage Patterns

### Resilient client configuration

Pass an array of RPC URLs to enable warm-standby failover, and combine it with retry, rate limiting and caching:

```typescript
import { StellarSplitClient } from "@stellar-split/sdk";

const client = new StellarSplitClient({
  rpcUrl: [
    "https://soroban-testnet.stellar.org",
    "https://backup-rpc.example.com",
  ],
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "YOUR_DEPLOYED_CONTRACT_ID",
  // Automatic retry with exponential backoff and jitter
  retry: { maxAttempts: 4, baseDelayMs: 250, maxDelayMs: 5_000 },
  // Outbound rate limiting for transaction submission
  rateLimit: { maxRequestsPerSecond: 10, windowMs: 1_000 },
  // In-memory read cache
  cache: { enabled: true, ttlMs: 30_000 },
});
```

### Reacting to client events

`StellarSplitClient` is a typed event emitter. Subscribe to circuit breaker, endpoint and wallet events to drive
monitoring or UI state. Circuit events fire when `advancedCircuitBreaker` is configured; endpoint events fire when
`rpcEndpoints` is configured.

```typescript
client.on("circuit:open", () => console.warn("Circuit breaker opened"));
client.on("circuit:close", () => console.info("Circuit breaker closed"));
client.on("endpoint:demoted", ({ url, reason }) => console.warn(`RPC endpoint ${url} demoted: ${reason}`));
client.on("wallet:disconnected", () => console.info("Wallet disconnected"));
```

### Extending the client with plugins

Plugins receive lifecycle hooks and are torn down in reverse registration order on `shutdown()`:

```typescript
import { StellarSplitClient, type StellarSplitPlugin } from "@stellar-split/sdk";

const auditPlugin: StellarSplitPlugin = {
  name: "audit-log",
  install(client) {
    console.log("installed on", client.constructor.name);
  },
  onDestroy() {
    console.log("shutting down");
  },
};

const client = new StellarSplitClient({ ...config, plugins: [auditPlugin] });
```

See [`examples/plugin-and-interceptors.ts`](../examples/plugin-and-interceptors.ts) for a runnable version.

---

## Examples

### Simulate before you submit

`pay()` accepts `simulate: true` to dry-run a payment without broadcasting it:

```typescript
import { parseAmount } from "@stellar-split/sdk";

const simulation = await client.pay({
  payer: payerKey,
  invoiceId,
  amount: parseAmount("25"),
  simulate: true,
});

if (simulation.success) {
  console.log(`Estimated fee: ${simulation.fee} stroops`);
  await client.pay({ payer: payerKey, invoiceId, amount: parseAmount("25") });
}
```

### Preflight checks

Verify invoice expiry and payer readiness in one call before paying:

```typescript
const check = await client.preflightCheck({ invoiceId, payer: payerKey, amount: parseAmount("25") });

if (check.valid) {
  await client.pay({ payer: payerKey, invoiceId, amount: parseAmount("25") });
}
```

### Batch invoice creation

Create up to five invoices in a single transaction:

```typescript
const { invoiceIds, txHash } = await client.batchCreateInvoices([invoiceA, invoiceB, invoiceC]);
```

### Validating assets before use

Validate asset codes, issuers, custom token contracts and amounts offline:

```typescript
import { validateStellarAsset } from "@stellar-split/sdk";

const result = validateStellarAsset(
  { code: "USDC", issuer: "GA5Z...ISSUER" },
  { amount: "250.50", limit: "10000", allowedIssuers: ["GA5Z...ISSUER"] },
);

if (!result.valid) {
  throw new Error(result.errors.join("; "));
}
```

### Payment retry with provider fallback

Retry transient failures with exponential backoff and fall back to another provider when one gives up:

```typescript
import { PaymentFlowRetry, PaymentFlowExhaustedError } from "@stellar-split/sdk";

const flow = new PaymentFlowRetry(
  [
    { name: "primary", execute: (p) => primaryClient.pay(p) },
    { name: "backup", execute: (p) => backupClient.pay(p) },
  ],
  { maxAttempts: 3, baseDelayMs: 500, jitter: 0.2 },
);

try {
  const { result, provider, attempts } = await flow.execute({ payer: payerKey, invoiceId, amount });
  console.log(`Paid via ${provider} after ${attempts.length} attempt(s): ${result.txHash}`);
} catch (err) {
  if (err instanceof PaymentFlowExhaustedError) {
    console.error("All providers failed", err.attempts);
  }
}
```

### Graceful shutdown

Drain in-flight requests before terminating the client:

```typescript
process.on("SIGTERM", async () => {
  await client.waitForInFlightRequests();
  await client.shutdown();
});
```

---

## Best Practices

- **Use bigint amounts.** Convert user input with `parseAmount()` and keep amounts as `bigint` stroops end to end.
- **Validate early.** Run `validateStellarAsset()` and `preflightCheck()` before building transactions so failures
  surface as clear messages instead of contract errors.
- **Branch on error codes, not messages.** Every SDK error extends `StellarSplitError` and carries a `code`; use
  `isRetryableErrorCode(err.code)` to decide whether to retry.
- **Only retry transient failures.** Validation and authorization errors will fail the same way every time; retrying
  them wastes fees and rate-limit budget.
- **Configure failover for production.** Supply at least two RPC URLs and subscribe to `circuit:*` and `endpoint:*` events.
- **Shut down cleanly.** Call `waitForInFlightRequests()` then `shutdown()` so plugins and timers are released.
- **Never log secrets.** Keep keypairs in a `signer` adapter rather than passing raw secret keys around.

```typescript
import { StellarSplitError, isRetryableErrorCode } from "@stellar-split/sdk";

try {
  await client.pay(params);
} catch (err) {
  if (err instanceof StellarSplitError && isRetryableErrorCode(err.code)) {
    // schedule a retry
  } else {
    throw err;
  }
}
```

---

## Optimization Guide

| Goal | Technique |
|------|-----------|
| Fewer RPC reads | Enable `cache` with a `ttlMs` that matches how fresh invoice data must be |
| Fewer transactions | Group invoice creation with `batchCreateInvoices()` (1–5 per transaction) |
| Avoid failed submissions | `simulate: true` and `preflightCheck()` before `pay()` |
| Smooth traffic spikes | `rateLimit` queues submissions instead of overloading the RPC node |
| Avoid thundering herds | Add `jitter` to retry backoff so concurrent clients spread their retries |
| Survive node outages | Pass an array to `rpcUrl` for warm-standby failover |

See [PERFORMANCE_TUNING.md](./PERFORMANCE_TUNING.md) for detailed tuning of connection pooling and timeouts.

---

## Reference

### Client configuration options used in this guide

| Option | Type | Purpose |
|--------|------|---------|
| `rpcUrl` | `string \| string[]` | RPC endpoint; an array enables failover |
| `retry` | `RetryOptions` | `maxAttempts`, `baseDelayMs`, `maxDelayMs`, `retryIf`, `onRetry` |
| `rateLimit` | `RateLimiterConfig` | `maxRequestsPerSecond`, `windowMs`, `perKeyLimit` |
| `cache` | `{ enabled?, ttl?, ttlMs? }` | In-memory read cache |
| `plugins` | `StellarSplitPlugin[]` | Lifecycle extensions |
| `signer` | `Signer` | Pluggable signing vault |

### Utilities

| Export | Description |
|--------|-------------|
| `validateStellarAsset(asset, options?)` | Validates native, classic and custom token assets plus amount limits |
| `PaymentFlowRetry` | Retries payments with exponential backoff and provider fallback |
| `FallbackChain` | Executes an operation against a list of URLs until one succeeds |
| `isRetryableErrorCode(code)` | Reports whether an SDK error code is transient |
| `parseAmount(value)` | Converts a decimal string to bigint stroops |

### Related documentation

- [API.md](./API.md) — full API reference
- [ERROR_CODES.md](./ERROR_CODES.md) — error code catalogue
- [PERFORMANCE_TUNING.md](./PERFORMANCE_TUNING.md) — performance tuning
- [MIGRATION.md](./MIGRATION.md) — migration notes
