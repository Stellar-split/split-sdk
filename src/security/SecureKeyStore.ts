/**
 * In-memory encrypted signing-key store for {@link SplitClient}.
 *
 * Distinct from the full-featured `SecureKeyStore` in `../secureKeyStore.ts`
 * (versioned rotation, access policies, pluggable backends): this one is a
 * minimal store scoped to SplitClient's own signing-key lifecycle.
 */

import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

export interface KeyStoreConfig {
  /** Passphrase used to derive the at-rest encryption key. A random one is generated when omitted. */
  passphrase?: string;
}

export interface KeyUsageEvent {
  keyId: string;
  action: "store" | "rotate";
  timestamp: number;
}

interface EncryptedSecret {
  iv: Buffer;
  ciphertext: Buffer;
  authTag: Buffer;
}

export class SecureKeyStore {
  private readonly encryptionKey: Buffer;
  private readonly secrets = new Map<string, EncryptedSecret>();
  private readonly usageEvents: KeyUsageEvent[] = [];
  private readonly maxEvents = 1000;

  constructor(config?: KeyStoreConfig) {
    const passphrase = config?.passphrase ?? randomBytes(32).toString("hex");
    this.encryptionKey = scryptSync(passphrase, "split-client-key-store", 32);
  }

  storeKey(keyId: string, secret: string): void {
    this.secrets.set(keyId, this._encrypt(secret));
    this._record(keyId, "store");
  }

  rotateKey(keyId: string, newSecret: string): void {
    this.secrets.set(keyId, this._encrypt(newSecret));
    this._record(keyId, "rotate");
  }

  getKey(keyId: string): string | undefined {
    const entry = this.secrets.get(keyId);
    return entry ? this._decrypt(entry) : undefined;
  }

  getUsageEvents(): ReadonlyArray<KeyUsageEvent> {
    return [...this.usageEvents];
  }

  private _encrypt(plaintext: string): EncryptedSecret {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.encryptionKey, iv);
    const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    return { iv, ciphertext, authTag: cipher.getAuthTag() };
  }

  private _decrypt(entry: EncryptedSecret): string {
    const decipher = createDecipheriv("aes-256-gcm", this.encryptionKey, entry.iv);
    decipher.setAuthTag(entry.authTag);
    return Buffer.concat([decipher.update(entry.ciphertext), decipher.final()]).toString("utf8");
  }

  private _record(keyId: string, action: KeyUsageEvent["action"]): void {
    this.usageEvents.push({ keyId, action, timestamp: Date.now() });
    if (this.usageEvents.length > this.maxEvents) {
      this.usageEvents.splice(0, this.usageEvents.length - this.maxEvents);
    }
  }
}
