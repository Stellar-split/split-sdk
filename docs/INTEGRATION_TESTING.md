# Integration Testing Guide for StellarSplit SDK

This guide details best practices, patterns, and architectural principles for writing integration tests within the StellarSplit SDK.

---

## 1. Overview: Integration vs. Unit Tests

- **Unit Tests**: Focus on isolated business logic, utility algorithms, mathematical calculations (e.g., fee computation, input sanitization), and pure functions without relying on external dependencies or network simulations.
- **Integration Tests**: Verify interactions across multiple SDK subsystems, transaction assembly pipelines, RPC/Horizon client abstractions, caching layers, and wallet adapters.

---

## 2. Directory & File Naming Conventions

- Mocked unit/integration tests live in `test/` as `test/<feature>.test.ts` (camelCase or PascalCase matching the module).
- Live-network (testnet) integration tests live in `tests/integration/` with helpers in `tests/integration/utils/` (`friendbot.ts`, `deploy.ts`, `stellarDebug.ts`).
- Vitest picks up `test/**/*.test.ts` and `tests/**/*.test.ts` (see `vitest.config.ts`).

---

## 3. Mocking Strategy

### Mocking the Horizon Client & Soroban RPC
Avoid hitting live public RPC endpoints in CI tests. Use `vi.fn()` or simulated response fixtures:

```typescript
import { vi } from 'vitest';

export function createMockRpcClient() {
  return {
    sendTransaction: vi.fn().mockResolvedValue({
      status: 'SUCCESS',
      hash: 'mock-tx-hash-64-bytes-stellar',
      latestLedger: 1234567,
    }),
    getAccount: vi.fn().mockResolvedValue({
      id: 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7',
      sequence: '100',
    }),
  };
}
```

### Mocking Wallet Providers
When verifying transaction signing pipelines:

```typescript
import type { WalletAdapter } from '../src/types.js';

export class MockWalletAdapter implements WalletAdapter {
  readonly name = 'MockWallet';
  connected = true;

  async connect(): Promise<string> {
    return 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN7';
  }

  async signTransaction(xdr: string): Promise<string> {
    return `signed-${xdr}`;
  }

  disconnect(): void {
    this.connected = false;
  }

  isConnected(): boolean {
    return this.connected;
  }

  onAccountChange(_cb: (address: string | null) => void): () => void {
    return () => {};
  }
}
```

---

## 4. End-to-End Payment Flow Test Example

```typescript
import { describe, it, expect } from 'vitest';
// Define MockWalletAdapter inline (see section 3) or in a local helper file.
import { MockWalletAdapter } from './helpers/mockWallet.js';

describe('Payment Orchestration Flow', () => {
  it('signs and verifies an invoice payment batch', async () => {
    const wallet = new MockWalletAdapter();
    const address = await wallet.connect();
    expect(address).toMatch(/^G[A-Z2-7]{55}$/);

    const unsignedXdr = 'AAAA...payload';
    const signedXdr = await wallet.signTransaction(unsignedXdr);
    expect(signedXdr).toContain('signed-');
  });
});
```

---

## 5. Testnet Setup

Live tests in `tests/integration/` skip themselves unless configured:

```bash
export STELLAR_NETWORK=testnet
export STELLAR_SPLIT_CONTRACT_ID=<deployed contract id>
```

- Accounts are funded through Friendbot via `fundAccount` from `tests/integration/utils/friendbot.ts`.
- `deployFreshContract` from `tests/integration/utils/deploy.ts` deploys an isolated contract per suite so tests do not share state.
- Use a fresh `Keypair.random()` per test and never reuse mainnet keys.

## 6. Running Integration Tests

`npm test` only runs a small core subset (`client`, `retryPolicy`, `network-environment`). Use the dedicated scripts:

```bash
npm run test:integration        # live testnet tests in tests/integration
npm run test:all                # everything in test/ and tests/
npx vitest run test/batchOperations.test.ts   # one file
npx vitest run -t "pay"         # tests whose name matches
```

## 7. Debugging Tips

- Run one file with `npx vitest run <file>` and use `it.only` while iterating; remove it before committing.
- For testnet failures, use `getTxDebug` from `tests/integration/utils/stellarDebug.ts` to inspect the failed transaction's result.
- Enable SDK debug logging (see [DEBUG_LOGGING.md](../DEBUG_LOGGING.md)) to trace RPC calls.
- Testnet is rate limited and occasionally resets; if a suite fails only on testnet, re-fund the account and redeploy the contract before suspecting the SDK.
- Fake timers (`vi.useFakeTimers()`) must be restored with `vi.useRealTimers()` in `afterEach`, or later tests hang.

## 8. Test Template

```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Keypair } from '@stellar/stellar-sdk';
import { StellarSplitClient } from '../src/client.js';

describe('<Feature> integration', () => {
  let source: string;

  beforeEach(() => {
    source = Keypair.random().publicKey();
    // arrange: create mocks / fixtures
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('does <expected behaviour> when <condition>', async () => {
    // act
    // assert
    expect(source).toMatch(/^G[A-Z2-7]{55}$/);
  });
});
```
