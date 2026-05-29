# Changelog

All notable changes to this project will be documented in this file.

## Unreleased

### Features

- add request deduplication for getInvoice() (`b09519a`)
- Add multi-network support (`ec092ca`)
- Build Soroban event replayer (`d8ba854`)
- Add invoice export formatter (`e1887d6`)
- Implement transaction queue (`464f3ff`)
- Build full TypeScript declaration file (`b477dac`)
- Add vesting schedule calculator (`dc152e8`)
- Implement group invoice management (`0fea394`)
- Build invoice search client (`8423d76`)
- Add contract upgrade detection (`10e2bb3`)
- Add SDK telemetry module (`f88c6d0`)
- Add batch invoice creation (`b45eb0c`)
- Add optimistic update helpers (`15fad20`)
- Implement recurring invoice management (`e8d74fe`)
- Add RPC health checker (`49b16f0`)
- Build invoice template client methods (`af14e4f`)
- Add USDC balance poller (`65fbb92`)
- add StellarSplitClient, Freighter wallet adapter, and public index (`3e4ad8e`)
- add Invoice/Payment/Recipient types and USDC amount utilities (`012b9a2`)

### Bug Fixes

- update to freighter-api v3 getAddress, stellar-sdk rpc namespace, and address regex (`69ce017`)

### Chores

- add .gitignore (`f4852ec`)
- add vitest unit tests, npm publish workflow, and CONTRIBUTING guide (`27ad223`)
- init @stellar-split/sdk package with tsup build and MIT license (`0f77a54`)
