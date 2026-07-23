# Invoice Diff Utility

> **Issue #363**: Build invoice diff utility — compare two invoice states

## Overview

The invoice diff utility provides pure functions to compare two invoice objects and detect what changed between them. This is particularly useful for:

- **Cache invalidation**: Detect when a cached invoice differs from a fresh fetch
- **Change tracking**: Monitor invoice state changes over time
- **Reconciliation**: Verify that local state matches on-chain state
- **Debugging**: Understand what fields changed during an operation

## Features

- ✅ Pure functions with no RPC calls or side effects
- ✅ Returns structured diff showing only changed fields
- ✅ Handles nested objects (recipients list, split rules)
- ✅ Handles arrays (payment history, prerequisites)
- ✅ BigInt fields compared numerically, not by reference
- ✅ Convenience `hasDiff()` function returns boolean
- ✅ Full TypeScript type definitions

## Installation

The diff utility is included in the main SDK package:

```typescript
import { diffInvoices, hasDiff } from "@stellar-split/sdk";
import type { InvoiceDiff, InvoiceDiffEntry } from "@stellar-split/sdk";
```

## API Reference

### `diffInvoices(a: Invoice, b: Invoice): InvoiceDiff`

Compare two invoice objects and return a structured diff.

**Parameters:**
- `a`: The first invoice (typically the "before" or older state)
- `b`: The second invoice (typically the "after" or newer state)

**Returns:** `InvoiceDiff` - Array of changed fields with before and after values

**Type Definition:**
```typescript
type InvoiceDiff = InvoiceDiffEntry[];

interface InvoiceDiffEntry {
  field: string;
  before: unknown;
  after: unknown;
}
```

### `hasDiff(a: Invoice, b: Invoice): boolean`

Convenience function to check if two invoices have any differences.

**Parameters:**
- `a`: The first invoice
- `b`: The second invoice

**Returns:** `boolean` - `true` if the invoices differ, `false` if identical

## Usage Examples

### Basic Comparison

```typescript
import { diffInvoices } from "@stellar-split/sdk";

const oldInvoice = await client.getInvoice("123");

// ... time passes, invoice may have changed ...

const newInvoice = await client.getInvoice("123");

const diff = diffInvoices(oldInvoice, newInvoice);

console.log(diff);
// [
//   { field: "funded", before: 1000000n, after: 2000000n },
//   { field: "status", before: "Pending", after: "Released" }
// ]
```

### Cache Invalidation

```typescript
import { hasDiff } from "@stellar-split/sdk";

// Check if cached invoice needs updating
const cachedInvoice = getFromCache("123");
const freshInvoice = await client.getInvoice("123");

if (hasDiff(cachedInvoice, freshInvoice)) {
  console.log("Invoice has changed, updating cache...");
  updateCache("123", freshInvoice);
} else {
  console.log("Cache is up to date");
}
```

### Detecting Specific Changes

```typescript
import { diffInvoices } from "@stellar-split/sdk";

const diff = diffInvoices(oldInvoice, newInvoice);

// Check if status changed
const statusChange = diff.find(d => d.field === "status");
if (statusChange) {
  console.log(`Status changed from ${statusChange.before} to ${statusChange.after}`);
}

// Check if funded amount changed
const fundedChange = diff.find(d => d.field === "funded");
if (fundedChange) {
  const before = fundedChange.before as bigint;
  const after = fundedChange.after as bigint;
  console.log(`Funded amount changed by ${after - before} stroops`);
}
```

### Monitoring Invoice Changes

```typescript
import { diffInvoices } from "@stellar-split/sdk";

class InvoiceMonitor {
  private lastState: Map<string, Invoice> = new Map();

  async checkForChanges(invoiceId: string) {
    const currentState = await client.getInvoice(invoiceId);
    const previousState = this.lastState.get(invoiceId);

    if (!previousState) {
      this.lastState.set(invoiceId, currentState);
      return [];
    }

    const changes = diffInvoices(previousState, currentState);
    
    if (changes.length > 0) {
      console.log(`Invoice ${invoiceId} changed:`, changes);
      this.lastState.set(invoiceId, currentState);
    }

    return changes;
  }
}

const monitor = new InvoiceMonitor();
await monitor.checkForChanges("123");
```

### Change Logging

```typescript
import { diffInvoices } from "@stellar-split/sdk";

function logInvoiceChanges(before: Invoice, after: Invoice) {
  const diff = diffInvoices(before, after);

  if (diff.length === 0) {
    console.log("No changes detected");
    return;
  }

  console.log(`Found ${diff.length} change(s):`);
  
  for (const change of diff) {
    console.log(`  - ${change.field}:`);
    console.log(`      Before: ${formatValue(change.before)}`);
    console.log(`      After:  ${formatValue(change.after)}`);
  }
}

function formatValue(val: unknown): string {
  if (typeof val === "bigint") {
    return `${val} stroops`;
  }
  if (Array.isArray(val)) {
    return `Array[${val.length}]`;
  }
  return JSON.stringify(val);
}
```

### Reconciliation Check

```typescript
import { hasDiff, diffInvoices } from "@stellar-split/sdk";

async function reconcileInvoiceState(invoiceId: string) {
  const localState = getLocalInvoice(invoiceId);
  const onChainState = await client.getInvoice(invoiceId);

  if (!hasDiff(localState, onChainState)) {
    console.log("✓ Local state matches on-chain state");
    return { inSync: true };
  }

  const diff = diffInvoices(localState, onChainState);
  console.warn("✗ State mismatch detected:");
  console.warn(diff);

  return {
    inSync: false,
    differences: diff,
  };
}
```

## Field Comparison Behavior

### Primitive Fields

Primitive values (strings, numbers, booleans) are compared using strict equality (`===`):

```typescript
{ field: "status", before: "Pending", after: "Released" }
{ field: "deadline", before: 1234567890, after: 1234567999 }
```

### BigInt Fields

BigInt values are compared numerically, not by reference:

```typescript
const invoice1 = { ...base, funded: 1000000n };
const invoice2 = { ...base, funded: 1000000n };

diffInvoices(invoice1, invoice2); // [] (no difference)
```

### Arrays

Arrays are compared element-by-element with deep equality:

```typescript
// Detects length changes
{ field: "payments", before: [payment1], after: [payment1, payment2] }

// Detects element changes
{ field: "recipients", before: [{ address: "A", amount: 1n }], after: [{ address: "A", amount: 2n }] }
```

### Nested Objects

Nested objects (like recipients, split rules) are compared deeply:

```typescript
const before = {
  recipients: [
    { address: "GXYZ", amount: 1000000n }
  ]
};

const after = {
  recipients: [
    { address: "GXYZ", amount: 2000000n }  // Amount changed
  ]
};

// Returns:
[{
  field: "recipients",
  before: [{ address: "GXYZ", amount: 1000000n }],
  after: [{ address: "GXYZ", amount: 2000000n }]
}]
```

### Optional Fields

Optional fields that are `undefined` in both invoices are skipped:

```typescript
// Both invoices have undefined memo
diffInvoices(
  { ...base, memo: undefined },
  { ...base, memo: undefined }
); // [] (no difference)

// Field added
diffInvoices(
  { ...base, memo: undefined },
  { ...base, memo: "Payment received" }
); // [{ field: "memo", before: undefined, after: "Payment received" }]

// Field removed
diffInvoices(
  { ...base, memo: "Old memo" },
  { ...base, memo: undefined }
); // [{ field: "memo", before: "Old memo", after: undefined }]
```

## All Supported Fields

The diff utility compares all invoice fields:

**Core Fields:**
- `id` - Invoice ID
- `creator` - Creator address
- `recipients` - Array of recipients and amounts
- `token` - Token address
- `deadline` - Payment deadline timestamp
- `funded` - Total funded amount (bigint)
- `status` - Current status
- `payments` - Payment history array

**Optional Fields:**
- `recurring` - Recurring invoice flag
- `memo` - Invoice description
- `scheduledReleaseDate` - Scheduled release timestamp
- `clonedFrom` - Source invoice ID (for clones)
- `groupId` - Invoice group ID
- `lastModifiedLedger` - Last modification ledger
- `prerequisites` - Prerequisite invoice IDs
- `parentInvoiceId` - Parent invoice in clone chain
- `cloneDepth` - Depth in clone chain
- `nft_gate` - NFT gate contract address
- `forward_invoice_id` - Forward chain invoice ID
- `penalty_deadline` - Penalty deadline timestamp
- `penalty_tiers` - Penalty tier configuration
- `allowed_callers` - Permitted caller addresses
- `split_rules` - Split rule configuration
- `auto_resolve_rules` - Auto-resolve rule configuration
- `prerequisite_id` - Single prerequisite ID

## Performance Considerations

- **Pure function**: No RPC calls, no side effects
- **Efficient**: Only compares fields, doesn't traverse the entire object tree unnecessarily
- **Lightweight**: Returns only changed fields, not entire objects
- **No mutations**: Original invoice objects are never modified

## Type Safety

All functions and types are fully typed for IDE autocomplete and compile-time safety:

```typescript
import type { Invoice, InvoiceDiff, InvoiceDiffEntry } from "@stellar-split/sdk";

const before: Invoice = { /* ... */ };
const after: Invoice = { /* ... */ };

const diff: InvoiceDiff = diffInvoices(before, after);

// Each entry is typed
diff.forEach((entry: InvoiceDiffEntry) => {
  console.log(entry.field);   // string
  console.log(entry.before);  // unknown (runtime type depends on field)
  console.log(entry.after);   // unknown
});
```

## Common Patterns

### Polling for Changes

```typescript
async function pollForChanges(invoiceId: string, intervalMs: number = 5000) {
  let lastState = await client.getInvoice(invoiceId);

  setInterval(async () => {
    const currentState = await client.getInvoice(invoiceId);
    
    if (hasDiff(lastState, currentState)) {
      const changes = diffInvoices(lastState, currentState);
      console.log("Invoice updated:", changes);
      onInvoiceChanged(changes);
      lastState = currentState;
    }
  }, intervalMs);
}
```

### Conditional Actions

```typescript
const diff = diffInvoices(oldInvoice, newInvoice);

// Take action based on specific changes
const statusChange = diff.find(d => d.field === "status");
if (statusChange && statusChange.after === "Released") {
  await notifyRecipients(newInvoice);
}

const fundedChange = diff.find(d => d.field === "funded");
if (fundedChange) {
  await updateFundingProgress(newInvoice);
}
```

### Audit Trail

```typescript
const changes = diffInvoices(before, after);

await logToAuditTrail({
  invoiceId: after.id,
  timestamp: Date.now(),
  changes: changes.map(c => ({
    field: c.field,
    oldValue: String(c.before),
    newValue: String(c.after),
  })),
});
```

## Related Functions

- [`getInvoice()`](./API.md#getinvoice) - Fetch current invoice state
- [`subscribeToInvoice()`](./API.md#subscribetoinvoice) - Subscribe to invoice changes
- [`diffSimulations()`](./API.md#diffsimulations) - Compare simulation results

## Related Issues

- [#363: Build invoice diff utility](https://github.com/Stellar-split/split-sdk/issues/363)

## License

MIT
