import { Keypair } from "@stellar/stellar-sdk";
import type { Signer } from "../signer.js";

/**
 * {@link Signer} backed by an in-memory {@link Keypair} from
 * `@stellar/stellar-sdk`.
 *
 * Useful for local development and for the common case where the secret seed
 * already lives in the process (e.g. loaded from an environment variable).
 */
export class KeypairSigner implements Signer {
  /** The wrapped keypair. */
  readonly keypair: Keypair;

  constructor(keypair: Keypair) {
    this.keypair = keypair;
  }

  /**
   * Signs `txHash` with the wrapped keypair, producing a raw 64-byte ed25519
   * signature verifiable by `Keypair.verify(txHash, signature, publicKey)`.
   */
  async sign(txHash: Buffer): Promise<Buffer> {
    return Buffer.from(this.keypair.sign(txHash));
  }
}
