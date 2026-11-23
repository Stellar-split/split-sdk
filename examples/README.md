# StellarSplit SDK Example Applications

This directory contains executable, end-to-end TypeScript examples demonstrating core workflows, architectural patterns, and production integrations using the `@stellar-split/sdk`.

---

## Table of Contents

1. [Prerequisites & Quick Start](#prerequisites--quick-start)
2. [Example Applications](#example-applications)
   - [1. Basic Split Invoice Lifecycle (`basic-split-invoice.ts`)](#1-basic-split-invoice-lifecycle)
   - [2. Batch Payments & Payroll (`batch-payments.ts`)](#2-batch-payments--payroll)
   - [3. Dispute Resolution & Arbitration (`dispute-and-arbitration.ts`)](#3-dispute-resolution--arbitration)
   - [4. Real-Time Event Monitoring (`realtime-monitoring.ts`)](#4-real-time-event-monitoring)
   - [5. Webhook Middleware & Security (`webhook-middleware-example.ts`)](#5-webhook-middleware--security)
   - [6. OpenTelemetry & Observability (`telemetry-hooks-example.ts`)](#6-opentelemetry--observability)
   - [7. Session Profiling (`profile-session.ts`)](#7-session-profiling)
   - [8. Graceful Shutdown & Drain (`graceful-shutdown-example.ts`)](#8-graceful-shutdown--drain)
   - [9. Plugins & RPC Interceptors (`plugin-and-interceptors.ts`)](#9-plugins--rpc-interceptors)
3. [Environment Configuration](#environment-configuration)
4. [Documentation Testing](#documentation-testing)

---

## Prerequisites & Quick Start

Ensure dependencies are installed in the root project:

```bash
npm install
```

All examples are written in modern TypeScript and can be executed directly using `npx tsx`:

```bash
# Run the basic invoice example
npx tsx examples/basic-split-invoice.ts

# Run batch payments
npx tsx examples/batch-payments.ts

# Run dispute arbitration
npx tsx examples/dispute-and-arbitration.ts

# Run real-time monitoring
npx tsx examples/realtime-monitoring.ts
```

---

## Example Applications

### 1. Basic Split Invoice Lifecycle
**File**: [`examples/basic-split-invoice.ts`](./basic-split-invoice.ts)

Demonstrates the canonical invoice splitting workflow from creation to disbursement:
- Initializing `StellarSplitClient` with custom network configuration and debug logging.
- Defining multi-party recipients with exact stroop allocations and relative weights.
- Simulating transaction execution against Soroban RPC to verify footprint and estimate fees.
- Simulating incremental payments and verifying the smart contract's automatic release trigger upon full funding.
- Generating and validating cryptographic settlement receipts.

```bash
npx tsx examples/basic-split-invoice.ts
```

### 2. Batch Payments & Payroll
**File**: [`examples/batch-payments.ts`](./batch-payments.ts)

Illustrates high-volume payout operations for organizations and payroll platforms:
- Preparing payments across dozens of contractors with distinct addresses and token allocations.
- Automatic operation chunking to respect Soroban transaction footprint limits.
- Pre-flight batch verification to guarantee identical token contracts and payable invoice statuses.
- Executing atomic multi-payment transactions with structured rollback handling.

```bash
npx tsx examples/batch-payments.ts
```

### 3. Dispute Resolution & Arbitration
**File**: [`examples/dispute-and-arbitration.ts`](./dispute-and-arbitration.ts)

Covers the escrow and multi-signature arbitration subsystem:
- Transitioning funded invoices into a contested state with evidence attached (IPFS CID and cryptographic hash).
- Casting structured votes by designated domain arbiters (e.g. Legal, Technical Auditor, Mediator).
- Enforcing threshold consensus rules (e.g. 2-of-3 majority) before state mutation.
- Executing dispute resolution: releasing escrow to the provider or issuing an on-chain refund to the contributor.

```bash
npx tsx examples/dispute-and-arbitration.ts
```

### 4. Real-Time Event Monitoring
**File**: [`examples/realtime-monitoring.ts`](./realtime-monitoring.ts)

Demonstrates live transaction monitoring and state synchronization:
- Registering strongly-typed event listeners for contract-wide events (`payment`, `release`, `refund`).
- Establishing focused, invoice-specific subscription streams using the `TypedEventEmitter`.
- Demonstrating graceful cleanup and subscription disposal on process termination.

```bash
npx tsx examples/realtime-monitoring.ts
```

### 5. Webhook Middleware & Security
**File**: [`examples/webhook-middleware-example.ts`](./webhook-middleware-example.ts)

Shows production-grade webhook ingestion with Express:
- Constant-time HMAC-SHA256 signature verification to prevent timing attacks.
- Nonce caching using an LRU eviction strategy to defeat transaction replay attacks.
- Enforcing strict timestamp tolerance windows against clock drift.
- Subscribing to strongly-typed event streams via `middleware.emitter`.

```bash
npx tsx examples/webhook-middleware-example.ts
```

### 6. OpenTelemetry & Observability
**File**: [`examples/telemetry-hooks-example.ts`](./telemetry-hooks-example.ts)

Demonstrates enterprise observability integration:
- Tracing client calls, RPC latency, and contract simulation timings via OpenTelemetry spans.
- Instrumenting error tracking and recording custom span attributes.
- Propagating W3C trace contexts across distributed services.

```bash
npx tsx examples/telemetry-hooks-example.ts
```

### 7. Session Profiling
**File**: [`examples/profile-session.ts`](./profile-session.ts)

Analyzes SDK throughput and operational overhead:
- Measuring memory usage, ledger query latency, and invocation metrics across multi-step flows.
- Exporting diagnostic summaries for performance tuning.

```bash
npx tsx examples/profile-session.ts
```

### 8. Graceful Shutdown & Drain
**File**: [`examples/graceful-shutdown-example.ts`](./graceful-shutdown-example.ts)

Implements container-friendly graceful shutdown:
- Handling `SIGINT` / `SIGTERM` signals.
- Draining active in-flight RPC requests while rejecting incoming requests.
- Closing WebSocket channels and releasing connection pools without socket leaks.

```bash
npx tsx examples/graceful-shutdown-example.ts
```

### 9. Plugins & RPC Interceptors
**File**: [`examples/plugin-and-interceptors.ts`](./plugin-and-interceptors.ts)

Small, self-contained tour of the SDK extension points:
- A `StellarSplitPlugin` with `install`, `onInit` and `onDestroy` hooks.
- Global RPC request/response interceptors.
- Handling `PluginAlreadyRegisteredError` on duplicate registration.

```bash
npx tsx examples/plugin-and-interceptors.ts
```

---

## Environment Configuration

The examples support the following environment variables (falling back to public Testnet defaults when omitted):

| Variable | Description | Default |
|---|---|---|
| `STELLAR_RPC_URL` | Soroban RPC endpoint URL | `https://soroban-testnet.stellar.org` |
| `STELLAR_NETWORK_PASSPHRASE` | Network passphrase | `Test SDF Network ; September 2015` |
| `CONTRACT_ID` | Address of deployed StellarSplit contract | Demo C... contract ID |
| `SPLIT_SDK_LOG_LEVEL` | Minimum active SDK log level (`debug`, `info`, `warn`, `error`, `none`) | `info` |
| `WEBHOOK_SECRET` | Secret key for HMAC webhook verification | Example test key |

---

## Documentation Testing

Every runnable snippet in this README and in the example files is verified by the documentation test suite so the docs stay accurate as the SDK evolves.

### How it works

- **Extraction** — fenced `bash`/`ts`/`typescript` blocks are parsed out of the docs and example files.
- **Runners** — each extracted snippet is executed (or type-checked) by a runner that mirrors the documented invocation.
- **Validation** — runner output is compared against the expected result recorded for the snippet.
- **Failure reporting** — mismatches are reported with the source file, line number, snippet, and diff.
- **Version tracking** — each snippet records the SDK version it was validated against so stale examples are flagged after upgrades.

### Running the documentation tests

```bash
# Validate all documentation examples
npm run test:docs

# Validate a single example file
npm run test:docs -- examples/basic-split-invoice.ts
```

### Adding a new example

When you add a new example or snippet:

1. Add the example file under `examples/` and reference it in the table above.
2. Include a runnable `bash` block showing how to execute it.
3. Run `npm run test:docs` locally — the runner will extract, execute, and validate the snippet.
4. Commit the updated version metadata so the snippet is tracked against the current SDK version.

If a documentation test fails, the report identifies the exact file and snippet so the example can be corrected before merge.
