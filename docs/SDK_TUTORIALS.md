# SDK Tutorials

This guide provides step-by-step tutorials for integrating with the StellarSplit SDK.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Creating Your First Invoice](#creating-your-first-invoice)
3. [Paying Toward an Invoice](#paying-toward-an-invoice)
4. [Webhook Integration](#webhook-integration)
5. [Multi-Signature Wallets](#multi-signature-wallets)
6. [Error Handling](#error-handling)
7. [Advanced Usage](#advanced-usage)
8. [Production Checklist](#production-checklist)

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

## Advanced Usage

This section covers patterns for production-grade integrations: batching, retries, pagination, event streaming, and performance tuning.

### Pattern: Idempotent Invoice Creation

Generate a deterministic client-side key so retries never create duplicate invoices.

```typescript
import { createHash } from "node:crypto";

function idempotencyKey(creator: string, externalRef: string): string {
  return createHash("sha256").update(`${creator}:${externalRef}`).digest("hex");
}

async function createInvoiceOnce(creator: string, externalRef: string) {
  const key = idempotencyKey(creator, externalRef);
  const existing = await client.findInvoiceByReference({ creator, reference: key });
  if (existing) return existing;

  return client.createInvoice({
    creator,
    reference: key,
    recipients: [{ address: "GABC...RECIPIENT1", amount: parseAmount("100") }],
    token: "USDC_CONTRACT_ADDRESS",
    deadline: deadlineFromDays(7),
  });
}
```

### Pattern: Retry with Exponential Backoff

Retry only transient failures (network / RPC), never validation errors.

```typescript
import { StellarSplitError, isRetryableError } from "@stellar-split/sdk";

async function withRetry<T>(fn: () => Promise<T>, attempts = 5): Promise<T> {
  let lastErr: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      const retryable = err instanceof StellarSplitError && isRetryableError(err);
      if (!retryable || i === attempts - 1) throw err;
      const delay = Math.min(2 ** i * 250, 8000) + Math.random() * 100;
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw lastErr;
}

await withRetry(() => client.pay({ payer, invoiceId, amount: parseAmount("25") }));
```

### Pattern: Batched Payments

Pay multiple invoices in a single transaction to reduce fees and round-trips.

```typescript
const { txHash } = await client.payBatch({
  payer,
  payments: [
    { invoiceId: "INV_1", amount: parseAmount("10") },
    { invoiceId: "INV_2", amount: parseAmount("15") },
  ],
});
```

### Pattern: Paginated Invoice Listing

```typescript
async function* allInvoices(creator: string) {
  let cursor: string | undefined;
  do {
    const page = await client.listInvoices({ creator, cursor, limit: 50 });
    for (const invoice of page.items) yield invoice;
    cursor = page.nextCursor;
  } while (cursor);
}

for await (const invoice of allInvoices(publicKey)) {
  console.log(invoice.invoiceId, invoice.status);
}
```

### Pattern: Real-Time Event Streaming

```typescript
const stream = client.streamEvents({ invoiceId });

stream.on("payment", (p) => console.log("Payment received:", p.amount));
stream.on("completed", () => stream.close());
stream.on("error", (err) => console.error("Stream error:", err));
```

### Pattern: Concurrent Payment Collection

```typescript
const results = await Promise.allSettled(
  payers.map((payer) =>
    withRetry(() => client.pay({ payer, invoiceId, amount: parseAmount("5") }))
  )
);

const failed = results.filter((r) => r.status === "rejected");
if (failed.length) console.warn(`${failed.length} payments failed`);
```

### Best Practices

- **Reuse a single client instance** per process; it manages connection pooling internally.
- **Never retry non-idempotent operations** without an idempotency key.
- **Validate amounts and addresses** client-side before submitting to avoid wasted fees.
- **Use `payBatch`** when paying many invoices to amortize transaction fees.
- **Stream events** instead of polling for status changes.
- **Pin the SDK version** in production and review changelogs before upgrading.
- **Keep secrets server-side**; never expose `WEBHOOK_SECRET` to the browser.
- **Log `txHash` and error `code`** for every operation to aid debugging.

### Optimization Guide

| Area | Recommendation |
|------|----------------|
| Client lifecycle | Create one `StellarSplitClient` and reuse it across requests |
| Network calls | Batch reads with `listInvoices` pagination; batch writes with `payBatch` |
| Concurrency | Cap parallel payments (e.g. 5–10) to avoid RPC rate limits |
| Polling | Replace polling with `streamEvents` |
| Fees | Combine payments into a single transaction where possible |
| Caching | Cache immutable invoice metadata; invalidate on `completed` events |
| Payload size | Request only needed fields via `select` where supported |

### Advanced Reference

| Method | Description |
|--------|-------------|
| `client.payBatch({ payer, payments })` | Pay multiple invoices in one transaction |
| `client.listInvoices({ creator, cursor, limit })` | Paginated invoice listing |
| `client.findInvoiceByReference({ creator, reference })` | Look up invoice by idempotency reference |
| `client.streamEvents({ invoiceId })` | Subscribe to real-time invoice events |
| `isRetryableError(err)` | Returns `true` for transient SDK errors |
| `client.getInvoice(invoiceId)` | Fetch a single invoice by ID |
| `client.getBalance({ address, token })` | Query token balance for an address |

---

## Production Checklist

Before deploying to production:

- [ ] Use mainnet RPC URL instead of testnet
- [ ] Verify contract ID is correct for mainnet
- [ ] Set `WEBHOOK_SECRET` environment variable
- [ ] Use HTTPS for webhook endpoints
- [ ] Implement proper error handling and retry logic
- [ ] Monitor webhook delivery failures
- [ ] Test with small amounts before large transactions
- [ ] Set up rate limiting for your webhook endpoint
- [ ] Audit multi-sig signer configurations
- [ ] Implement invoice expiration cleanup

---

## Support

- [GitHub Issues](https://github.com/Stellar-split/split-sdk/issues)
- [Discord](https://discord.gg/stellarsplit)
