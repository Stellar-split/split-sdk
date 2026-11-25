# StellarSplit SDK Debugging Guide

A comprehensive guide to debugging techniques, tools, troubleshooting strategies, and frequently asked questions for the StellarSplit SDK.

---

## Table of Contents

1. [Quick Start](#1-quick-start)
2. [Debug Logging](#2-debug-logging)
3. [Debugging Tools](#3-debugging-tools)
4. [Common Debugging Techniques](#4-common-debugging-techniques)
5. [Transaction Debugging](#5-transaction-debugging)
6. [Network & RPC Debugging](#6-network--rpc-debugging)
7. [Integration Test Debugging](#7-integration-test-debugging)
8. [Error Investigation](#8-error-investigation)
9. [Performance Debugging](#9-performance-debugging)
10. [Troubleshooting Guide](#10-troubleshooting-guide)
11. [FAQ](#11-faq)

---

## 1. Quick Start

### Enable Debug Logging

```typescript
import { StellarSplitClient, LogLevel } from "@stellar-split/sdk";

const client = new StellarSplitClient({
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "YOUR_CONTRACT_ID",
  logger: true,  // Enable default logging
  // OR configure detailed logging:
  logger: {
    level: LogLevel.DEBUG,
    filter: (entry) => {
      // Filter out noisy components
      return entry.context?.component !== "noisy-poller";
    }
  }
});
```

### Quick Diagnosis

```typescript
// 1. Check if the problem is network-related
try {
  const invoice = await client.getInvoice(invoiceId);
} catch (err) {
  if (isRetryable(err)) {
    console.log("Network issue detected:", err.message);
  }
}

// 2. Use simulation before actual submission
const result = await client.simulate("createInvoice", params);
console.log("Simulation:", result.success, result.error);

// 3. Check error codes
if (err instanceof StellarSplitError) {
  console.log("Error code:", err.code);
  console.log("Context:", err.context);
  console.log("Raw panic:", err.raw);
}
```

---

## 2. Debug Logging

### SdkLogger Configuration

The SDK's `SdkLogger` is silent by default for production use. Enable it explicitly:

```typescript
import { SdkLogger, LogLevel } from "@stellar-split/sdk";

const logger = new SdkLogger({
  level: LogLevel.DEBUG,  // TRACE | DEBUG | INFO | WARN | ERROR
  filter: (entry) => {
    // Custom filtering logic
    return entry.context?.component !== "cache";
  },
});

// Use with client
const client = new StellarSplitClient({
  rpcUrl: "...",
  logger,
});
```

### Log Levels

| Level | Use Case |
|-------|----------|
| `TRACE` | Very detailed, includes all RPC requests/responses |
| `DEBUG` | Development debugging, component lifecycle |
| `INFO` | Important state changes, transactions submitted |
| `WARN` | Recoverable issues, retries, circuit breaker events |
| `ERROR` | Errors that require attention |

### Structured Logging

```typescript
logger.debug("RPC request started", { 
  component: "rpc", 
  requestId: "req-42",
  method: "getAccount"
});

// View statistics
console.log(logger.getStats());
// Output: { total: 150, byLevel: { DEBUG: 100, INFO: 30, WARN: 15, ERROR: 5 } }

// Reset statistics
logger.resetStats();
```

### Component-Based Filtering

```typescript
const logger = new SdkLogger({
  level: LogLevel.DEBUG,
  filter: (entry) => {
    // Only log RPC and transaction components
    const component = entry.context?.component;
    return component === "rpc" || component === "transaction";
  },
});
```

### Redaction

The SDK automatically redacts sensitive information from logs:
- Signing keys
- Secrets
- API tokens
- Webhook secrets

---

## 3. Debugging Tools

### 3.1 Simulation API

Test contract calls without consuming sequence numbers or fees:

```typescript
// Simulate any contract method
const simResult = await client.simulate("createInvoice", {
  creator: publicKey,
  recipients: [{ address: "GABC...", amount: parseAmount("100") }],
  token: tokenAddress,
  deadline: deadlineFromDays(7),
});

console.log({
  success: simResult.success,
  fee: simResult.fee,
  cpuInsns: simResult.cpuInsns,
  memBytes: simResult.memBytes,
  footprint: simResult.footprint,
  error: simResult.error,
});

// Or use inline simulation on supported methods
const result = await client.createInvoice({ 
  ...params, 
  simulate: true 
});
```

### 3.2 Transaction Debugger

For testnet failures, inspect transaction details:

```typescript
import { getTxDebug, formatTxDebug } from "@stellar-split/sdk/testing";

// After a transaction fails
try {
  const result = await client.pay({ invoiceId, amount, payer });
} catch (err) {
  if (err.context?.txHash) {
    const txDebug = await getTxDebug(
      "https://soroban-testnet.stellar.org",
      err.context.txHash
    );
    console.log(formatTxDebug(txDebug));
  }
}
```

### 3.3 Profiler Session

Track performance and generate flame graphs:

```typescript
import { ProfilerSession } from "@stellar-split/sdk";

const profiler = new ProfilerSession({ 
  name: "payment-flow-debug" 
});

profiler.start();

// Your SDK operations
await client.createInvoice(params);
await client.pay({ invoiceId, amount, payer });

profiler.stop();

// Export for speedscope.app
profiler.exportJSON("./profile.json");

// Or get the report
const report = profiler.report();
console.log(report);
```

Upload the JSON file to [speedscope.app](https://www.speedscope.app) to visualize where time is spent.

### 3.4 MockStellarSplitClient

Test your integration without network calls:

```typescript
import { MockStellarSplitClient } from "@stellar-split/sdk/mock";

const mockClient = new MockStellarSplitClient();

// Inject custom behavior
mockClient.whenCalled("createInvoice").thenReturn({
  invoiceId: 1n,
  txHash: "mock-hash",
});

// Track calls
const { invoiceId } = await mockClient.createInvoice(params);
const calls = mockClient.getCallHistory();
console.log(calls); // [{ method: "createInvoice", args: [...], timestamp: ... }]
```

### 3.5 Multi-Tenant Client Debugger

Track client pool health:

```typescript
import { MultiTenantClient } from "@stellar-split/sdk";

const pool = new MultiTenantClient((tenantId) => ({
  rpcUrl: `https://rpc.${tenantId}.example.com`,
  // ...
}), {
  maxClients: 10,
  ttlMs: 300_000,
  healthCheckIntervalMs: 60_000,
});

// Get statistics
const stats = pool.stats();
console.log({
  size: stats.size,           // Current pool size
  hits: stats.hits,           // Cache hits
  misses: stats.misses,       // Cache misses
  evictions: stats.evictions, // LRU/TTL evictions
});
```

### 3.6 Invoice Subscription Debugger

Debug real-time event streams:

```typescript
const subscription = client.subscribeInvoice(invoiceId, (event) => {
  console.log("Event received:", {
    type: event.type,
    invoiceId: event.invoiceId,
    timestamp: new Date(),
    data: event,
  });
});

// Listen to lifecycle events
subscription.on("error", (error) => {
  console.error("Subscription error:", error);
});

subscription.on("reconnect", (attempt) => {
  console.log("Reconnecting, attempt:", attempt);
});
```

---

## 4. Common Debugging Techniques

### 4.1 Isolating the Problem

**Step 1: Narrow down the scope**

```typescript
// Can you get invoice data?
const invoice = await client.getInvoice(invoiceId);
console.log("Invoice retrieved:", invoice.id);

// Can you simulate the operation?
const sim = await client.simulate("pay", { invoiceId, amount, payer });
console.log("Simulation result:", sim.success);

// Can you sign with your wallet?
const pubKey = await client.wallet?.getPublicKey();
console.log("Wallet connected:", pubKey);
```

**Step 2: Enable logging and retry**

```typescript
client.logger.level = LogLevel.TRACE;
// Retry the operation
```

**Step 3: Check environment**

```typescript
console.log({
  network: client.networkPassphrase,
  rpcUrl: client.rpcUrl,
  contractId: client.contractId,
});
```

### 4.2 Binary Search Debugging

For complex multi-step workflows:

```typescript
async function debugPaymentFlow() {
  console.log("1. Fetching invoice...");
  const invoice = await client.getInvoice(invoiceId);
  console.log("✓ Invoice fetched");

  console.log("2. Validating amount...");
  const remaining = invoice.totalOwed - invoice.funded;
  console.log("✓ Remaining:", remaining);

  console.log("3. Simulating payment...");
  const sim = await client.simulate("pay", { invoiceId, amount, payer });
  console.log("✓ Simulation:", sim.success ? "SUCCESS" : "FAILED");

  if (!sim.success) {
    console.error("Simulation failed:", sim.error);
    return;
  }

  console.log("4. Submitting transaction...");
  const result = await client.pay({ invoiceId, amount, payer });
  console.log("✓ Payment submitted:", result.txHash);
}
```

### 4.3 Differential Debugging

Compare working vs failing scenarios:

```typescript
// Working case
const workingParams = {
  invoiceId: 1n,
  amount: 1_000_000n,
  payer: "GABC...",
};

// Failing case
const failingParams = {
  invoiceId: 2n,
  amount: 1_000_000n,
  payer: "GDEF...",
};

// Compare simulation results
const simWorking = await client.simulate("pay", workingParams);
const simFailing = await client.simulate("pay", failingParams);

console.log("Working simulation:", simWorking);
console.log("Failing simulation:", simFailing);
```

### 4.4 State Inspection

```typescript
// Inspect invoice state
const invoice = await client.getInvoice(invoiceId);
console.log({
  status: invoice.status,
  funded: invoice.funded,
  totalOwed: invoice.recipients.reduce((sum, r) => sum + r.amount, 0n),
  deadline: new Date(Number(invoice.deadline) * 1000),
  frozen: invoice.frozen,
});

// Inspect payments
const payments = await client.getPayments(invoiceId);
console.log("Payment history:", payments.map(p => ({
  payer: p.payer,
  amount: p.amount,
  timestamp: p.timestamp,
})));
```

---

## 5. Transaction Debugging

### 5.1 Pre-flight Checks

```typescript
import { isValidStellarAddress, isDeadlineValid } from "@stellar-split/sdk";

// Validate addresses
if (!isValidStellarAddress(creator)) {
  console.error("Invalid creator address");
}

// Validate deadline
const deadline = deadlineFromDays(7);
if (!isDeadlineValid(deadline)) {
  console.error("Deadline must be at least 1 hour in the future");
}

// Validate amounts
const amount = parseAmount("100");
if (amount <= 0n) {
  console.error("Amount must be positive");
}
```

### 5.2 Simulation Analysis

```typescript
const result = await client.simulate("createInvoice", params);

if (!result.success) {
  console.error("Simulation failed:");
  console.error("  Error:", result.error);
  console.error("  Raw:", result.raw);
  
  // Check for common issues
  if (result.error?.includes("unauthorized")) {
    console.error("  → Check signer permissions");
  }
  if (result.error?.includes("insufficient")) {
    console.error("  → Check account balance");
  }
}

// Analyze resource usage
console.log("Resources:", {
  fee: `${result.fee} stroops`,
  cpuInsns: result.cpuInsns,
  memBytes: result.memBytes,
  readEntries: result.footprint?.readLedgerEntries,
  writeEntries: result.footprint?.writeLedgerEntries,
});
```

### 5.3 Footprint Analysis

```typescript
import { optimizeFootprint, footprintDiff } from "@stellar-split/sdk";

// Before optimization
const originalTx = /* your transaction */;
const sim = await client.rpc.simulateTransaction(originalTx);

// Optimize
const optimizedTx = optimizeFootprint(originalTx, sim);

// Compare
const diff = footprintDiff(
  originalTx.operations[0].source,
  optimizedTx.operations[0].source
);

console.log("Footprint optimization:", {
  removed: diff.removed.length,
  added: diff.added.length,
  unchanged: diff.unchanged.length,
});
```

### 5.4 Transaction Timeline

```typescript
// Track transaction from submission to confirmation
console.log("1. Building transaction...");
const startTime = Date.now();

try {
  console.log("2. Simulating...");
  const sim = await client.simulate("pay", params);
  console.log(`   Simulation took ${Date.now() - startTime}ms`);

  console.log("3. Signing...");
  const signStart = Date.now();
  // Transaction signing happens internally
  
  console.log("4. Submitting...");
  const submitStart = Date.now();
  const result = await client.pay(params);
  console.log(`   Submission took ${Date.now() - submitStart}ms`);

  console.log("5. Confirming...");
  // Wait for confirmation
  const tx = await client.rpc.getTransaction(result.txHash);
  console.log(`   Total time: ${Date.now() - startTime}ms`);
  console.log(`   Status: ${tx.status}`);
} catch (err) {
  console.error(`Failed after ${Date.now() - startTime}ms:`, err);
}
```

---

## 6. Network & RPC Debugging

### 6.1 RPC Endpoint Health

```typescript
// Test RPC connectivity
async function testRpcHealth(rpcUrl: string) {
  const start = Date.now();
  try {
    const server = new SorobanRpc.Server(rpcUrl);
    const health = await server.getHealth();
    console.log(`✓ RPC healthy (${Date.now() - start}ms):`, health);
  } catch (err) {
    console.error(`✗ RPC unhealthy (${Date.now() - start}ms):`, err);
  }
}

await testRpcHealth("https://soroban-testnet.stellar.org");
```

### 6.2 Load Balancer Debugging

```typescript
import { RpcLoadBalancer } from "@stellar-split/sdk";

const balancer = new RpcLoadBalancer({
  endpoints: [
    { url: "https://rpc1.example.com", weight: 2 },
    { url: "https://rpc2.example.com", weight: 1 },
  ],
});

// Listen to health events
balancer.on("endpoint:unhealthy", ({ url }) => {
  console.warn(`Endpoint unhealthy: ${url}`);
});

balancer.on("endpoint:recovered", ({ url }) => {
  console.log(`Endpoint recovered: ${url}`);
});

// Get statistics
const stats = balancer.getStats();
console.log({
  totalRequests: stats.total,
  byEndpoint: stats.byEndpoint,
  failureRate: stats.failures / stats.total,
});
```

### 6.3 Circuit Breaker Debugging

```typescript
// Listen to circuit breaker events
client.on("circuit:open", () => {
  console.error("Circuit breaker opened - RPC is failing");
});

client.on("circuit:half-open", () => {
  console.warn("Circuit breaker probing - testing RPC recovery");
});

client.on("circuit:close", () => {
  console.log("Circuit breaker closed - RPC recovered");
});

// Manually reset if needed
client.resetCircuitBreaker();
```

### 6.4 Retry Debugging

```typescript
import { isRetryable } from "@stellar-split/sdk";

try {
  await client.pay(params);
} catch (err) {
  if (isRetryable(err)) {
    console.log("Retryable error detected:", err.code);
    
    if (err instanceof PaymentCooldownActiveError) {
      const waitMs = err.retryAfter.getTime() - Date.now();
      console.log(`Retry after ${waitMs}ms`);
      
      setTimeout(async () => {
        try {
          await client.pay(params);
        } catch (retryErr) {
          console.error("Retry failed:", retryErr);
        }
      }, waitMs);
    }
  } else {
    console.error("Non-retryable error:", err.code);
    // Don't retry
  }
}
```

---

## 7. Integration Test Debugging

### 7.1 Test Isolation

```typescript
import { describe, it, beforeEach, afterEach, vi } from 'vitest';

describe('Payment flow', () => {
  let client: StellarSplitClient;

  beforeEach(() => {
    // Fresh client for each test
    client = new StellarSplitClient({ /* ... */ });
  });

  afterEach(() => {
    // Clean up
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('should process payment', async () => {
    // Test in isolation
  });
});
```

### 7.2 Debugging Testnet Tests

```typescript
import { 
  getTxDebug, 
  formatTxDebug,
  TESTNET_RPC,
} from "@stellar-split/sdk/testing";

// Set up environment
process.env.STELLAR_NETWORK = "testnet";
process.env.STELLAR_SPLIT_CONTRACT_ID = "CABC...";

// In your test
it('should create invoice on testnet', async () => {
  try {
    const result = await client.createInvoice(params);
    console.log("Transaction hash:", result.txHash);
  } catch (err) {
    // Debug the failure
    if (err.context?.txHash) {
      const txDebug = await getTxDebug(TESTNET_RPC, err.context.txHash);
      console.error(formatTxDebug(txDebug));
    }
    throw err;
  }
});
```

### 7.3 Selective Test Execution

```bash
# Run one file
npx vitest run test/client.test.ts

# Run tests matching pattern
npx vitest run -t "payment"

# Run with --reporter=verbose for detailed output
npx vitest run --reporter=verbose

# Run only focused tests (use it.only in code)
npx vitest run

# Watch mode for iterative debugging
npx vitest watch test/client.test.ts
```

### 7.4 Mock Debugging

```typescript
import { vi } from 'vitest';

// Track mock calls
const mockPay = vi.fn().mockResolvedValue({ txHash: "mock" });
client.pay = mockPay;

await client.pay({ invoiceId, amount, payer });

// Inspect calls
console.log("Mock called:", mockPay.mock.calls.length);
console.log("Call arguments:", mockPay.mock.calls[0]);
console.log("Results:", mockPay.mock.results);

// Assert specific calls
expect(mockPay).toHaveBeenCalledWith({ invoiceId, amount, payer });
expect(mockPay).toHaveBeenCalledTimes(1);
```

---

## 8. Error Investigation

### 8.1 Error Code Lookup

```typescript
import { getErrorByCode } from "@stellar-split/sdk";

// Look up error information
const errorInfo = getErrorByCode("INVOICE_NOT_FOUND");
console.log({
  message: errorInfo?.message,
  retryable: errorInfo?.retryable,
  recovery: errorInfo?.recovery,
});
```

### 8.2 Error Context Analysis

```typescript
try {
  await client.pay(params);
} catch (err) {
  if (err instanceof StellarSplitError) {
    console.error("Error details:", {
      code: err.code,
      message: err.message,
      context: err.context,
      raw: err.raw,
      stack: err.stack,
    });

    // Check specific context fields
    if (err.context?.invoiceId) {
      console.log("Failed invoice:", err.context.invoiceId);
    }
    if (err.context?.retryAfter) {
      console.log("Retry after:", err.context.retryAfter);
    }
  }
}
```

### 8.3 Error Classification

```typescript
import { 
  isRetryable,
  InvoiceNotFoundError,
  RpcError,
  ValidationError,
} from "@stellar-split/sdk";

try {
  await client.pay(params);
} catch (err) {
  // Classify error type
  if (err instanceof ValidationError) {
    console.error("Invalid input:", err.message);
    // Fix input and retry
  } else if (err instanceof InvoiceNotFoundError) {
    console.error("Invoice does not exist:", err.invoiceId);
    // Don't retry
  } else if (err instanceof RpcError) {
    console.error("Network issue:", err.message);
    if (isRetryable(err)) {
      // Retry with backoff
    }
  } else {
    console.error("Unexpected error:", err);
  }
}
```

### 8.4 Error Recovery Patterns

```typescript
async function payWithRecovery(
  client: StellarSplitClient,
  params: PaymentParams
) {
  try {
    return await client.pay(params);
  } catch (err) {
    // Pattern 1: Automatic retry for transient errors
    if (isRetryable(err)) {
      console.log("Retrying after transient error...");
      await new Promise(resolve => setTimeout(resolve, 2000));
      return await client.pay(params);
    }

    // Pattern 2: Adjust and retry
    if (err instanceof PaymentExceedsRemainingError) {
      console.log("Adjusting amount to remaining balance...");
      const invoice = await client.getInvoice(params.invoiceId);
      const remaining = invoice.totalOwed - invoice.funded;
      return await client.pay({ ...params, amount: remaining });
    }

    // Pattern 3: Fallback action
    if (err instanceof DeadlinePassedError) {
      console.log("Invoice expired, cloning...");
      const newId = await client.cloneInvoice(params.invoiceId);
      return await client.pay({ ...params, invoiceId: newId });
    }

    throw err; // No recovery possible
  }
}
```

---

## 9. Performance Debugging

### 9.1 Profiling SDK Operations

```typescript
import { ProfilerSession } from "@stellar-split/sdk";

const profiler = new ProfilerSession({ name: "performance-test" });
profiler.start();

// Measure operation performance
const startCreate = performance.now();
await client.createInvoice(params);
console.log(`createInvoice: ${performance.now() - startCreate}ms`);

const startPay = performance.now();
await client.pay({ invoiceId, amount, payer });
console.log(`pay: ${performance.now() - startPay}ms`);

profiler.stop();
profiler.exportJSON("./perf-profile.json");
```

### 9.2 Identifying Bottlenecks

```typescript
// Enable detailed logging
client.logger.level = LogLevel.TRACE;

// Track RPC call durations
let rpcCallCount = 0;
const originalFetch = global.fetch;
global.fetch = async (...args) => {
  const start = Date.now();
  const result = await originalFetch(...args);
  console.log(`RPC call ${++rpcCallCount}: ${Date.now() - start}ms`);
  return result;
};

// Your operations
await client.pay(params);

// Restore
global.fetch = originalFetch;
```

### 9.3 Batch Operation Analysis

```typescript
import { aggregatePayments } from "@stellar-split/sdk";

// Compare individual vs batched
console.time("individual-payments");
for (const id of invoiceIds) {
  await client.pay({ invoiceId: id, amount: 1_000_000n, payer });
}
console.timeEnd("individual-payments");

// vs batched allocation
console.time("batched-allocation");
const allocations = await aggregatePayments(
  10_000_000n,
  invoiceIds,
  "proportional",
  { fetchRemaining: createInvoiceRemainingFetcher(client) }
);

for (const { invoiceId, amount } of allocations) {
  await client.pay({ invoiceId, amount, payer });
}
console.timeEnd("batched-allocation");
```

### 9.4 Cache Performance

```typescript
// Enable cache with debugging
const client = new StellarSplitClient({
  rpcUrl: "...",
  cache: {
    enabled: true,
    ttl: 60_000,
    maxSize: 100,
  },
});

// Track cache hits/misses
let cacheHits = 0;
let cacheMisses = 0;

const originalGet = client.getInvoice.bind(client);
client.getInvoice = async (id) => {
  const start = Date.now();
  const result = await originalGet(id);
  const duration = Date.now() - start;
  
  if (duration < 10) {
    cacheHits++;
    console.log(`Cache HIT for invoice ${id} (${duration}ms)`);
  } else {
    cacheMisses++;
    console.log(`Cache MISS for invoice ${id} (${duration}ms)`);
  }
  
  return result;
};

// Test cache
await client.getInvoice(1n);
await client.getInvoice(1n); // Should be cached

console.log(`Hit rate: ${(cacheHits / (cacheHits + cacheMisses) * 100).toFixed(1)}%`);
```

---

## 10. Troubleshooting Guide

### Problem: "RPC_UNAVAILABLE" or connection errors

**Symptoms:**
- `RpcUnavailableError` or `RpcConnectionError`
- Timeouts on all operations
- Circuit breaker opens immediately

**Diagnosis:**
```typescript
// 1. Test RPC endpoint directly
const response = await fetch("https://soroban-testnet.stellar.org/health");
console.log("RPC health:", await response.json());

// 2. Check network configuration
console.log({
  rpcUrl: client.rpcUrl,
  networkPassphrase: client.networkPassphrase,
});

// 3. Try alternative endpoint
const altClient = new StellarSplitClient({
  rpcUrl: "https://soroban-rpc.stellar.org",
  // ...
});
```

**Solutions:**
- Use multiple RPC endpoints with load balancing
- Increase timeout configuration
- Check firewall/proxy settings
- Verify RPC endpoint is for the correct network (testnet vs mainnet)

---

### Problem: "SIMULATION_FAILED" errors

**Symptoms:**
- Simulation returns `success: false`
- Error message in `sim.error`
- Contract panic in `sim.raw`

**Diagnosis:**
```typescript
const sim = await client.simulate("pay", params);
console.log({
  success: sim.success,
  error: sim.error,
  raw: sim.raw,
  events: sim.events,
});

// Check specific failure types
if (sim.error?.includes("insufficient")) {
  console.log("→ Likely balance issue");
}
if (sim.error?.includes("unauthorized")) {
  console.log("→ Likely permission issue");
}
```

**Solutions:**
- Verify signer has proper authorization
- Check account has sufficient balance
- Validate all parameters (addresses, amounts, deadlines)
- Ensure invoice is in correct state for the operation

---

### Problem: Transactions not confirming

**Symptoms:**
- `TransactionNotConfirmedError`
- Transaction appears submitted but status unknown
- Long delays before timeout

**Diagnosis:**
```typescript
// Check transaction status
const tx = await client.rpc.getTransaction(txHash);
console.log({
  status: tx.status,
  ledger: tx.ledger,
  createdAt: tx.createdAt,
});

// Check network congestion
const latestLedger = await client.rpc.getLatestLedger();
console.log("Latest ledger:", latestLedger);
```

**Solutions:**
- Increase finality timeout
- Check network status (testnet occasionally resets)
- Verify transaction wasn't dropped due to insufficient fee
- Retry with higher fee if needed

---

### Problem: "INVOICE_NOT_FOUND" for newly created invoice

**Symptoms:**
- Create invoice succeeds
- Immediate query fails with `InvoiceNotFoundError`
- Works after a delay

**Diagnosis:**
```typescript
const { invoiceId, txHash } = await client.createInvoice(params);
console.log("Created:", invoiceId, txHash);

// Wait for ledger to close
await new Promise(resolve => setTimeout(resolve, 5000));

const invoice = await client.getInvoice(invoiceId);
console.log("Retrieved:", invoice.id);
```

**Solutions:**
- Disable cache: `cache: { enabled: false }`
- Add delay after creation before querying
- Use the invoice data returned from `createInvoice` directly
- Check if transaction actually confirmed

---

### Problem: Wallet not connecting

**Symptoms:**
- `WalletNotConnectedError`
- `connectWallet()` times out
- No wallet popup appears

**Diagnosis:**
```typescript
// Check if wallet extension is installed
if (typeof window.freighter === "undefined") {
  console.error("Freighter wallet not installed");
}

// Test wallet connection manually
const isAvailable = await window.freighter.isConnected();
console.log("Wallet available:", isAvailable);

// Check permissions
const publicKey = await window.freighter.getPublicKey();
console.log("Has permission:", !!publicKey);
```

**Solutions:**
- Ensure Freighter extension is installed
- Request user approval in extension
- Use custom wallet adapter for testing
- Check browser console for wallet errors

---

### Problem: Payment cooldown preventing transactions

**Symptoms:**
- `PaymentCooldownActiveError`
- Recent payment succeeded but new one blocked
- Error includes `retryAfter` timestamp

**Diagnosis:**
```typescript
try {
  await client.pay(params);
} catch (err) {
  if (err instanceof PaymentCooldownActiveError) {
    const waitSeconds = Math.ceil(
      (err.retryAfter.getTime() - Date.now()) / 1000
    );
    console.log(`Cooldown active, retry in ${waitSeconds}s`);
    console.log(`Retry at: ${err.retryAfter.toISOString()}`);
  }
}
```

**Solutions:**
- Wait for cooldown period (this is a rate-limiting feature)
- Schedule retry automatically using `retryAfter`
- Use different payer address if urgent
- Contact invoice creator to adjust cooldown settings

---

### Problem: High memory usage with subscriptions

**Symptoms:**
- Memory grows over time
- Many active subscriptions
- Performance degrades

**Diagnosis:**
```typescript
// Track active subscriptions
const subscriptions: Subscription[] = [];

const sub = client.subscribeInvoice(invoiceId, handler);
subscriptions.push(sub);

console.log("Active subscriptions:", subscriptions.length);

// Check if old subscriptions are cleaned up
setInterval(() => {
  console.log("Active:", subscriptions.filter(s => s.active).length);
}, 10_000);
```

**Solutions:**
- Unsubscribe when no longer needed: `subscription.unsubscribe()`
- Limit concurrent subscriptions
- Use event batching/debouncing
- Increase `pollIntervalMs` to reduce frequency

---

### Problem: Validation errors with correct-looking data

**Symptoms:**
- `ValidationError` thrown
- Parameters appear valid
- Error message unclear

**Diagnosis:**
```typescript
// Enable validation debugging
try {
  await client.createInvoice(params);
} catch (err) {
  if (err instanceof ValidationError) {
    console.log("Validation error details:", {
      code: err.code,
      context: err.context,
      field: err.context?.field,
      value: err.context?.value,
      constraint: err.context?.constraint,
    });
  }
}
```

**Solutions:**
- Use SDK helper functions: `parseAmount()`, `deadlineFromDays()`
- Validate addresses: `isValidStellarAddress(addr)`
- Check amount is positive BigInt
- Ensure deadline is at least 1 hour in the future
- Verify recipient array is not empty

---

## 11. FAQ

### Q: How do I enable debug logging without flooding the console?

**A:** Use the `filter` option to selectively log components:

```typescript
const logger = new SdkLogger({
  level: LogLevel.DEBUG,
  filter: (entry) => {
    // Only log errors and RPC calls
    return entry.level === LogLevel.ERROR || 
           entry.context?.component === "rpc";
  },
});
```

### Q: Why is my simulation succeeding but actual transaction failing?

**A:** Common causes:
1. **State changed between simulation and submission** - another transaction modified the invoice
2. **Network mismatch** - simulating on testnet but submitting to mainnet
3. **Insufficient fee** - actual fee required is higher than simulated
4. **Authorization expired** - auth entries have a TTL

**Solution:**
```typescript
// Simulate immediately before submit
const sim = await client.simulate("pay", params);
if (sim.success) {
  // Submit right away
  await client.pay(params);
}
```

### Q: How can I test without deploying to testnet?

**A:** Use `MockStellarSplitClient`:

```typescript
import { MockStellarSplitClient } from "@stellar-split/sdk/mock";

const client = new MockStellarSplitClient();

// All operations work without network calls
const { invoiceId } = await client.createInvoice(params);
const invoice = await client.getInvoice(invoiceId);
```

### Q: What's the best way to debug flaky tests?

**A:**
1. **Isolate tests** - use fresh client per test in `beforeEach`
2. **Restore mocks** - `vi.restoreAllMocks()` in `afterEach`
3. **Use fake timers carefully** - `vi.useRealTimers()` after each test
4. **Run multiple times** - `npx vitest run --repeat=10`
5. **Check for race conditions** - add deterministic waits

### Q: How do I debug webhook delivery failures?

**A:**
```typescript
import { createWebhookMiddleware } from "@stellar-split/sdk";

const middleware = createWebhookMiddleware(secret, {
  toleranceSeconds: 300,
  nonceWindowSize: 1000,
});

// Log all webhook attempts
middleware.emitter.on("*", ({ event, data, request }) => {
  console.log("Webhook received:", {
    event,
    invoiceId: data.invoiceId,
    timestamp: request.headers["x-webhook-timestamp"],
    signature: request.headers["x-webhook-signature"],
  });
});

// Log errors
app.use((err, req, res, next) => {
  if (req.path.includes("/webhooks")) {
    console.error("Webhook error:", err);
  }
  next(err);
});
```

### Q: Why are my RPC requests so slow?

**A:** Common causes:
1. **Network latency** - Use geographically closer RPC endpoint
2. **Large footprint** - Use `optimizeFootprint()` before submission
3. **Cold cache** - First requests are slower, subsequent ones cached
4. **RPC endpoint overloaded** - Use multiple endpoints with load balancing

**Measure and optimize:**
```typescript
const profiler = new ProfilerSession({ name: "rpc-perf" });
profiler.start();

await client.getInvoice(invoiceId);

profiler.stop();
const report = profiler.report();

// Find slowest operations
const sorted = report.frames.sort((a, b) => b.duration - a.duration);
console.log("Slowest operations:", sorted.slice(0, 5));
```

### Q: How do I debug "out of gas" or resource limit errors?

**A:**
```typescript
// Analyze resource usage
const sim = await client.simulate("createInvoice", params);

console.log("Resource usage:", {
  cpuInsns: `${sim.cpuInsns} / 100M (${(sim.cpuInsns / 100_000_000 * 100).toFixed(1)}%)`,
  memBytes: `${sim.memBytes} / 40MB`,
  fee: `${sim.fee} stroops`,
});

// Check footprint size
console.log("Footprint:", {
  readBytes: sim.footprint?.readBytes,
  writeBytes: sim.footprint?.writeBytes,
  readEntries: sim.footprint?.readLedgerEntries,
  writeEntries: sim.footprint?.writeLedgerEntries,
});
```

**Solutions:**
- Optimize footprint with `optimizeFootprint()`
- Reduce number of recipients per invoice
- Split large operations into multiple transactions
- Increase fee budget if near limits

### Q: Can I debug in production without exposing sensitive data?

**A:** Yes, use filtered logging with redaction:

```typescript
const logger = new SdkLogger({
  level: LogLevel.INFO, // Only important events
  filter: (entry) => {
    // Don't log successful routine operations
    if (entry.level === LogLevel.INFO && 
        entry.context?.operation === "getInvoice") {
      return false;
    }
    return true;
  },
});

// Sensitive data is automatically redacted
// Keys, secrets, tokens never appear in logs
```

### Q: How do I correlate SDK logs with application logs?

**A:** Add request IDs:

```typescript
// In your application
async function processPayment(requestId: string) {
  console.log(`[${requestId}] Processing payment...`);
  
  try {
    const result = await client.pay({
      invoiceId,
      amount,
      payer,
      metadata: { requestId }, // Include in context
    });
    
    console.log(`[${requestId}] Payment succeeded: ${result.txHash}`);
  } catch (err) {
    console.error(`[${requestId}] Payment failed:`, err);
  }
}
```

### Q: What tools exist for load testing the SDK?

**A:** Use the built-in load test script:

```bash
npm run load-test -- --duration=60 --concurrency=10

# With baseline comparison
npm run load-test -- --update-baseline
```

Or create custom tests:
```typescript
import { ProfilerSession } from "@stellar-split/sdk";

async function loadTest() {
  const profiler = new ProfilerSession({ name: "load-test" });
  profiler.start();

  const promises = Array.from({ length: 100 }, async (_, i) => {
    return await client.getInvoice(BigInt(i + 1));
  });

  await Promise.all(promises);
  
  profiler.stop();
  profiler.exportJSON("./load-test-profile.json");
}
```

---

## Additional Resources

- **[Error Codes Reference](./ERROR_CODES.md)** - Complete error code catalog with recovery strategies
- **[Debug Logging](../DEBUG_LOGGING.md)** - Detailed logging configuration
- **[Integration Testing](./INTEGRATION_TESTING.md)** - Testing best practices
- **[Performance Tuning](./PERFORMANCE_TUNING.md)** - Optimization techniques
- **[API Documentation](https://stellar-split.github.io/split-sdk/)** - Full API reference

---

## Contributing

Found a debugging technique that helped you? Please contribute to this guide!

See [CONTRIBUTING.md](../CONTRIBUTING.md) for guidelines.

---

**Last Updated:** November 2026  
**SDK Version:** 0.1.0+
