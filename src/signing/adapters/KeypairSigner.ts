import { Keypair } from "@stellar/stellar-sdk";
import type { Signer } from "../signer.js";
import { InvalidKeypairError } from "../../errors.js";

/**
 * {@link Signer} backed by an in-memory {@link Keypair} from
 * `@stellar/stellar-sdk` or a raw Stellar secret key string.
 *
 * Useful for local development and for the common case where the secret seed
 * already lives in the process (e.g. loaded from an environment variable).
 */
export class KeypairSigner implements Signer {
  /** The wrapped keypair. */
  readonly keypair: Keypair;

  constructor(secretOrKeypair: Keypair | string) {
    if (typeof secretOrKeypair === "string") {
      try {
        this.keypair = Keypair.fromSecret(secretOrKeypair);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new InvalidKeypairError(`Invalid secret key format: ${message}`);
      }
    } else if (
      secretOrKeypair instanceof Keypair ||
      (secretOrKeypair &&
        typeof secretOrKeypair === "object" &&
        typeof (secretOrKeypair as Keypair).canSign === "function" &&
        typeof (secretOrKeypair as Keypair).sign === "function")
    ) {
      if (!secretOrKeypair.canSign()) {
        throw new InvalidKeypairError(
          "Keypair does not contain a secret key for signing",
        );
      }
      this.keypair = secretOrKeypair as Keypair;
    } else {
      throw new InvalidKeypairError(
        "Invalid secret key: expected a Stellar secret key string or Keypair instance",
      );
    }
  }

  /**
   * Signs `txHash` with the wrapped keypair, producing a raw 64-byte ed25519
   * signature verifiable by `Keypair.verify(txHash, signature, publicKey)`.
   */
  async sign(txHash: Buffer): Promise<Buffer> {
    return Buffer.from(this.keypair.sign(txHash));
  }
}

