import { rpc as SorobanRpc } from "@stellar/stellar-sdk";

/** Map of known network passphrases to their labels. */
export const KNOWN_NETWORK_PASSPHRASES = {
  "Public Global Stellar Network ; September 2015": "mainnet",
  "Test SDF Network ; September 2015": "testnet",
  "Future Network ; September 2015": "futurenet",
} as const;

export type KnownNetworkLabel = typeof KNOWN_NETWORK_PASSPHRASES[keyof typeof KNOWN_NETWORK_PASSPHRASES];

export interface ValidationResult {
  valid: boolean;
  configured: string;
  reported: string;
  mismatch: boolean;
  /** If the passphrase is a known network, the network label. */
  networkLabel?: KnownNetworkLabel;
}

export interface PassphraseValidationOptions {
  /** Allow unknown (non-standard) passphrases. Defaults to false. */
  allowUnknown?: boolean;
}

export class NetworkPassphraseValidator {
  /**
   * Validates a passphrase against the known networks list.
   * Rejects unknown passphrases unless allowUnknown is set to true.
   *
   * @param passphrase - The passphrase to validate
   * @param options - Validation options
   * @returns Validation result with network label if it's a known network
   */
  static validatePassphrase(
    passphrase: string,
    options: PassphraseValidationOptions = {},
  ): ValidationResult {
    const networkLabel = Object.entries(KNOWN_NETWORK_PASSPHRASES).find(
      ([p]) => p === passphrase,
    )?.[1];

    const isKnown = networkLabel !== undefined;
    const isValid = isKnown || (options.allowUnknown ?? false);

    return {
      valid: isValid,
      configured: passphrase,
      reported: passphrase,
      mismatch: false,
      networkLabel,
    };
  }

  /**
   * Validates that the local passphrase matches the remote Soroban RPC node's network.
   */
  static async validate(
    configured: string,
    rpcUrl: string,
    options: PassphraseValidationOptions = {},
  ): Promise<ValidationResult> {
    try {
      const server = new SorobanRpc.Server(rpcUrl);
      const networkInfo = await server.getNetwork();
      const reported = networkInfo.passphrase;

      const isMatch = configured === reported;
      const configuredLabel = Object.entries(KNOWN_NETWORK_PASSPHRASES).find(
        ([p]) => p === configured,
      )?.[1];
      const reportedLabel = Object.entries(KNOWN_NETWORK_PASSPHRASES).find(
        ([p]) => p === reported,
      )?.[1];

      const isConfiguredKnown = configuredLabel !== undefined;
      const isReportedKnown = reportedLabel !== undefined;

      // Valid if: they match, OR (configured is known and reported is known and they don't match)
      const isValid =
        isMatch ||
        (isConfiguredKnown && isReportedKnown && !isMatch) ||
        (options.allowUnknown ?? false);

      return {
        valid: isValid,
        configured,
        reported,
        mismatch: !isMatch,
        networkLabel: configuredLabel,
      };
    } catch (error) {
      // If RPC fails, validate passphrase only
      return this.validatePassphrase(configured, options);
    }
  }
}
