# Stellar testnet integration tests

These tests run against the real Stellar Soroban **testnet**.

Run locally (requires `STELLAR_NETWORK=testnet` and a deployed contract id):

```bash
STELLAR_NETWORK=testnet \
STELLAR_SPLIT_CONTRACT_ID=... \
vitest run tests/integration/**/*.test.ts
```

