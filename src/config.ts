/**
 * Multi-Network Environment Configuration for StellarSplit SDK.
 */

export enum NetworkEnvironment {
  MAINNET = "MAINNET",
  TESTNET = "TESTNET",
  FUTURENET = "FUTURENET",
  CUSTOM = "CUSTOM",
}

export interface NetworkPreset {
  horizonUrl: string;
  rpcUrl: string;
  networkPassphrase: string;
}

export const NETWORK_PRESETS: Record<
  Exclude<NetworkEnvironment, NetworkEnvironment.CUSTOM>,
  NetworkPreset
> = {
  [NetworkEnvironment.MAINNET]: {
    horizonUrl: "https://horizon.stellar.org",
    rpcUrl: "https://soroban-rpc.mainnet.stellar.org",
    networkPassphrase: "Public Global Stellar Network ; September 2015",
  },
  [NetworkEnvironment.TESTNET]: {
    horizonUrl: "https://horizon-testnet.stellar.org",
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; July 2015",
  },
  [NetworkEnvironment.FUTURENET]: {
    horizonUrl: "https://horizon-futurenet.stellar.org",
    rpcUrl: "https://rpc-futurenet.stellar.org",
    networkPassphrase: "Test SDF Future Network ; October 2022",
  },
};
