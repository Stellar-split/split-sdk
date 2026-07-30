import { rpc as SorobanRpc } from "@stellar/stellar-sdk";

export interface ValidationResult {
  valid: boolean;
  configured: string;
  reported: string;
  mismatch: boolean;
}

export class NetworkPassphraseValidator {
  /**
   * Validates that the local passphrase matches the remote Soroban RPC node's network.
   */
  static async validate(configured: string, rpcUrl: string): Promise<ValidationResult> {
    try {
      const server = new SorobanRpc.Server(rpcUrl);
      const networkInfo = await server.getNetwork();
      const reported = networkInfo.passphrase;

      const isValid = configured === reported;

      return {
        valid: isValid,
        configured,
        reported,
        mismatch: !isValid
      };
    } catch (error) {
      // If RPC fails, we return invalid but mismatch false (since we don't know the reported value)
      return {
        valid: false,
        configured,
        reported: "unknown",
        mismatch: false
      };
    }
  }
}
