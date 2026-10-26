# Migration Guides for StellarSplit SDK

Comprehensive guide for migrating across major versions of the **`@stellar-split/sdk`**, including breaking change catalogs, step-by-step instructions, working code examples, troubleshooting playbooks, and automated migration validation & progress tracking.

---

## Table of Contents

1. [Semantic Versioning & Compatibility Matrix](#1-semantic-versioning--compatibility-matrix)
2. [Breaking Changes Catalog](#2-breaking-changes-catalog)
3. [Step-by-Step Migration: v0.x to v1.x](#3-step-by-step-migration-v0x-to-v1x)
4. [Step-by-Step Migration: v1.x to v2.x](#4-step-by-step-migration-v1x-to-v2x)
5. [Working Code Examples (Before & After)](#5-working-code-examples-before--after)
6. [Troubleshooting Guide](#6-troubleshooting-guide)
7. [Automated Migration Validation & Progress Tracking](#7-automated-migration-validation--progress-tracking)

---

## 1. Semantic Versioning & Compatibility Matrix

StellarSplit follows strict Semantic Versioning (`MAJOR.MINOR.PATCH`):
- **MAJOR**: Incompatible API changes, signature removals, altered default behavior.
- **MINOR**: Backwards-compatible functionality additions, non-breaking features.
- **PATCH**: Backwards-compatible bug fixes, internal performance optimizations.

| SDK Version | Node.js Runtime | `@stellar/stellar-sdk` | Token Amount Type | Wallet Interface | Package Scope |
| :--- | :--- | :--- | :--- | :--- | :--- |
| **v0.9.x** | `>=16.0.0` | `^11.x` | `number` | Ad-hoc connectors | `split-sdk` |
| **v1.x** | `>=16.0.0` | `^12.x` | `number` / `string` | Connector classes | `@stellar-split/sdk` |
| **v2.x** | `>=18.0.0` | `^13.3.0` | **`bigint`** | **`WalletAdapter` / `Signer`** | **`@stellar-split/sdk`** (with subpath exports) |

---

## 2. Breaking Changes Catalog

| ID | Upgrade Path | Category | Breaking Change Summary | Impact |
| :--- | :--- | :--- | :--- | :--- |
| **`BC-101`** | `v0.x -> v1.0.0` | Client Init | Replaced `legacyClient()` / `createLegacySplitClient()` with `new StellarSplitClient(config)`. | High |
| **`BC-102`** | `v0.x -> v1.0.0` | Error Handling | Replaced generic `Error` throws with typed `StellarSplitError` subclasses and type guards. | Medium |
| **`BC-201`** | `v1.x -> v2.0.0` | Wallet Adapter | Unified `FreighterConnector.requestAccess()` under `FreighterAdapter.connect()` and `Signer`. | High |
| **`BC-202`** | `v1.x -> v2.0.0` | Numeric Precision | All stroop/token amounts (`amount`, `totalAmount`, `feeCeiling`) require `bigint` instead of `number`. | High |
| **`BC-203`** | `v1.x -> v2.0.0` | Network Config | Explicit `NetworkPreset` (`getNetworkPreset(NetworkEnvironment.TESTNET)`) required on client init. | Medium |
| **`BC-204`** | `v1.x -> v2.0.0` | Telemetry & Plugins | Removed `config.onLog`; use `client.use(LoggingPlugin)` and `config.telemetryHooks`. | Medium |
| **`BC-205`** | `v1.x -> v2.0.0` | Subpath Exports | Blocked `/dist/*` deep imports; use `@stellar-split/sdk/utils`, `/ui`, `/react`, `/testing`, `/mock`, `/telemetry`, `/lazy`. | Medium |

---

## 3. Step-by-Step Migration: v0.x to v1.x

### Step 1: Replace `legacyClient` with `StellarSplitClient` (`BC-101`)
Instantiate `StellarSplitClient` with an explicit configuration object containing your Soroban `contractId` and network endpoints.

### Step 2: Adopt Typed `StellarSplitError` Guards (`BC-102`)
Replace substring checks on `error.message` with deterministic type guards (`isInvoiceNotFoundError`, `isDeadlinePassedError`, `isInvoiceFullyFundedError`).

---

## 4. Step-by-Step Migration: v1.x to v2.x

### Step 1: Update Package Imports to Official Subpath Exports (`BC-205`)
Replace any `split-sdk/dist/...` imports with `@stellar-split/sdk` or its subpath entrypoints (`@stellar-split/sdk/utils`, `@stellar-split/sdk/react`, `@stellar-split/sdk/ui`).

### Step 2: Configure Explicit `NetworkEnvironment` Presets (`BC-203`)
Spread `getNetworkPreset(NetworkEnvironment.TESTNET)` (or `MAINNET` / `FUTURENET`) into `new StellarSplitClient({ ... })`.

### Step 3: Unified Wallet Adapter Interface (`BC-201`)
In v1.x, each wallet connector used a distinct proprietary contract. In v2.x, all connectors adhere to the common `WalletAdapter` interface.

**v1.x:**
```typescript
import { FreighterConnector } from 'split-sdk';
const wallet = new FreighterConnector();
await wallet.requestAccess();
```

**v2.x:**
```typescript
import { FreighterAdapter } from '@stellar-split/sdk';
const wallet = new FreighterAdapter();
const address = await wallet.connect();
```

### Step 4: BigInt Strictness for Token Amounts (`BC-202`)
All stroop/amount calculations have moved from `number` to `bigint` to prevent floating-point precision loss.

**v1.x:**
```typescript
client.createInvoice({ amount: 1000000 });
```

**v2.x:**
```typescript
client.createInvoice({ amount: 1000000n });
```

### Step 5: Migrate `onLog` to `PluginRegistry` & `TelemetryHooks` (`BC-204`)
Attach `LoggingPlugin` via `client.use(LoggingPlugin)` and pass `telemetryHooks` in `StellarSplitClientConfig`.

---

## 5. Working Code Examples (Before & After)

### 5.1 Complete End-to-End Invoice Creation & Payment

**Before (v1.x):**
```typescript
import { StellarSplitClient, FreighterConnector } from "split-sdk";
import { parseAmount } from "split-sdk/dist/utils";

const wallet = new FreighterConnector();
await wallet.requestAccess();

const client = new StellarSplitClient({
  contractId: "CCONTRACT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  onLog: (msg) => console.log(msg),
});

await client.createInvoice({
  amount: 25000000, // 2.5 XLM as JS number
  recipients: [{ address: "GABC...", shareBps: 10000 }],
});
```

**After (v2.x):**
```typescript
import {
  StellarSplitClient,
  NetworkEnvironment,
  getNetworkPreset,
  LoggingPlugin,
  isDeadlinePassedError,
} from "@stellar-split/sdk";
import { parseAmount, formatAmount } from "@stellar-split/sdk/utils";

const client = new StellarSplitClient({
  ...getNetworkPreset(NetworkEnvironment.TESTNET),
  contractId: "CCONTRACT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
  telemetryHooks: {
    onCallStart: ({ method, traceId }) => console.debug(`[start] ${method} (${traceId})`),
    onCallEnd: ({ method, durationMs, success }) =>
      console.debug(`[end] ${method} ${durationMs}ms ok=${success}`),
  },
});

client.use(LoggingPlugin);

const stroopAmount: bigint = parseAmount("2.5"); // 25000000n
console.log("Formatted amount:", formatAmount(stroopAmount)); // "2.5000000"

try {
  await client.createInvoice({
    amount: stroopAmount,
    recipients: [{ address: "GABC...", shareBps: 10000 }],
  });
} catch (err) {
  if (isDeadlinePassedError(err)) {
    console.error("Invoice deadline has already passed:", err.code);
  }
}
```

---

## 6. Troubleshooting Guide

### Issue 1: `TypeError: Cannot mix BigInt and other types, use explicit conversions` (`TS-001`)
- **Cause**: Application code multiplies or adds a `number` (e.g. `100`) to an SDK `bigint` amount field.
- **Solution**: Convert numeric constants to `bigint` literals (`100n`) and use `parseAmount()` / `formatAmount()` from `@stellar-split/sdk/utils` at UI boundaries.

### Issue 2: `Property 'requestAccess' does not exist on type 'FreighterAdapter'` (`TS-002`)
- **Cause**: Calling the removed v1 `requestAccess()` method on a v2 wallet adapter.
- **Solution**: Call `const address = await wallet.connect();`.

### Issue 3: `UnknownNetworkError` during Client Initialization (`TS-003`)
- **Cause**: Missing `horizonUrl`, `rpcUrl`, or `networkPassphrase` when initializing `StellarSplitClient` or calling `switchNetwork()`.
- **Solution**: Spread `...getNetworkPreset(NetworkEnvironment.TESTNET)` into the client configuration or validate custom presets with `isNetworkPreset(preset)`.

### Issue 4: `ERR_PACKAGE_PATH_NOT_EXPORTED` on `/dist/*` Imports (`TS-004`)
- **Cause**: Node.js ESM or bundler rejecting unexported deep paths like `@stellar-split/sdk/dist/utils`.
- **Solution**: Replace with `@stellar-split/sdk/utils`.

---

## 7. Automated Migration Validation & Progress Tracking

`@stellar-split/sdk` includes programmatic migration validation (`validateSdkMigration`), interactive progress tracking (`MigrationProgressTracker`), and a CLI AST breaking-change detector (`stellar-split-sdk-migrate`).

### 7.1 Validating Configurations, Payloads & Code Snippets

```typescript
import {
  validateSdkMigration,
  MigrationProgressTracker,
} from "../src/migration/versionMigrationGuide.js";

const validation = validateSdkMigration({
  targetVersion: "2.0.0",
  config: {
    contractId: "CCONTRACT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
    rpcUrl: "https://soroban-testnet.stellar.org",
    horizonUrl: "https://horizon-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
  },
  invoicePayload: {
    amount: 1000000n,
  },
});

console.log("Migration valid:", validation.valid, "Score:", validation.score);
```

### 7.2 Tracking Step-by-Step Upgrade Progress

```typescript
const tracker = new MigrationProgressTracker("v1-to-v2");

tracker.completeStep("step-v2-1-imports", "Updated all subpath imports");
tracker.completeStep("step-v2-2-network", "Configured TESTNET preset");
tracker.startStep("step-v2-3-wallets");

const summary = tracker.getSummary();
console.log(`Progress: ${summary.percentComplete}% (${summary.completedSteps}/${summary.totalSteps})`);
```

### 7.3 Migration Checklist

1. [ ] Audit existing `process.env` references for new SDK environment config schemas.
2. [ ] Replace deprecated wallet connect methods with the unified `WalletAdapter.connect()`.
3. [ ] Convert numerical Stroop balance inputs to `bigint`.
4. [ ] Validate configuration and payloads with `validateSdkMigration()`.
5. [ ] Run full test suite with `npm test`.
