/**
 * Pluggable Signing Key Vault Adapter (issue #589)
 *
 * A narrow contract that decouples transaction signing from key storage so
 * callers can inject any backend conforming to {@link Signer} — a hardware
 * security module, a cloud KMS, or an AES-encrypted keystore — without
 * modifying SDK internals.
 */

/**
 * Produces an ed25519 signature over a transaction hash.
 *
 * The input is the raw 32-byte transaction hash (the same bytes produced by
 * `Transaction.hash()` / `signatureBase()`); the returned value is the raw
 * 64-byte ed25519 signature that can be verified with
 * `Keypair.verify(txHash, signature)` against the corresponding public key.
 */
export interface Signer {
  sign(txHash: Buffer): Promise<Buffer>;
}
