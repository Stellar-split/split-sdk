import { createCipheriv, createDecipheriv, pbkdf2, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { Keypair } from "@stellar/stellar-sdk";
import type { Signer } from "../signer.js";

/**
 * Options for {@link EncryptedFileSigner}.
 */
export interface EncryptedFileSignerOptions {
  /**
   * AES-256 key (exactly 32 bytes) used to decrypt the key file.
   * In production this should be derived from a passphrase or fetched from a
   * secrets manager; it must never be stored next to the encrypted file.
   */
  aesKey: Buffer | Uint8Array;
}

const BEGIN_BLOCK = "-----BEGIN SPLIT ENCRYPTED SIGNING KEY-----";
const END_BLOCK = "-----END SPLIT ENCRYPTED SIGNING KEY-----";

const SECRET_BEGIN = "-----BEGIN STELLAR SIGNING KEY-----";
const SECRET_END = "-----END STELLAR SIGNING KEY-----";

const GCM_IV_LENGTH = 12;
const GCM_TAG_LENGTH = 16;

/**
 * Encrypts a Stellar secret seed (`S...` string) with AES-256-GCM and returns
 * a PEM-style payload suitable for {@link writeEncryptedSigningKeyFile}.
 *
 * The payload is `iv || authTag || ciphertext` base64-encoded inside PEM
 * markers. The plaintext is itself a PEM block containing the seed, so the
 * file can be inspected without ever exposing the raw key material.
 */
export function encryptSigningKeyToPem(secret: string, aesKey: Buffer | Uint8Array): string {
  const key = Buffer.from(aesKey);
  if (key.length !== 32) {
    throw new Error("EncryptedFileSigner: aesKey must be exactly 32 bytes");
  }
  const iv = randomBytes(GCM_IV_LENGTH);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const plaintext = Buffer.from(`${SECRET_BEGIN}\n${secret}\n${SECRET_END}\n`, "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const payload = Buffer.concat([Buffer.from(iv), cipher.getAuthTag(), ciphertext]);
  return `${BEGIN_BLOCK}\n${payload.toString("base64").replace(/(.{64})/g, "$1\n").trim()}\n${END_BLOCK}\n`;
}

/**
 * Writes an AES-256-GCM encrypted PEM key file to `filePath` for the given
 * secret seed. Test helper and convenience for tooling that provisions
 * encrypted keystores.
 */
export async function writeEncryptedSigningKeyFile(
  filePath: string,
  secret: string,
  aesKey: Buffer | Uint8Array,
): Promise<void> {
  await writeFile(filePath, encryptSigningKeyToPem(secret, aesKey), "utf8");
}

/**
 * {@link Signer} that reads an AES-256-GCM encrypted PEM key file, decrypts it
 * on first use, and holds the derived {@link Keypair} in a {@link WeakRef} so
 * GC pressure can clear it. If the cached keypair has been collected (or
 * {@link clearCache} was called), the next `sign` call re-reads the file.
 */
export class EncryptedFileSigner implements Signer {
  readonly filePath: string;
  private readonly aesKey: Buffer;
  /** Weak reference to the decrypted keypair — cleared by GC or clearCache(). */
  private cachedKeypairRef: WeakRef<Keypair> | null = null;
  /** Promise-based lock serialising key rotation and sign operations. */
  private _rotationLock: Promise<void> = Promise.resolve();

  constructor(filePath: string, options: EncryptedFileSignerOptions) {
    this.filePath = filePath;
    this.aesKey = Buffer.from(options.aesKey);
    if (this.aesKey.length !== 32) {
      throw new Error("EncryptedFileSigner: aesKey must be exactly 32 bytes");
    }
  }

  /**
   * Drops the cached keypair so the next {@link sign} call re-reads and
   * re-decrypts the key file. Useful after key rotation, and mirrors the
   * behavior of the WeakRef being collected under GC pressure.
   */
  clearCache(): void {
    this.cachedKeypairRef = null;
  }

  /**
   * Rotates the encrypted signing key to a new file.
   *
   * The new file is loaded and validated before the in-memory state is
   * replaced. A promise-based lock ensures that:
   * - Signing operations already in flight complete with the old key.
   * - Only one rotation is in progress at a time.
   * - All new signing operations after rotation use the new key.
   *
   * @param newKeyFilePath Path to the new encrypted PEM key file.
   * @param passphrase Passphrase used to derive the AES-256 decryption key.
   */
  async rotateKey(newKeyFilePath: string, passphrase: string): Promise<void> {
    const previousLock = this._rotationLock;

    let resolveRotation!: () => void;
    this._rotationLock = new Promise<void>((resolve) => {
      resolveRotation = resolve;
    });

    try {
      await previousLock;
      const newAesKey = await this._deriveKey(passphrase);
      const newKeypair = await this._loadKeypairFromFile(newKeyFilePath, newAesKey);

      this.filePath = newKeyFilePath;
      this.aesKey = newAesKey;
      this.cachedKeypairRef = new WeakRef(newKeypair);
    } finally {
      resolveRotation();
    }
  }

  async sign(txHash: Buffer): Promise<Buffer> {
    const keypair = await this._getKeypair();
    return Buffer.from(keypair.sign(txHash));
  }

  private async _getKeypair(): Promise<Keypair> {
    const cached = this.cachedKeypairRef?.deref();
    if (cached) return cached;
    await this._rotationLock;
    const cachedAgain = this.cachedKeypairRef?.deref();
    if (cachedAgain) return cachedAgain;
    const keypair = await this._loadKeypair();
    this.cachedKeypairRef = new WeakRef(keypair);
    return keypair;
  }

  private async _loadKeypair(): Promise<Keypair> {
    return this._loadKeypairFromFile(this.filePath, this.aesKey);
  }

  private async _loadKeypairFromFile(filePath: string, aesKey: Buffer): Promise<Keypair> {
    const content = await readFile(filePath, "utf8");
    const { iv, authTag, ciphertext } = parseEncryptedPayload(content);
    const decipher = createDecipheriv("aes-256-gcm", aesKey, iv);
    decipher.setAuthTag(authTag);
    const plaintext = Buffer.concat([
      decipher.update(ciphertext),
      decipher.final(),
    ]);
    const secret = extractSecretFromPem(plaintext.toString("utf8"));
    return Keypair.fromSecret(secret);
  }

  private async _deriveKey(passphrase: string): Promise<Buffer> {
    return new Promise<Buffer>((resolve, reject) => {
      pbkdf2(
        passphrase,
        "split-sdk-rotation-salt",
        100_000,
        32,
        "sha256",
        (err, derivedKey) => {
          if (err) reject(err);
          else resolve(Buffer.from(derivedKey));
        },
      );
    });
  }
}

function parseEncryptedPayload(content: string): {
  iv: Buffer;
  authTag: Buffer;
  ciphertext: Buffer;
} {
  const match = content.match(
    new RegExp(`${escapeRegExp(BEGIN_BLOCK)}\\s*([A-Za-z0-9+/=\\s]+?)\\s*${escapeRegExp(END_BLOCK)}`),
  );
  if (!match?.[1]) {
    throw new Error("EncryptedFileSigner: file does not contain a valid SPLIT ENCRYPTED SIGNING KEY block");
  }
  const payload = Buffer.from(match[1].replace(/\s+/g, ""), "base64");
  if (payload.length < GCM_IV_LENGTH + GCM_TAG_LENGTH + 1) {
    throw new Error("EncryptedFileSigner: encrypted payload is truncated");
  }
  return {
    iv: payload.subarray(0, GCM_IV_LENGTH),
    authTag: payload.subarray(GCM_IV_LENGTH, GCM_IV_LENGTH + GCM_TAG_LENGTH),
    ciphertext: payload.subarray(GCM_IV_LENGTH + GCM_TAG_LENGTH),
  };
}

function extractSecretFromPem(plaintext: string): string {
  const match = plaintext.match(
    new RegExp(`${escapeRegExp(SECRET_BEGIN)}\\s*([A-Za-z0-9]+)\\s*${escapeRegExp(SECRET_END)}`),
  );
  if (!match?.[1]) {
    throw new Error("EncryptedFileSigner: decrypted payload does not contain a STELLAR SIGNING KEY block");
  }
  const secret = match[1].trim();
  // Validate eagerly so a wrong-key decrypt (garbage plaintext) surfaces as a
  // clear error rather than a confusing downstream failure.
  Keypair.fromSecret(secret);
  return secret;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
