#12 Build WalletConnect adapter
Repo Avatar
Stellar-split/split-sdk
Label: complexity: high
Points: 200

Description
The SDK only supports Freighter for signing. This issue adds a WalletConnect adapter in src/adapters/walletconnect.ts implementing a WalletAdapter interface, enabling mobile wallet users to sign transactions via WalletConnect without changing any other SDK code.

Technical Context
Involves a new src/adapters/walletconnect.ts and src/adapters/types.ts. Define WalletAdapter = { getAddress(): Promise; signTransaction(xdr, network): Promise }. The WalletConnect adapter implements this using @walletconnect/sign-client. StellarSplitClient accepts optional adapter?: WalletAdapter.

Acceptance Criteria
 WalletAdapter interface defined in src/adapters/types.ts
 WalletConnectAdapter implements WalletAdapter
 StellarSplitClientConfig accepts optional adapter: WalletAdapter
 When adapter provided, signing routes through it instead of Freighter
 Test mocks WalletAdapter and verifies signing is delegated correctly
 All existing tests pass
 TypeScript strict mode — zero any types