# Soroban Transaction Footprint Optimizer

> **Issue #588**: Soroban Transaction Footprint Optimizer

## Overview

Soroban transactions must declare their read/write ledger-key footprints
upfront. Over-declaration wastes inclusion fees; under-declaration causes
simulation failures. The footprint optimizer diffs a transaction's declared
footprint against the minimal set returned by `simulateTransaction` and prunes
surplus entries before submission.

The optimizer is wired into the submission path as an **opt-out** step — it is
enabled by default and can be disabled with `{ optimizeFootprint: false }`.

## Features

- ✅ `optimizeFootprint(tx, sim)` rebuilds the transaction with the minimal
  read/write key set reported by the simulation result
- ✅ Each pruned ledger key is logged at `debug` level via the SDK logger
- ✅ `footprintDiff` classifies `{ added, removed, unchanged }` keys — exported
  as a public utility
- ✅ `submitTransaction` runs the optimizer by default (`optimizeFootprint: false`
  disables it)
- ✅ The input transaction is never mutated — a new transaction is returned
- ✅ An already-minimal footprint passes through byte-identical

## Installation

```typescript
import {
  optimizeFootprint,
  footprintDiff,
  submitTransaction,
} from "@stellar-split/sdk";
```

## API Reference

### `optimizeFootprint(tx, sim, options?): Transaction`

Replaces a Soroban transaction's declared ledger-key footprint with the minimal
read/write key set reported by a successful simulation response, pruning stale
or overly broad keys that inflate inclusion fees.

**Parameters:**

- `tx` — the Soroban `Transaction` whose footprint should be optimized
- `sim` — the successful `SimulateTransactionSuccessResponse` carrying the
  minimal footprint
- `options.logger` — optional `{ debug(message): void }` logger; each removed
  ledger key is logged at debug level

Reconstruction uses `SorobanDataBuilder` semantics via
`TransactionBuilder.cloneFrom` (the same mechanism `assembleTransaction` uses),
so all other fields — operations, source, memo, time bounds, fee — are
preserved.

### `footprintDiff(original, minimal): FootprintDiff`

Classifies the difference between an original declared footprint and the
minimal key set reported by a simulation.

```typescript
interface FootprintDiff {
  added: xdr.LedgerKey[];      // in minimal, not in original
  removed: xdr.LedgerKey[];    // in original, not in minimal
  unchanged: xdr.LedgerKey[];  // in both
}
```

Ledger keys are compared by their canonical base64 XDR encoding, so
structurally identical keys from different builders are treated as the same
key.

### `submitTransaction(server, tx, sim, options?): Promise<SendTransactionResponse>`

Submits a Soroban transaction through the given RPC server, running the
footprint optimizer immediately before submission unless disabled.

**Options:**

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `optimizeFootprint` | `boolean` | `true` | Set to `false` to submit the transaction exactly as built |
| `logger` | `FootprintLogger` | — | Receives debug-level diagnostics for pruned keys |

## Usage Examples

### Optimize a bloated footprint

```typescript
import { optimizeFootprint } from "@stellar-split/sdk";

const sim = await server.simulateTransaction(tx);
if (sim.result === "success") {
  const optimized = optimizeFootprint(tx, sim);
  await server.sendTransaction(optimized);
}
```

### Submit with the optimizer (enabled by default)

```typescript
import { submitTransaction } from "@stellar-split/sdk";

const sim = await server.simulateTransaction(tx); // SimulateTransactionSuccessResponse
await submitTransaction(server, tx, sim);
```

### Opt out of optimization

```typescript
await submitTransaction(server, tx, sim, { optimizeFootprint: false });
```

### Inspect the diff

```typescript
import { footprintDiff } from "@stellar-split/sdk";

const { added, removed, unchanged } = footprintDiff(
  txFootprintKeys,   // declared on the transaction
  minimalSimKeys,    // reported by simulateTransaction
);

for (const key of removed) {
  console.log("surplus key pruned:", key.toXDR("base64"));
}
```

### Debug logging of pruned keys

```typescript
const logger = {
  debug: (message: string) => console.debug(message),
};

const optimized = optimizeFootprint(tx, sim, { logger });
// [footprint] removing surplus ledger key AAAAA...
```

## Performance Considerations

- Trimming surplus keys reduces the resource fee charged for over-declared
  footprints
- `footprintDiff` runs in linear time over the combined key sets using a
  canonical-encoding map
- Already-minimal transactions pass through byte-identical with no unnecessary
  reserialization

## Related Functions

- [`SimulationSandbox`](./API.md) — fork ledger state and simulate without the network
- [`diffSimulations`](./API.md) — compare simulation results

## Related Issues

- [#588: Soroban Transaction Footprint Optimizer](https://github.com/Stellar-split/split-sdk/issues/588)

## License

MIT
