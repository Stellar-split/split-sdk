# SDK Tutorials

This guide provides step-by-step tutorials for integrating with the StellarSplit SDK.

## Table of Contents

1. [Getting Started](#getting-started)
2. [Creating Your First Invoice](#creating-your-first-invoice)
3. [Paying Toward an Invoice](#paying-toward-an-invoice)
4. [Webhook Integration](#webhook-integration)
5. [Multi-Signature Wallets](#multi-signature-wallets)
6. [Error Handling](#error-handling)
7. [Production Checklist](#production-checklist)

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
