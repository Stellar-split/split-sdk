# SDK Tutorials

This guide provides step-by-step tutorials for integrating with the StellarSplit SDK.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Creating Your First Invoice](#creating-your-first-invoice)
3. [Paying Toward an Invoice](#paying-toward-an-invoice)
4. [Webhook Integration](#webhook-integration)
5. [Multi-Signature Wallets](#multi-signature-wallets)
6. [Error Handling](#error-handling)
7. [Performance Profiling](#performance-profiling)
8. [Lazy Evaluation](#lazy-evaluation)
9. [Production Checklist](#production-checklist)

---

## Getting Started

### Installation

```bash
npm install @stellar-split/sdk
```

### Prerequisites

- Node.js 18+
- A Stellar wallet (Freighter, Albedo, or any Soroban-compatible wallet)
- Testnet or mainnet USDC token contract address
- Soroban RPC URL (e.g., `https://soroban-testnet.stellar.org`)

### Initialize the SDK

```typescript
import { StellarSplitClient } from "@stellar-split/sdk";

const client = new StellarSplitClient({
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "YOUR_DEPLOYED_CONTRACT_ID",
});
```

---

## Creating Your First Invoice

### Step 1: Connect Wallet

```typescript
import { connectWallet } from "@stellar-split/sdk";

const publicKey = await connectWallet();
```

### Step 2: Create Invoice

```typescript
import { deadlineFromDays, parseAmount } from "@stellar-split/sdk";

const { invoiceId, txHash } = await client.createInvoice({
  creator: publicKey,
  recipients: [
    { address: "GABC...RECIPIENT1", amount: parseAmount("60") },
    { address: "GDEF...RECIPIENT2", amount: parseAmount("40") },
  ],
  token: "USDC_CONTRACT_ADDRESS",
  deadline: deadlineFromDays(7),
});

console.log(`Invoice #${invoiceId} created: ${txHash}`);
```

---

## Paying Toward an Invoice

### Step 1: Connect Wallet (Payer)

```typescript
const payerKey = await connectWallet();
```

### Step 2: Make Payment

```typescript
const { paymentId, txHash } = await client.pay({
  payer: payerKey,
  invoiceId,
  amount: parseAmount("25"),
});

console.log(`Payment #${paymentId} sent: ${txHash}`);
```

---

## Webhook Integration

### Step 1: Create Webhook Endpoint

```typescript
import express from "express";
import { createWebhookMiddleware } from "@stellar-split/sdk";

const app = express();

app.use("/webhooks/stellarsplit", express.raw({ type: "application/json" }));

app.post(
  "/webhooks/stellarsplit",
  createWebhookMiddleware(process.env.WEBHOOK_SECRET!),
  (req, res) => {
    const { event, data } = req.webhookPayload;
    res.status(200).json({ received: true });
  }
);

app.listen(3000, () => console.log("Webhook server listening on port 3000"));
```

---

## Multi-Signature Wallets

### Step 1: Configure Multi-Sig

```typescript
await client.configureMultiSig({
  contractId: "YOUR_CONTRACT_ID",
  signers: ["GAAA...", "GBBB...", "GCCC..."],
  threshold: 2,
  operations: ["create_invoice", "pay", "refund"],
});
```

### Step 2: Create Multi-Sig Payment Proposal

```typescript
const proposal = await client.proposeMultiSigPayment({
  invoiceId,
  amount: parseAmount("50"),
  signers: ["GAAA...", "GBBB..."],
});
```

### Step 3: Collect Signatures

```typescript
await client.signMultiSigProposal({
  proposalId: proposal.proposalId,
  signer: "GAAA...",
});

await client.signMultiSigProposal({
  proposalId: proposal.proposalId,
  signer: "GBBB...",
});
```

### Step 4: Execute Payment

```typescript
await client.executeMultiSigPayment({
  proposalId: proposal.proposalId,
});
```

---

## Error Handling

```typescript
import {
  StellarSplitError,
  InvoiceNotFoundError,
  InsufficientBalanceError,
  UnauthorizedError,
} from "@stellar-split/sdk";

try {
  await client.pay({ payer, invoiceId, amount: parseAmount("1000") });
} catch (err) {
  if (err instanceof InvoiceNotFoundError) {
    console.error("Invoice does not exist");
  } else if (err instanceof InsufficientBalanceError) {
    console.error("Insufficient balance for payment");
  } else if (err instanceof UnauthorizedError) {
    console.error("Not authorized to perform this action");
  } else if (err instanceof StellarSplitError) {
    console.error(`SDK error (${err.code}): ${err.message}`);
  } else {
    console.error("Unexpected error:", err);
  }
}
```

### Common Error Codes

| Code | Description |
|------|-------------|
| `INVOICE_NOT_FOUND` | Invoice ID does not exist |
| `INSUFFICIENT_BALANCE` | Payer doesn't have enough funds |
| `UNAUTHORIZED` | Caller not authorized for operation |
| `INVOICE_COMPLETED` | Invoice already fully paid |
| `INVOICE_EXPIRED` | Invoice deadline has passed |
| `INVALID_AMOUNT` | Amount is zero or negative |
| `INVALID_ADDRESS` | Invalid Stellar address format |

---

## Performance Profiling

This section explains how to measure, benchmark, and optimize the performance of your StellarSplit SDK integration. Profiling helps you find slow RPC calls, redundant network requests, and expensive transaction-building work before they reach production.

### Profiling Tools

| Tool | Purpose | When to use |
|------|---------|-------------|
| `performance.now()` | High-resolution timing of individual SDK calls | Quick, dependency-free measurements |
| Node.js `perf_hooks` | Programmatic timing and histograms | Server-side scripts and CI benchmarks |
| Node.js `--cpu-prof` | CPU profile of a running process | Finding hot functions in long-running services |
| Chrome DevTools (Performance tab) | Flame charts and network waterfall | Browser-based wallet flows |
| `console.time` / `console.timeEnd` | Simple labeled timers | Ad-hoc debugging |
| `@stellar-split/sdk` debug logging | SDK-level request/response tracing | Diagnosing RPC latency |

Enable SDK debug logging to trace RPC calls:

```typescript
const client = new StellarSplitClient({
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "YOUR_DEPLOYED_CONTRACT_ID",
  debug: true, // logs RPC requests, retries, and timings
});
```

### Profiling Examples

#### Timing a single SDK call

```typescript
import { performance } from "node:perf_hooks";

const start = performance.now();
const invoice = await client.getInvoice({ invoiceId });
const elapsed = performance.now() - start;

console.log(`getInvoice took ${elapsed.toFixed(2)}ms`);
```

#### Wrapping the client with a timing proxy

```typescript
function withTiming<T extends object>(target: T): T {
  return new Proxy(target, {
    get(obj, prop, receiver) {
      const value = Reflect.get(obj, prop, receiver);
      if (typeof value !== "function") return value;
      return async (...args: unknown[]) => {
        const start = performance.now();
        try {
          return await value.apply(obj, args);
        } finally {
          console.log(`${String(prop)} took ${(performance.now() - start).toFixed(2)}ms`);
        }
      };
    },
  });
}

const profiledClient = withTiming(client);
await profiledClient.pay({ payer, invoiceId, amount: parseAmount("25") });
```

#### Capturing a CPU profile

```bash
node --cpu-prof --cpu-prof-dir=./profiles ./scripts/benchmark.js
```

Open the generated `.cpuprofile` in Chrome DevTools (Performance → Load profile) to inspect the flame chart.

### Benchmarking Guide

Benchmarks should be repeatable and run against a stable environment (testnet, warm connection).

```typescript
import { performance } from "node:perf_hooks";

async function benchmark(label: string, fn: () => Promise<unknown>, iterations = 20) {
  // Warm-up run to avoid cold-start skew
  await fn();

  const samples: number[] = [];
  for (let i = 0; i < iterations; i++) {
    const start = performance.now();
    await fn();
    samples.push(performance.now() - start);
  }

  samples.sort((a, b) => a - b);
  const avg = samples.reduce((s, v) => s + v, 0) / samples.length;
  const p95 = samples[Math.floor(samples.length * 0.95)];

  console.log(`${label}: avg=${avg.toFixed(2)}ms p95=${p95.toFixed(2)}ms`);
}

await benchmark("getInvoice", () => client.getInvoice({ invoiceId }));
```

### Optimization Tips

- **Batch reads** — fetch multiple invoices in one RPC round-trip where the SDK supports it.
- **Cache immutable data** — invoice metadata that cannot change (creator, token) can be cached client-side.
- **Reuse the client** — construct `StellarSplitClient` once and share it; connection setup is expensive.
- **Defer expensive work** — use [lazy evaluation](#lazy-evaluation) to avoid computing values you never read.
- **Avoid redundant requests** — deduplicate concurrent identical calls (see below).

---

## Lazy Evaluation

The SDK ships a small lazy-value primitive for deferring expensive computation until a result is actually needed. A lazy value wraps a thunk (a zero-argument function) and only runs it when you call `.force()`. The result is memoized, so repeated `.force()` calls return the cached value without recomputing.

### Creating a lazy value

```typescript
import { lazy } from "@stellar-split/sdk";

// Nothing runs yet — the thunk is deferred.
const total = lazy(() => {
  console.log("computing total");
  return recipients.reduce((sum, r) => sum + r.amount, 0n);
});

// Computation happens here, on first force.
const value = total.force(); // logs "computing total"

// Subsequent forces return the cached result — no recomputation.
const again = total.force(); // no log
console.log(value === again); // true
```

### Composition

Lazy values compose with `map` (transform the result) and `flatMap` (chain into another lazy value). Composition stays deferred: nothing is evaluated until the final `.force()`.

```typescript
import { lazy } from "@stellar-split/sdk";

const invoice = lazy(() => client.getInvoice({ invoiceId }));

// map: derive a value from the (eventually) computed invoice.
const remaining = invoice.map((inv) => inv.total - inv.paid);

// flatMap: chain into another lazy computation.
const summary = invoice.flatMap((inv) =>
  lazy(() => `${inv.id}: ${inv.paid}/${inv.total}`)
);

// Nothing above has run yet. Force once to evaluate the whole chain.
console.log(summary.force());
```

### Tracking lazy operations

Each lazy value records whether it has been evaluated, so you can inspect and debug deferred work:

```typescript
const deferred = lazy(() => expensiveComputation());

deferred.isEvaluated(); // false — not yet forced
deferred.force();
deferred.isEvaluated(); // true — result is cached
```

### When to use lazy values

- Deferring expensive pure computations (aggregations, formatting) until a value is read.
- Building pipelines of derived values that may never be consumed.
- Avoiding duplicate work by relying on memoization across repeated reads.

Lazy values are for **synchronous, pure** computations. For asynchronous work such as RPC calls, wrap the promise in a lazy value and `await` the forced result:

```typescript
const invoiceLazy = lazy(() => client.getInvoice({ invoiceId }));
const invoice = await invoiceLazy.force();
```

---

## Production Checklist

- [ ] Use mainnet RPC URL and correct network passphrase
- [ ] Store webhook secrets in environment variables, never in code
- [ ] Handle all documented error codes
- [ ] Profile critical paths before launch (see [Performance Profiling](#performance-profiling))
- [ ] Defer expensive work with [lazy evaluation](#lazy-evaluation) where appropriate
- [ ] Monitor RPC latency and error rates in production
- [ ] Test multi-sig flows end-to-end on testnet first
