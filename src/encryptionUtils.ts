/**
 * Encryption utilities with safe key management and rotation.
 *
 * Uses the Web Crypto API (AES-256-GCM with PBKDF2 key derivation) so the same
 * implementation works in browsers and in Node.js. Sensitive values are never
 * logged: only key versions, sizes and operation counters are tracked.
 */

/** Envelope format version, bumped only on breaking format changes. */
export const ENCRYPTION_ENVELOPE_VERSION = 1 as const;
/** AES-GCM key length in bytes. */
export const ENCRYPTION_KEY_BYTES = 32;
/** Recommended GCM IV length in bytes. */
export const ENCRYPTION_IV_BYTES = 12;

/** Encrypted payload including the key version needed to decrypt it. */
export interface EncryptedEnvelope {
  version: typeof ENCRYPTION_ENVELOPE_VERSION;
  keyVersion: number;
  iv: string;
  ciphertext: string;
  tag: string;
}

/** Bounded record of an encryption operation (never includes key material). */
export interface EncryptionEvent {
  timestamp: number;
  operation: "encrypt" | "decrypt" | "reencrypt" | "key:add" | "key:rotate" | "key:retire";
  keyVersion: number;
  success: boolean;
}

/** Counters describing encryptor activity. */
export interface EncryptionStats {
  encrypted: number;
  decrypted: number;
  reencrypted: number;
  failures: number;
  eventsTracked: number;
  eventsTruncated: boolean;
}

/** Base error type for this module. */
export class EncryptionUtilityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EncryptionUtilityError";
  }
}

/** Thrown when a key version is unknown or has been destroyed. */
export class KeyNotFoundError extends EncryptionUtilityError {
  constructor(public readonly version: number) {
    super(`No encryption key registered for version ${version}`);
    this.name = "KeyNotFoundError";
  }
}

/** Thrown when authenticated decryption fails (tampering or wrong key). */
export class DecryptionFailedError extends EncryptionUtilityError {
  constructor(public readonly keyVersion: number, cause?: unknown) {
    super(`Failed to decrypt payload with key version ${keyVersion}`);
    this.name = "DecryptionFailedError";
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}

function assertKeyLength(key: Uint8Array): void {
  if (key.length !== ENCRYPTION_KEY_BYTES) {
    throw new EncryptionUtilityError(
      `Encryption keys must be ${ENCRYPTION_KEY_BYTES} bytes, received ${key.length}`,
    );
  }
}

/** Derive a 256-bit AES key from a passphrase using PBKDF2-SHA256. */
export async function deriveEncryptionKey(
  passphrase: string,
  salt: Uint8Array,
  iterations = 100_000,
  crypto: Crypto = globalThis.crypto,
): Promise<Uint8Array> {
  if (salt.length < 16) {
    throw new EncryptionUtilityError("PBKDF2 salt must be at least 16 bytes");
  }
  if (iterations < 1) {
    throw new EncryptionUtilityError("PBKDF2 iterations must be positive");
  }

  const material = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(passphrase),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations, hash: "SHA-256" },
    material,
    ENCRYPTION_KEY_BYTES * 8,
  );
  return new Uint8Array(bits);
}

/** Generate a cryptographically random salt of the requested size. */
export function generateSalt(bytes = 16, crypto: Crypto = globalThis.crypto): Uint8Array {
  return crypto.getRandomValues(new Uint8Array(bytes));
}

interface StoredKey {
  version: number;
  key: Uint8Array;
  createdAt: number;
  retired: boolean;
}

/**
 * Versioned key registry. Retired keys remain available for decryption but
 * can never be selected for new encryption operations.
 */
export class EncryptionKeyManager {
  private readonly keys = new Map<number, StoredKey>();
  private activeVersion: number | null = null;

  constructor(private readonly crypto: Crypto = globalThis.crypto) {}

  /** Register a key version. */
  addKey(version: number, key: Uint8Array): void {
    if (!Number.isInteger(version) || version <= 0) {
      throw new EncryptionUtilityError("Key version must be a positive integer");
    }
    assertKeyLength(key);
    if (this.keys.has(version)) {
      throw new EncryptionUtilityError(`Key version ${version} already exists`);
    }
    this.keys.set(version, {
      version,
      key: new Uint8Array(key),
      createdAt: Date.now(),
      retired: false,
    });
    if (this.activeVersion === null) {
      this.activeVersion = version;
    }
  }

  /** Select the active key for new encryption operations. */
  setActiveKey(version: number): void {
    const entry = this.keys.get(version);
    if (!entry) {
      throw new KeyNotFoundError(version);
    }
    if (entry.retired) {
      throw new EncryptionUtilityError(`Key version ${version} is retired and cannot be activated`);
    }
    this.activeVersion = version;
  }

  getActiveVersion(): number {
    if (this.activeVersion === null) {
      throw new EncryptionUtilityError("No active encryption key configured");
    }
    return this.activeVersion;
  }

  /** Retrieve a key for decryption, including retired keys. */
  getKey(version: number): Uint8Array {
    const entry = this.keys.get(version);
    if (!entry) {
      throw new KeyNotFoundError(version);
    }
    return new Uint8Array(entry.key);
  }

  isRetired(version: number): boolean {
    return this.keys.get(version)?.retired ?? false;
  }

  versions(): number[] {
    return [...this.keys.keys()].sort((a, b) => a - b);
  }

  /** Mark a key retired; existing ciphertexts remain decryptable. */
  retireKey(version: number): void {
    const entry = this.keys.get(version);
    if (!entry) {
      throw new KeyNotFoundError(version);
    }
    if (version === this.activeVersion) {
      throw new EncryptionUtilityError("Retire the active key only after rotating to a new one");
    }
    entry.retired = true;
  }

  /** Atomically add a new key, activate it and retire the previous key. */
  rotate(newVersion: number, newKey: Uint8Array): number {
    const previous = this.activeVersion;
    this.addKey(newVersion, newKey);
    this.setActiveKey(newVersion);
    if (previous !== null) {
      this.keys.get(previous)!.retired = true;
    }
    return previous ?? newVersion;
  }

  /** Number of registered keys (active and retired). */
  get size(): number {
    return this.keys.size;
  }

  /** Generate a random 256-bit key using the configured Crypto implementation. */
  generateKeyBytes(): Uint8Array {
    return this.crypto.getRandomValues(new Uint8Array(ENCRYPTION_KEY_BYTES));
  }
}

/** Configuration for {@link SdkEncryptor}. */
export interface EncryptorOptions {
  crypto?: Crypto;
  /** Maximum number of retained operation events. Defaults to 100. */
  maxTrackedEvents?: number;
}

/**
 * AES-256-GCM string/JSON encryptor with versioned key management, rotation
 * support and bounded operation tracking.
 */
export class SdkEncryptor {
  private readonly crypto: Crypto;
  private readonly events: EncryptionEvent[] = [];
  private readonly maxTrackedEvents: number;
  private eventsTruncated = false;
  private counters = { encrypted: 0, decrypted: 0, reencrypted: 0, failures: 0 };

  constructor(
    public readonly keys: EncryptionKeyManager,
    options: EncryptorOptions = {},
  ) {
    this.crypto = options.crypto ?? globalThis.crypto;
    this.maxTrackedEvents = options.maxTrackedEvents ?? 100;
  }

  /** Encrypt UTF-8 text into a versioned envelope. */
  async encrypt(text: string): Promise<EncryptedEnvelope> {
    const keyVersion = this.keys.getActiveVersion();
    try {
      const key = await this.importKey(keyVersion);
      const iv = this.crypto.getRandomValues(new Uint8Array(ENCRYPTION_IV_BYTES));
      const additionalData = this.additionalData(keyVersion);
      const encrypted = await this.crypto.subtle.encrypt(
        { name: "AES-GCM", iv: iv as BufferSource, additionalData: additionalData as BufferSource },
        key,
        new TextEncoder().encode(text),
      );
      const raw = new Uint8Array(encrypted);
      const tag = raw.slice(raw.length - 16);

      this.track("encrypt", keyVersion, true);
      this.counters.encrypted += 1;
      return {
        version: ENCRYPTION_ENVELOPE_VERSION,
        keyVersion,
        iv: bytesToBase64(iv),
        ciphertext: bytesToBase64(raw.slice(0, raw.length - 16)),
        tag: bytesToBase64(tag),
      };
    } catch (error) {
      this.track("encrypt", keyVersion, false);
      this.counters.failures += 1;
      throw error;
    }
  }

  /** Decrypt an envelope back to UTF-8 text. */
  async decrypt(envelope: EncryptedEnvelope): Promise<string> {
    const { keyVersion } = envelope;
    try {
      if (envelope.version !== ENCRYPTION_ENVELOPE_VERSION) {
        throw new EncryptionUtilityError(`Unsupported envelope version ${envelope.version}`);
      }
      const key = await this.importKey(keyVersion);
      const iv = base64ToBytes(envelope.iv);
      const ciphertext = base64ToBytes(envelope.ciphertext);
      const tag = base64ToBytes(envelope.tag);
      const combined = new Uint8Array(ciphertext.length + tag.length);
      combined.set(ciphertext, 0);
      combined.set(tag, ciphertext.length);

      const decrypted = await this.crypto.subtle.decrypt(
        {
          name: "AES-GCM",
          iv: iv as BufferSource,
          additionalData: this.additionalData(keyVersion) as BufferSource,
        },
        key,
        combined,
      );
      this.track("decrypt", keyVersion, true);
      this.counters.decrypted += 1;
      return new TextDecoder().decode(decrypted);
    } catch (error) {
      this.track("decrypt", keyVersion, false);
      this.counters.failures += 1;
      if (error instanceof EncryptionUtilityError) {
        throw error;
      }
      throw new DecryptionFailedError(keyVersion, error);
    }
  }

  /** Encrypt a JSON-serializable value. */
  async encryptJson(value: unknown): Promise<EncryptedEnvelope> {
    return this.encrypt(JSON.stringify(value));
  }

  /** Decrypt an envelope produced by {@link encryptJson}. */
  async decryptJson<T>(envelope: EncryptedEnvelope): Promise<T> {
    return JSON.parse(await this.decrypt(envelope)) as T;
  }

  /**
   * Re-encrypt an envelope with the current active key. Used after rotation to
   * migrate old ciphertexts without ever exposing plaintext to logs.
   */
  async reencrypt(envelope: EncryptedEnvelope): Promise<EncryptedEnvelope> {
    const keyVersion = this.keys.getActiveVersion();
    try {
      const plaintext = await this.decrypt(envelope);
      const migrated = await this.encrypt(plaintext);
      this.track("reencrypt", keyVersion, true);
      this.counters.reencrypted += 1;
      return migrated;
    } catch (error) {
      this.track("reencrypt", keyVersion, false);
      this.counters.failures += 1;
      throw error;
    }
  }

  /** Copy of operation counters and tracking status. */
  stats(): EncryptionStats {
    return {
      ...this.counters,
      eventsTracked: this.events.length,
      eventsTruncated: this.eventsTruncated,
    };
  }

  /** Copy of the bounded, key-material-free operation trail. */
  eventsTrail(): EncryptionEvent[] {
    return this.events.map((event) => ({ ...event }));
  }

  private async importKey(version: number): Promise<CryptoKey> {
    const raw = this.keys.getKey(version);
    return this.crypto.subtle.importKey("raw", raw as BufferSource, { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  }

  /** Bind the version header to the ciphertext so it cannot be swapped. */
  private additionalData(keyVersion: number): Uint8Array {
    return new TextEncoder().encode(`stellar-split:v${ENCRYPTION_ENVELOPE_VERSION}:k${keyVersion}`);
  }

  private track(
    operation: EncryptionEvent["operation"],
    keyVersion: number,
    success: boolean,
  ): void {
    if (this.events.length >= this.maxTrackedEvents) {
      this.events.shift();
      this.eventsTruncated = true;
    }
    this.events.push({ timestamp: Date.now(), operation, keyVersion, success });
  }
}
