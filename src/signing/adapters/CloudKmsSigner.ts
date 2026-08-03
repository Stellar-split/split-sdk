import type { Signer } from "../signer.js";

/**
 * Minimal client contract for a cloud KMS (AWS KMS, GCP Cloud KMS, Azure Key
 * Vault, HashiCorp Vault, ...). Implementations are intentionally left to the
 * caller so the SDK carries no vendor SDK dependency and tests can mock the
 * client without touching real KMS credentials.
 */
export interface KmsClient {
  /**
   * Sign `digest` (typically a 32-byte transaction hash) with the key
   * identified by `keyId`, returning the raw signature bytes.
   */
  sign(keyId: string, digest: Buffer): Promise<Buffer>;
}

/**
 * {@link Signer} that delegates signing to an injected {@link KmsClient}.
 *
 * @example
 * ```ts
 * const signer = new CloudKmsSigner(awsKmsClient, "alias/split-signing-key");
 * const signature = await signer.sign(txHash);
 * ```
 */
export class CloudKmsSigner implements Signer {
  readonly kmsClient: KmsClient;
  readonly keyId: string;

  constructor(kmsClient: KmsClient, keyId: string) {
    this.kmsClient = kmsClient;
    this.keyId = keyId;
  }

  async sign(txHash: Buffer): Promise<Buffer> {
    return this.kmsClient.sign(this.keyId, txHash);
  }
}
