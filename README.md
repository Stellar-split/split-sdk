<div align="center">
  <img src="https://raw.githubusercontent.com/Stellar-split/.github/main/assets/stellarsplit-mark.svg" alt="StellarSplit" width="80" />
  <h1>@stellar-split/sdk</h1>
</div>

![npm](https://img.shields.io/npm/v/@stellar-split/sdk)
![TypeScript](https://img.shields.io/badge/TypeScript-5-blue?logo=typescript)
![License](https://img.shields.io/badge/license-MIT-green)
![CI](https://github.com/stellar-split/split-sdk/actions/workflows/publish.yml/badge.svg)

TypeScript SDK for the **StellarSplit** on-chain invoice splitting dApp on Stellar Soroban.

## Install

```bash
npm install @stellar-split/sdk
```

## Quick Start

```typescript
import { StellarSplitClient, connectWallet, deadlineFromDays, parseAmount } from "@stellar-split/sdk";

// Connect Freighter wallet
const publicKey = await connectWallet();

// Initialise client
const client = new StellarSplitClient({
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "YOUR_CONTRACT_ID",
});

// Create an invoice splitting 100 USDC between two recipients
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

// Pay toward the invoice
await client.pay({
  payer: publicKey,
  invoiceId,
  amount: parseAmount("100"),
});

// Fetch invoice status
const invoice = await client.getInvoice(invoiceId);
console.log(invoice.status); // "Released"
```

### Webhook Receiver

```typescript
import express from 'express';
import { createWebhookMiddleware } from "@stellar-split/sdk";

const app = express();

// Use raw body parser for webhook route
app.use('/webhooks/stellarsplit', express.raw({ type: 'application/json' }));

// Secure webhook receiver with HMAC-SHA256 verification and replay protection
app.post(
  '/webhooks/stellarsplit',
  createWebhookMiddleware(process.env.WEBHOOK_SECRET!, {
    toleranceSeconds: 300,    // 5 minutes
    nonceWindowSize: 1000,    // Track 1000 recent nonces
  }),
  (req, res) => {
    const { event, data } = req.webhookPayload;
    
    switch (event) {
      case 'invoice.paid':
        console.log('Payment received:', data);
        break;
      case 'invoice.released':
        console.log('Funds released:', data);
        break;
    }
    
    res.status(200).json({ received: true });
  }
);
```

## API Reference

The full auto-generated API reference documentation is available here: [API Documentation](https://stellar-split.github.io/split-sdk/)

### `StellarSplitClient`

#### Constructor

```typescript
new StellarSplitClient(config: StellarSplitClientConfig)
```

| Field | Type | Description |
|-------|------|-------------|
| `rpcUrl` | `string` | Soroban RPC endpoint |
| `networkPassphrase` | `string` | Stellar network passphrase |
| `contractId` | `string` | Deployed contract ID |

#### Methods

| Method | Returns | Description |
|--------|---------|-------------|
| `createInvoice(params)` | `Promise<{ invoiceId, txHash }>` | Create a new invoice (`{ simulate: true }` returns a `SimulationResult`) |
| `pay(params)` | `Promise<{ txHash }>` | Pay toward an invoice (`{ simulate: true }` returns a `SimulationResult`) |
| `getInvoice(id)` | `Promise<Invoice>` | Fetch invoice by ID |
| `getPayments(id)` | `Promise<Payment[]>` | Fetch payments for an invoice |
| `cloneInvoice(sourceId, overrides?)` | `Promise<string>` | Clone an invoice with optional field overrides; returns the new invoice ID |
| `getLineage(invoiceId)` | `Promise<bigint[]>` | Ancestor chain (root → … → invoice) as bigint IDs |
| `subscribeInvoice(invoiceId, cb, options?)` | `Subscription` | Stream invoice events with dedup + auto-reconnect |
| `simulate(method, params)` | `Promise<SimulationResult>` | Dry-run any contract method via Soroban simulation RPC |

### Dry-Run Simulation

Simulate any mutating transaction against Soroban RPC to get fee and resource
estimates without consuming a sequence number. `createInvoice`, `pay`,
`releaseGroup` and `refundInvoice` accept a `{ simulate: true }` option; the
generic `simulate()` method works for any contract entry point (including
`release`, `approveRelease` and `cloneInvoice`).

```typescript
const result = await client.simulate("createInvoice", {
  creator: publicKey,
  recipients: [{ address: "GABC...", amount: parseAmount("100") }],
  token: "USDC_CONTRACT_ADDRESS",
  deadline: deadlineFromDays(7),
});

console.log(result.success, result.fee, result.cpuInsns, result.memBytes);
console.log(result.footprint); // { readBytes, writeBytes, readLedgerEntries, writeLedgerEntries }

// Or inline on a supported method:
const simulated = await client.createInvoice({ ...params, simulate: true });
if (simulated.success) console.log(`Estimated fee: ${simulated.fee}`);
```

### Cloning Invoices

```typescript
// Clone with optional field overrides (validated like createInvoice)
const newId = await client.cloneInvoice(42n, {
  title: "Rebalanced split",
  deadline: deadlineFromDays(14),
  targetAmount: parseAmount("250"),
  recipients: ["GABC...", "GDEF..."],
});

// Inspect the full ancestor chain (root first)
const lineage = await client.getLineage(newId); // [1n, 2n, 42n, newId]
```

### Real-Time Invoice Events

```typescript
const subscription = client.subscribeInvoice(42n, (event) => {
  console.log(event.type, event.invoiceId); // payment | released | refunded | ...
});

// Later — stop polling and release timers
subscription.unsubscribe();
```

Polling uses Soroban `getEvents` every `pollIntervalMs` (default 3000ms),
deduplicates by ledger sequence + topic hash, and reconnects with exponential
backoff (up to `maxRetries`, default 5) before emitting an `error` lifecycle
event.

### Resilience: Retries & Circuit Breaker

All RPC calls are wrapped with exponential backoff + jitter and a circuit
breaker that opens after N consecutive failures and auto-resets after a
cooldown. Non-retryable errors (invalid input, unauthorized) bypass retries.

```typescript
const client = new StellarSplitClient({
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "YOUR_CONTRACT_ID",
  circuitBreaker: {
    retry: { maxRetries: 5, baseDelayMs: 250, maxDelayMs: 10_000, jitter: true },
    breaker: { failureThreshold: 5, resetTimeoutMs: 30_000 },
  },
});

client.on("circuit:open", () => console.warn("RPC circuit opened"));
client.on("circuit:half-open", () => console.warn("RPC circuit probing"));
client.on("circuit:close", () => console.info("RPC circuit closed"));
```

### Wallet Helpers

| Function | Returns | Description |
|----------|---------|-------------|
| `connectWallet()` | `Promise<string>` | Connect Freighter, return public key |
| `getPublicKey()` | `Promise<string>` | Get connected wallet's public key |
| `signTransaction(xdr, network)` | `Promise<string>` | Sign a transaction XDR |

### Multi-Tenant Support

| Class | Description |
|-------|-------------|
| `MultiTenantClient` | Manage a pool of `StellarSplitClient` instances keyed by tenant ID, with `getClient`, `evict`, `evictAll`, `stats`, and O(1) LRU/TTL/health-check eviction. Construct with a tenant→config factory plus `{ maxClients, ttlMs, healthCheckIntervalMs }`, or with the options only and pass a config to `getClient(tenantId, config)` |

### Profiling

| Class | Description |
|-------|-------------|
| `ProfilerSession` | Record SDK method timings during a session and produce a flame-graph-compatible report |

`ProfilerSession` instruments both SDK methods and each client's Soroban RPC
server, so RPC round-trips appear as frames nested inside the method that
issued them. `report()` emits a **speedscope v0.6** file (validated with ajv
against the published schema in the test suite); `exportJSON(path)` writes it
to disk for drag-and-drop into [speedscope.app](https://www.speedscope.app).

```ts
const profiler = new ProfilerSession({ name: "my-session" });
profiler.start();
await client.pay({ invoiceId, payer });
profiler.stop();
profiler.exportJSON("./profile.json");
```

### Webhook Validation

| Function | Returns | Description |
|----------|---------|-------------|
| `validateWebhookSignature(payload, signature, secret)` | `Promise<boolean>` | Verify the HMAC-SHA256 signature on incoming invoice webhook payloads |
| `createWebhookMiddleware(secret, options)` | `RequestHandler` | Create secure Express/Next.js middleware for receiving webhooks with HMAC verification and replay protection |
| `generateWebhookSignature(payload, secret)` | `Promise<string>` | Generate HMAC-SHA256 signature for a webhook payload |
| `verifyWebhookSignature(payload, signature, secret)` | `Promise<boolean>` | Manually verify a webhook signature without middleware |

The middleware also exposes a typed event emitter, so you can subscribe per
event type instead of branching on `req.webhookPayload.event` in a downstream
Express handler. Only deliveries that pass signature, timestamp and nonce
validation are emitted, so handlers can trust what they receive:

```ts
const middleware = createWebhookMiddleware(secret, {
  toleranceSeconds: 300,   // reject timestamps outside a 5-minute window
  nonceWindowSize: 1000,   // in-memory LRU size for replay protection
});

// `data` is typed per event — no cast needed
middleware.emitter.on("invoice.paid", ({ data, request }) => {
  console.log(data.invoiceId, data.amount);
});

middleware.emitter.on("invoice.expired", ({ data }) => {
  console.log("expired:", data.invoiceId);
});

// Wildcard: fires for every event type
const unsubscribe = middleware.emitter.on("*", ({ event }) => log(event));

app.post("/webhooks/stellarsplit", express.raw({ type: "application/json" }), middleware, (req, res) => {
  res.status(200).json({ received: true });
});
```

### Invoice Metadata Enricher

| Function | Returns | Description |
|----------|---------|-------------|
| `enrichInvoice(invoiceId)` | `Promise<EnrichedInvoice>` | Fetch IPFS metadata from invoice memo CID and merge it into the invoice |
| `pinInvoiceMetadata(metadata)` | `Promise<string>` | Pin invoice metadata to IPFS, returning its CID |
| `verifyCID(cid, content)` | `Promise<boolean>` | Recompute the CID from `content` and check it matches |
| `verifyCIDDetailed(cid, content)` | `Promise<CIDVerificationResult>` | As above, returning the computed CID and an error message |

### IPFS Metadata & CID Verification

A CID is a self-describing content address, so `verifyCID` **recomputes** it
from the bytes and compares — it does not merely check that a fetch round-tripped.

```ts
const cid = await pinInvoiceMetadata(metadata);
await verifyCIDOrThrow(cid, metadata); // throws CIDMismatchError on tampering
```

Both CIDv0 (`Qm…`) and CIDv1 (`bafy…`) are supported, and verification always
recomputes in the same version as the CID being checked. `ipfs://` URIs are
accepted. When you supply the content, verification is entirely local — no
network round-trip — and genuinely proves the bytes hash to the claimed
address; a fabricated CID will not verify.

`verifyCIDOrThrow` reports the CID the content *actually* produced, so a
mismatch tells you whether the address or the bytes are wrong.

### Pluggable Signing Key Vault Adapter

Decouple transaction signing from key storage with a narrow `Signer` contract — inject an HSM, cloud KMS, or AES-encrypted keystore without modifying SDK internals.

| Class / Function | Description |
|------------------|-------------|
| `KeypairSigner` | `Signer` backed by an in-memory `Keypair` |
| `EncryptedFileSigner` | `Signer` reading an AES-256-GCM encrypted PEM keystore (decrypts on first use, `WeakRef`-cached) |
| `CloudKmsSigner` | `Signer` delegating to any injected `KmsClient` |
| `encryptSigningKeyToPem(secret, aesKey)` | Encrypt a Stellar secret seed to a PEM payload |
| `writeEncryptedSigningKeyFile(path, secret, aesKey)` | Write an encrypted keystore to disk |

Pass any `Signer` to `StellarSplitClient` via the `signer` constructor option (exposed as `client.signer`). See [docs/SIGNING_VAULT.md](./docs/SIGNING_VAULT.md).

### Soroban Transaction Footprint Optimizer

Prune stale or over-broad ledger keys from Soroban transactions before submission to cut inclusion fees.

| Function | Description |
|----------|-------------|
| `optimizeFootprint(tx, sim)` | Rebuild a transaction with the minimal footprint reported by simulation |
| `footprintDiff(original, minimal)` | Classify `{ added, removed, unchanged }` ledger keys |
| `submitTransaction(server, tx, sim, opts?)` | Submit with the optimizer on by default (`{ optimizeFootprint: false }` disables it) |

See [docs/FOOTPRINT_OPTIMIZER.md](./docs/FOOTPRINT_OPTIMIZER.md).

### Payment Aggregator (multi-invoice allocation)

Allocate a single budget across many invoices. Choose `"equal"`, `"proportional"`
(weighted by how far each invoice still is from its target) or `"custom"` weights
that sum to 100. Every allocation is capped at the invoice's remaining amount, so
overpayment is impossible.

```typescript
import { aggregatePayments, createInvoiceRemainingFetcher } from "@stellar-split/sdk";

const allocations = await aggregatePayments(parseAmount("100"), [1n, 2n, 3n], "proportional", {
  // Any object exposing getInvoice(id) works — a StellarSplitClient is ideal.
  fetchRemaining: createInvoiceRemainingFetcher(client),
});

for (const { invoiceId, amount, percentOfBudget } of allocations) {
  console.log(`Invoice ${invoiceId}: ${formatAmount(amount)} (${percentOfBudget}%)`);
}
```

| Function | Description |
|----------|-------------|
| `aggregatePayments(budget, invoiceIds, strategy, options?)` | Compute the optimal allocation; returns one `PaymentAllocation` per invoice (`{ invoiceId, amount, percentOfBudget }`) |
| `remainingForInvoice(invoice)` | Remaining (still unfunded) amount of an invoice, clamped at zero |
| `createInvoiceRemainingFetcher(source)` | Build a remaining-amount fetcher from any `getInvoice(id)` source |
| `registerInvoiceRemainingFetcher(fetcher)` | Set a process-wide fallback fetcher so `aggregatePayments` can be called without options |

Behavior notes: an empty invoice list returns `[]`; duplicate invoice IDs and a
negative budget throw `ValidationError`; `"custom"` weights must sum to 100;
when the invoices collectively need less than the budget, the surplus stays
unallocated and the percentages sum to less than 100.

### Deadline Helpers

`bigint`-based deadline helpers (Unix seconds), matching the on-chain `u64`
representation. The legacy `number`-returning `deadlineFromDays` remains
available from the `@stellar-split/sdk/utils` entry point.

| Function | Returns | Description |
|----------|---------|-------------|
| `deadlineFromDays(days)` | `bigint` | Unix timestamp `days` days from now (rounded up to the next whole second) |
| `deadlineFromDate(date)` | `bigint` | Convert a `Date` to a Unix timestamp in seconds |
| `isDeadlineValid(deadline)` | `boolean` | `true` when the deadline is at least 1 hour in the future |
| `timeUntilDeadline(deadline)` | `DeadlineRemaining` | `{ days, hours, minutes, seconds, expired }`, all zeros once expired |
| `formatDeadline(deadline, locale?)` | `string` | Human-readable date string, localized (rendered in UTC) |

```typescript
import { deadlineFromDays, isDeadlineValid, timeUntilDeadline } from "@stellar-split/sdk";

const deadline = deadlineFromDays(7);
isDeadlineValid(deadline);   // true
timeUntilDeadline(deadline); // { days: 7, hours: 0, minutes: 0, seconds: 0, expired: false }
```

### Utilities

| Function | Description |
|----------|-------------|
| `formatAmount(stroops)` | Format stroops as USDC string (7 decimals) |
| `parseAmount(value)` | Parse USDC string to stroops |
| `isValidAddress(address)` | Validate a Stellar G... address |
| `deadlineFromDays(days)` | Unix timestamp N days from now (`number`; the root export returns a `bigint` — see [Deadline Helpers](#deadline-helpers)) |
| `isExpired(deadline)` | Check if a deadline has passed |
| `truncateAddress(address)` | Truncate for display: "GABC...XYZ" |

## Run Tests

```bash
npm test
```

## Contributing via Drips Wave

This project participates in the [Drips Wave Program](https://drips.network/wave) by the Stellar Development Foundation. Contributors can earn rewards by completing open issues.

See [CONTRIBUTING.md](./CONTRIBUTING.md) for the full guide.

**Do not start coding until assigned to an issue by a maintainer.**

## Handsoff notes

<!-- handsoff-issue-912 -->
- #912: Implement advanced filter DSL for invoice queries

<!-- handsoff-issue-1169 -->
- #1169: Implement query optimization with indexes

<!-- handsoff-issue-1330 -->
- #1330: Add SDK pagination support
