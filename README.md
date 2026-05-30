# @stellar-split/sdk

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

## API Reference

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
| `createInvoice(params)` | `Promise<{ invoiceId, txHash }>` | Create a new invoice |
| `pay(params)` | `Promise<{ txHash }>` | Pay toward an invoice |
| `getInvoice(id)` | `Promise<Invoice>` | Fetch invoice by ID |
| `getPayments(id)` | `Promise<Payment[]>` | Fetch payments for an invoice |

### Wallet Helpers

| Function | Returns | Description |
|----------|---------|-------------|
| `connectWallet()` | `Promise<string>` | Connect Freighter, return public key |
| `getPublicKey()` | `Promise<string>` | Get connected wallet's public key |
| `signTransaction(xdr, network)` | `Promise<string>` | Sign a transaction XDR |

### Multi-Tenant Support

| Class | Description |
|-------|-------------|
| `MultiTenantClient` | Manage a pool of `StellarSplitClient` instances keyed by tenant ID, with `getClient`, `evict`, and `evictAll` |

### Profiling

| Class | Description |
|-------|-------------|
| `ProfilerSession` | Record SDK method timings during a session and produce a flame-graph-compatible report |

### Webhook Validation

| Function | Returns | Description |
|----------|---------|-------------|
| `validateWebhookSignature(payload, signature, secret)` | `Promise<boolean>` | Verify the HMAC-SHA256 signature on incoming invoice webhook payloads |

### Invoice Metadata Enricher

| Function | Returns | Description |
|----------|---------|-------------|
| `enrichInvoice(invoiceId)` | `Promise<EnrichedInvoice>` | Fetch IPFS metadata from invoice memo CID and merge it into the invoice |

### Utilities

| Function | Description |
|----------|-------------|
| `formatAmount(stroops)` | Format stroops as USDC string (7 decimals) |
| `parseAmount(value)` | Parse USDC string to stroops |
| `isValidAddress(address)` | Validate a Stellar G... address |
| `deadlineFromDays(days)` | Unix timestamp N days from now |
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
