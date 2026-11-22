# Migration Guides for StellarSplit SDK

Comprehensive guide for migrating across major versions of the StellarSplit SDK.

For background on how the SDK is structured internally, see [ARCHITECTURE.md](./ARCHITECTURE.md).
For the full public API surface of each version, see [docs/API.md](./API.md).

---

## Semantic Versioning Principles

StellarSplit follows strict Semantic Versioning (`MAJOR.MINOR.PATCH`):
- **MAJOR**: Incompatible API changes, signature removals, altered default behavior.
- **MINOR**: Backwards-compatible functionality additions, non-breaking features.
- **PATCH**: Backwards-compatible bug fixes, internal performance optimizations.

---

## Version Index

| Migration Path | Status | Guide |
| --- | --- | --- |
| v1.x → v2.x | Stable | [Jump to section](#migrating-from-v1x-to-v2x) |
| v2.x → v3.x | Planned (placeholder) | [Jump to section](#migrating-from-v2x-to-v3x) |

> Always upgrade one major version at a time (e.g. v1 → v2 → v3). Skipping a major version is not supported.

---

## Migrating from v1.x to v2.x

### Breaking Changes

| # | Change | Impact |
| --- | --- | --- |
| 1 | Wallet connectors replaced by the unified `WalletAdapter` interface | `FreighterConnector` and friends no longer exist |
| 2 | Token amounts are now `bigint` instead of `number` | All stroop/amount inputs must be `bigint` |
| 3 | Environment config schema changed | `process.env` keys must be re-audited |

### Step-by-Step Migration

1. **Upgrade the package**
   ```bash
   npm install split-sdk@^2
   ```
2. **Replace wallet connectors** with the unified `WalletAdapter` (see example below).
3. **Convert numeric amounts to `bigint`** at every call site.
4. **Audit environment configuration** against the v2 schema.
5. **Validate** the migration with the CLI (see [Validation](#validation)).
6. **Run the test suite** with `npm test`.

### Code Examples

#### Unified Wallet Adapter Interface
In v1.x, each wallet connector used a distinct proprietary contract. In v2.x, all connectors adhere to the common `WalletAdapter` interface.

**Before (v1.x):**
```typescript
import { FreighterConnector } from 'split-sdk';
const wallet = new FreighterConnector();
await wallet.requestAccess();
```

**After (v2.x):**
```typescript
import { FreighterAdapter } from 'split-sdk';
const wallet = new FreighterAdapter();
const address = await wallet.connect();
```

#### BigInt Strictness for Token Amounts
All stroop/amount calculations have moved from `number` to `bigint` to prevent floating-point precision loss.

**Before (v1.x):**
```typescript
client.createInvoice({ amount: 1000000 });
```

**After (v2.x):**
```typescript
client.createInvoice({ amount: 1000000n });
```

---

## Migrating from v2.x to v3.x

> **Placeholder:** v3.x has not been released yet. This section will be expanded with
> breaking changes, step-by-step instructions, and code examples once v3.0.0 ships.

### Breaking Changes

_To be announced._

### Step-by-Step Migration

_To be announced._

### Code Examples

_To be announced._

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
| --- | --- | --- |
| `TypeError: wallet.requestAccess is not a function` | Still using a v1 connector | Switch to `WalletAdapter.connect()` |
| `TypeError: Cannot mix BigInt and other types` | Numeric amount passed where `bigint` is required | Append `n` or wrap with `BigInt(...)` |
| `ConfigError: unknown environment key` | v1 environment schema in use | Re-audit `process.env` against the v2 schema |
| `stellar-split-sdk-migrate` exits with code `2` | Unresolved breaking changes detected | Fix the reported call sites and re-run |
| `stellar-split-sdk-migrate` exits with code `3` | Invalid `--from`/`--to` version pair | Use a supported adjacent major version pair |

---

## Validation

Validate a migration automatically with the `stellar-split-sdk-migrate` CLI:

```bash
npx stellar-split-sdk-migrate --from 1 --to 2
```

**Exit codes:**

| Code | Meaning | Action |
| --- | --- | --- |
| `0` | No breaking changes detected | Migration complete |
| `1` | Unexpected internal error | Re-run with `--verbose` and report a bug |
| `2` | Unresolved breaking changes found | Fix the reported call sites and re-run |
| `3` | Invalid `--from`/`--to` version pair | Use a supported adjacent major version pair |

A clean run (exit code `0`) is required before opening a migration PR.

---

## Progress Tracking

Tick off each item as you complete it. Copy this checklist into your migration PR.

### v1.x → v2.x

- [ ] Upgraded to `split-sdk@^2`
- [ ] Replaced deprecated wallet connect methods with the unified `WalletAdapter.connect()`
- [ ] Converted numerical Stroop balance inputs to `bigint`
- [ ] Audited existing `process.env` references for the new SDK environment config schema
- [ ] `stellar-split-sdk-migrate --from 1 --to 2` exits with code `0`
- [ ] Full test suite passes with `npm test`

### v2.x → v3.x

- [ ] _Pending v3.x release_
=======
