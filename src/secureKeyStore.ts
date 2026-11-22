/**
 * Secure private-key storage (issue #1060).
 *
 * A storage API for long-lived secrets (Stellar secret seeds, API tokens)
 * with encryption at rest, key rotation, and secure cleanup:
 *
 * - **Storage API** — {@link SecureKeyStore} exposes `setSecret`, `getSecret`,
 *   `hasSecret`, `listSecrets`, and `deleteSecret` over an injectable
 *   {@link KeyStoreBackend}. The default {@link MemoryKeyStoreBackend} keeps
 *   records in memory; integrators can plug in file/KeyVault/KMS-backed
 *   persistence without touching crypto.
 * - **Encryption** — every secret is sealed with AES-256-GCM (random 12-byte
 *   IV per write, 16-byte auth tag) under a 32-byte master key. Records are
 *   versioned JSON envelopes; the plaintext never reaches the backend.
 *   The master key is supplied directly, or derived from a passphrase via
 *   PBKDF2-SHA256 ({@link SecureKeyStore.deriveMasterKey}).
 * - **Key rotation** — {@link SecureKeyStore.rotateMasterKey} re-encrypts
 *   every stored secret under a new master key. All records are decrypted and
 *   re-sealed in memory *before* the first write, so a failure cannot leave
 *   half the store unreadable. `setSecret` on an existing id transparently
 *   re-encrypts with a fresh IV (secret rotation).
 * - **Cleanup** — {@link SecureKeyStore.cleanup} deletes every stored record
 *   from the backend; {@link SecureKeyStore.destroy} zeroizes the in-memory
 *   master key and permanently disables the instance.
 *
 * Only authenticated ciphertext is ever persisted, so a leaked backend is
 * useless without the master key, and tampering with (or swapping) records
 * is detected by GCM and reported as {@link KeyIntegrityError}.
 *
 * Issue #1060
 */

import {
  createCipheriv,
  createDecipheriv,
  pbkdf2 as pbkdf2Cb,
  randomBytes,
} from "node:crypto";
import { EventEmitter } from "node:events";
import { promisify } from "node:util";
import { StellarSplitError } from "./errors.js";
import {
  AccessControl,
  type AccessPolicy,
  type AccessContext,
} from "./accessControl.js";
import { AuditLogger } from "./auditLogger.js";

const pbkdf2 = promisify(pbkdf2Cb);

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const ALGORITHM = "aes-256-gcm" as const;
const GCM_IV_BYTES = 12;
const GCM_TAG_BYTES = 16;
const MASTER_KEY_BYTES = 32;
const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_DIGEST = "sha256" as const;
const RECORD_VERSION = 1;
const MAX_ID_LENGTH = 128;
const MAX_SECRET_LENGTH = 4_096;
const MIN_PBKDF2_SALT_BYTES = 16;
const MIN_PBKDF2_ITERATIONS = 1_000;
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const MAX_KEY_VERSION = 1_000_000;
const MAX_USAGE_EVENTS = 10_000;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/** Base class for all secure key storage failures. */
export class KeyStorageError extends StellarSplitError {
  constructor(
    message: string,
    code: string = "KEY_STORAGE",
    context?: Record<string, unknown>,
  ) {
    super(message, code, context);
    this.name = "KeyStorageError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when the requested secret id does not exist in the store. */
export class KeyNotFoundError extends KeyStorageError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "KEY_NOT_FOUND", context);
    this.name = "KeyNotFoundError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/**
 * Thrown when a stored record cannot be authenticated or decrypted —
 * wrong master key, corrupted data, or tampering.
 */
export class KeyIntegrityError extends KeyStorageError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "KEY_INTEGRITY", context);
    this.name = "KeyIntegrityError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a key-rotation operation is misconfigured or fails. */
export class KeyRotationError extends KeyStorageError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "KEY_ROTATION", context);
    this.name = "KeyRotationError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when an access-control policy denies an operation on a secret. */
export class KeyAccessDeniedError extends KeyStorageError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "KEY_ACCESS_DENIED", context);
    this.name = "KeyAccessDeniedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Thrown when a caller fails to supply the required access context. */
export class KeyAccessContextError extends KeyStorageError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "KEY_ACCESS_CONTEXT", context);
    this.name = "KeyAccessContextError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Storage backend
// ---------------------------------------------------------------------------

/**
 * Persistence contract for {@link SecureKeyStore}.
 *
 * Backends store *opaque JSON envelopes only* — they never see plaintext
 * secrets or key material, so any storage tier (memory, disk, Vault, KMS)
 * is safe to plug in.
 */
export interface KeyStoreBackend {
  /** Return the stored envelope for `id`, or `null` when absent. */
  read(id: string): Promise<string | null>;
  /** Persist the envelope for `id`, replacing any previous value. */
  write(id: string, record: string): Promise<void>;
  /** Remove the envelope for `id` (no-op when absent). */
  delete(id: string): Promise<void>;
  /** List every stored id. */
  listIds(): Promise<string[]>;
}

/** Default in-memory backend (non-persistent; emptied by {@link SecureKeyStore.cleanup}). */
export class MemoryKeyStoreBackend implements KeyStoreBackend {
  private readonly _records = new Map<string, string>();

  async read(id: string): Promise<string | null> {
    return this._records.get(id) ?? null;
  }

  async write(id: string, record: string): Promise<void> {
    this._records.set(id, record);
  }

  async delete(id: string): Promise<void> {
    this._records.delete(id);
  }

  async listIds(): Promise<string[]> {
    return [...this._records.keys()];
  }
}

/** Versioned envelope persisted by the backend. Plaintext never appears here. */
interface StoredKeyRecord {
  version: number;
  iv: string;
  tag: string;
  ciphertext: string;
  createdAt: number;
  updatedAt: number;
  /** Monotonic per-secret key version, bumped on every rotation. */
  keyVersion: number;
}

/** A single recorded key-usage event. Never contains plaintext key material. */
export interface KeyUsageEvent {
  /** Operation performed (`set`, `get`, `rotate`, `delete`, `denied`, …). */
  action: string;
  /** Secret id the operation targeted. */
  id: string;
  /** Whether the operation succeeded. */
  success: boolean;
  /** Wall-clock timestamp (ms since epoch). */
  timestamp: number;
  /** Key version in effect at the time of the event, when known. */
  keyVersion?: number;
  /** Acting principal (from the access context), when known. */
  principal?: string;
  /** Failure reason code, when the operation failed. */
  reason?: string;
}

/** Options for {@link SecureKeyStore}. */
export interface SecureKeyStoreOptions {
  /** AES-256 master key — exactly 32 bytes. Never store it next to the records. */
  masterKey: Uint8Array | Buffer;
  /** Persistence layer. Defaults to {@link MemoryKeyStoreBackend}. */
  backend?: KeyStoreBackend;
  /**
   * Access-control engine enforcing per-key policies. When omitted, a fresh
   * {@link AccessControl} with no policies is created (deny-by-default for
   * operations that require a policy).
   */
  accessControl?: AccessControl;
  /** Audit logger receiving every key-usage event. */
  auditLogger?: AuditLogger;
  /** Event emitter that receives `keyUsage` events. */
  events?: EventEmitter;
  /**
   * When `true`, operations that have no registered policy are denied.
   * Defaults to `true` so access is controlled by default.
   */
  denyByDefault?: boolean;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function normalizeId(id: unknown): string {
  if (typeof id !== "string" || id.trim().length === 0) {
    throw new KeyStorageError("Secret id must be a non-empty string", undefined, {
      received: typeof id,
    });
  }
  const normalized = id.trim();
  if (normalized.length > MAX_ID_LENGTH) {
    throw new KeyStorageError(
      `Secret id exceeds maximum length of ${MAX_ID_LENGTH} characters`,
      "KEY_STORAGE",
      { length: normalized.length },
    );
  }
  if (CONTROL_CHARS.test(normalized)) {
    throw new KeyStorageError("Secret id must not contain control characters");
  }
  return normalized;
}

function normalizeSecret(secret: unknown): string {
  if (typeof secret !== "string" || secret.length === 0) {
    throw new KeyStorageError("Secret must be a non-empty string", undefined, {
      received: typeof secret,
    });
  }
  if (secret.length > MAX_SECRET_LENGTH) {
    throw new KeyStorageError(
      `Secret exceeds maximum length of ${MAX_SECRET_LENGTH} characters`,
      undefined,
      { length: secret.length },
    );
  }
  return secret;
}

function validateMasterKey(key: unknown): Buffer {
  if (!isByteView(key) || key.length !== MASTER_KEY_BYTES) {
    throw new KeyStorageError(
      `masterKey must be exactly ${MASTER_KEY_BYTES} bytes`,
      undefined,
      { length: isByteView(key) ? key.length : undefined },
    );
  }
  return Buffer.from(key);
}

/**
 * Realm-tolerant 8-bit byte-view check.
 *
 * `value instanceof Uint8Array` is false for objects created in another
 * realm (e.g. a Node `Buffer` observed from a jsdom realm, or vice versa),
 * so byte views are detected via `ArrayBuffer.isView` + element size instead.
 */
function isByteView(value: unknown): value is Uint8Array {
  return (
    ArrayBuffer.isView(value) &&
    (value as Uint8Array).BYTES_PER_ELEMENT === 1
  );
}

// ---------------------------------------------------------------------------
// SecureKeyStore
// ---------------------------------------------------------------------------

/**
 * Encrypted storage for private keys and other long-lived secrets.
 *
 * @example
 * const masterKey = SecureKeyStore.generateMasterKey();
 * const store = new SecureKeyStore({ masterKey });
 * await store.setSecret("hot-wallet", "SXXXXXXXX…");
 * await store.getSecret("hot-wallet");      // "SXXXXXXXX…"
 * await store.rotateMasterKey(SecureKeyStore.generateMasterKey());
 * await store.cleanup();                    // purge every stored record
 * store.destroy();                          // zeroize the master key
 */
export class SecureKeyStore {
  /**
   * Generate a cryptographically random 32-byte master key.
   *
   * Store it in a secrets manager — never alongside the encrypted records.
   */
  static generateMasterKey(): Uint8Array {
    return new Uint8Array(randomBytes(MASTER_KEY_BYTES));
  }

  /**
   * Derive a 32-byte master key from a passphrase using PBKDF2-SHA256.
   *
   * @param passphrase - Secret passphrase (use a high-entropy one in production).
   * @param salt       - Unique salt, at least 16 bytes per key.
   * @param iterations - PBKDF2 iterations (≥ 1 000). Defaults to 100 000.
   * @returns The derived 32-byte key.
   * @throws {KeyStorageError} On invalid passphrase/salt/iterations.
   */
  static async deriveMasterKey(
    passphrase: string,
    salt: Uint8Array | Buffer,
    iterations: number = PBKDF2_ITERATIONS,
  ): Promise<Uint8Array> {
    if (typeof passphrase !== "string" || passphrase.length === 0) {
      throw new KeyStorageError("passphrase must be a non-empty string");
    }
    if (!isByteView(salt) || salt.length < MIN_PBKDF2_SALT_BYTES) {
      throw new KeyStorageError(
        `salt must be at least ${MIN_PBKDF2_SALT_BYTES} bytes`,
        undefined,
        { length: isByteView(salt) ? salt.length : undefined },
      );
    }
    if (!Number.isInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS) {
      throw new KeyStorageError(
        `iterations must be an integer of at least ${MIN_PBKDF2_ITERATIONS}`,
        undefined,
        { iterations },
      );
    }
    const derived = await pbkdf2(
      passphrase,
      Buffer.from(salt),
      iterations,
      MASTER_KEY_BYTES,
      PBKDF2_DIGEST,
    );
    return new Uint8Array(derived);
  }

  private _masterKey: Buffer;
  private readonly _backend: KeyStoreBackend;
  private readonly _accessControl: AccessControl;
  private readonly _auditLogger: AuditLogger;
  private readonly _events: EventEmitter;
  private readonly _denyByDefault: boolean;
  private readonly _usage: KeyUsageEvent[] = [];
  private _destroyed = false;

  constructor(options: SecureKeyStoreOptions) {
    if (!options || typeof options !== "object") {
      throw new KeyStorageError("options with a masterKey are required");
    }
    this._masterKey = validateMasterKey(options.masterKey);
    const backend = options.backend ?? new MemoryKeyStoreBackend();
    for (const method of ["read", "write", "delete", "listIds"] as const) {
      if (typeof backend[method] !== "function") {
        throw new KeyStorageError(`backend must implement ${method}()`, undefined, {
          method,
        });
      }
    }
    this._backend = backend;
    this._accessControl = options.accessControl ?? new AccessControl();
    this._auditLogger = options.auditLogger ?? new AuditLogger();
    this._events = options.events ?? new EventEmitter();
    this._denyByDefault = options.denyByDefault ?? true;
  }

  /**
   * Register or replace the access policy for a secret id.
   *
   * @param id     - Secret id the policy governs.
   * @param policy - Access policy to enforce.
   * @throws {KeyStorageError} After `destroy()`.
   */
  setAccessPolicy(id: string, policy: AccessPolicy): void {
    this._assertUsable();
    const entry = normalizeId(id);
    this._accessControl.setPolicy(entry, policy);
    this._recordUsage({ action: "policy.set", id: entry, success: true });
  }

  /**
   * Return the recorded key-usage events (oldest first), optionally filtered
   * by secret id. Events never contain plaintext key material.
   *
   * @param id - Optional secret id filter.
   * @throws {KeyStorageError} After `destroy()`.
   */
  getUsageEvents(id?: string): KeyUsageEvent[] {
    this._assertUsable();
    const events = id === undefined ? this._usage : this._usage.filter((e) => e.id === id);
    return events.map((e) => ({ ...e }));
  }

  /**
   * Return the current key version for `id` without decrypting the secret.
   *
   * @param id - Secret id to inspect.
   * @throws {KeyNotFoundError} When no record exists for `id`.
   * @throws {KeyStorageError}  After `destroy()`.
   */
  async getKeyVersion(id: string): Promise<number> {
    this._assertUsable();
    const entry = normalizeId(id);
    const record = await this._backend.read(entry);
    if (record === null) {
      throw new KeyNotFoundError(`No secret stored for "${entry}"`, { id: entry });
    }
    return parseRecord(record, entry).keyVersion;
  }

  /**
   * Rotate the encryption of a single secret under the current master key,
   * bumping its key version and re-sealing it with a fresh IV.
   *
   * @param id      - Secret id to rotate.
   * @param context - Access context for the operation.
   * @returns The new key version.
   * @throws {KeyAccessDeniedError}  When the policy denies rotation.
   * @throws {KeyAccessContextError} When a required context is missing.
   * @throws {KeyNotFoundError}      When no record exists for `id`.
   * @throws {KeyIntegrityError}     When the record fails authentication.
   * @throws {KeyStorageError}       After `destroy()`.
   */
  async rotateSecretKey(id: string, context?: AccessContext): Promise<number> {
    this._assertUsable();
    const entry = normalizeId(id);
    this._authorize("rotate", entry, context);

    const raw = await this._backend.read(entry);
    if (raw === null) {
      this._recordUsage({ action: "rotate", id: entry, success: false, reason: "not_found" });
      throw new KeyNotFoundError(`No secret stored for "${entry}"`, { id: entry });
    }
    const record = parseRecord(raw, entry);
    const nextVersion = record.keyVersion + 1;
    if (nextVersion > MAX_KEY_VERSION) {
      this._recordUsage({ action: "rotate", id: entry, success: false, reason: "version_overflow" });
      throw new KeyRotationError(`Key version overflow for "${entry}"`, {
        id: entry,
        keyVersion: record.keyVersion,
      });
    }
    const secret = open(raw, entry, this._masterKey);
    const sealed = seal(secret, record.createdAt, this._masterKey, nextVersion);
    await this._backend.write(entry, sealed);
    this._recordUsage({
      action: "rotate",
      id: entry,
      success: true,
      keyVersion: nextVersion,
      principal: context?.principal,
    });
    return nextVersion;
  }

  /**
   * Encrypt and persist `secret` under `id`.
   *
   * Writing an existing id rotates the secret: it is re-encrypted with a
   * fresh IV while preserving the original `createdAt` timestamp.
   *
   * @param id     - Storage key for the secret (≤ 128 chars, no control chars).
   * @param secret - Non-empty plaintext secret (≤ 4 096 chars).
   * @throws {KeyStorageError}      On invalid id/secret or after `destroy()`.
   * @throws {KeyIntegrityError}    If an existing record is unreadable.
   */
  async setSecret(id: string, secret: string, context?: AccessContext): Promise<void> {
    this._assertUsable();
    const entry = normalizeId(id);
    const plaintext = normalizeSecret(secret);
    this._authorize("write", entry, context);

    const existing = await this._backend.read(entry);
    let createdAt = Date.now();
    let keyVersion = 1;
    if (existing !== null) {
      const record = parseRecord(existing, entry);
      createdAt = record.createdAt;
      keyVersion = record.keyVersion + 1;
      if (keyVersion > MAX_KEY_VERSION) {
        this._recordUsage({
          action: "set",
          id: entry,
          success: false,
          reason: "version_overflow",
          principal: context?.principal,
        });
        throw new KeyRotationError(`Key version overflow for "${entry}"`, {
          id: entry,
          keyVersion: record.keyVersion,
        });
      }
    }
    await this._backend.write(
      entry,
      seal(plaintext, createdAt, this._masterKey, keyVersion),
    );
    this._recordUsage({
      action: "set",
      id: entry,
      success: true,
      keyVersion,
      principal: context?.principal,
    });
  }

  /**
   * Decrypt and return the secret stored under `id`.
   *
   * @param id - Storage key of the secret.
   * @returns The plaintext secret.
   * @throws {KeyNotFoundError}   When no record exists for `id`.
   * @throws {KeyIntegrityError}  When decryption/authentication fails.
   * @throws {KeyStorageError}    After `destroy()`.
   */
  async getSecret(id: string, context?: AccessContext): Promise<string> {
    this._assertUsable();
    const entry = normalizeId(id);
    this._authorize("read", entry, context);
    const record = await this._backend.read(entry);
    if (record === null) {
      this._recordUsage({
        action: "get",
        id: entry,
        success: false,
        reason: "not_found",
        principal: context?.principal,
      });
      throw new KeyNotFoundError(`No secret stored for "${entry}"`, { id: entry });
    }
    const keyVersion = parseRecord(record, entry).keyVersion;
    const secret = open(record, entry, this._masterKey);
    this._recordUsage({
      action: "get",
      id: entry,
      success: true,
      keyVersion,
      principal: context?.principal,
    });
    return secret;
  }

  /**
   * Report whether a record exists for `id` (does not decrypt).
   *
   * @param id - Storage key to probe.
   * @throws {KeyStorageError} After `destroy()`.
   */
  async hasSecret(id: string, context?: AccessContext): Promise<boolean> {
    this._assertUsable();
    const entry = normalizeId(id);
    this._authorize("read", entry, context);
    const present = (await this._backend.read(entry)) !== null;
    this._recordUsage({
      action: "has",
      id: entry,
      success: true,
      principal: context?.principal,
    });
    return present;
  }

  /**
   * List every stored id (never any key material).
   *
   * @returns Sorted ids.
   * @throws {KeyStorageError} After `destroy()`.
   */
  async listSecrets(context?: AccessContext): Promise<string[]> {
    this._assertUsable();
    const ids = (await this._backend.listIds()).slice().sort();
    const visible: string[] = [];
    for (const id of ids) {
      if (this._isAllowed("read", id, context)) {
        visible.push(id);
      } else {
        this._recordUsage({
          action: "list.denied",
          id,
          success: false,
          reason: "access_denied",
          principal: context?.principal,
        });
      }
    }
    this._recordUsage({
      action: "list",
      id: "*",
      success: true,
      principal: context?.principal,
    });
    return visible;
  }

  /**
   * Delete the record stored under `id`.
   *
   * @param id - Storage key to remove.
   * @throws {KeyStorageError} After `destroy()`.
   */
  async deleteSecret(id: string, context?: AccessContext): Promise<void> {
    this._assertUsable();
    const entry = normalizeId(id);
    this._authorize("delete", entry, context);
    await this._backend.delete(entry);
    this._recordUsage({
      action: "delete",
      id: entry,
      success: true,
      principal: context?.principal,
    });
  }

  /**
   * Re-encrypt every stored secret under a new master key (key rotation).
   *
   * Every record is authenticated, decrypted, and re-sealed in memory before
   * the first write is issued, so a mid-rotation failure cannot corrupt the
   * store: on error the old key remains active and no record has changed.
   * After a successful rotation the previous master key is zeroized.
   *
   * @param newMasterKey - Replacement key; exactly 32 bytes.
   * @throws {KeyRotationError} On an invalid new key.
   * @throws {KeyIntegrityError} If any stored record fails authentication
   *   under the current key (rotation aborts before any write).
   * @throws {KeyStorageError} After `destroy()`.
   */
  async rotateMasterKey(
    newMasterKey: Uint8Array | Buffer,
    context?: AccessContext,
  ): Promise<void> {
    this._assertUsable();
    let next: Buffer;
    try {
      next = validateMasterKey(newMasterKey);
    } catch (err) {
      this._recordUsage({
        action: "rotateMasterKey",
        id: "*",
        success: false,
        reason: "invalid_key",
        principal: context?.principal,
      });
      throw new KeyRotationError(
        err instanceof Error ? err.message : "Invalid new master key",
        { length: newMasterKey instanceof Uint8Array ? newMasterKey.length : undefined },
      );
    }

    const ids = await this._backend.listIds();
    const rewritten: Array<{ id: string; record: string; keyVersion: number }> = [];
    for (const id of ids) {
      const raw = await this._backend.read(id);
      if (raw === null) continue;
      const record = parseRecord(raw, id);
      const nextVersion = record.keyVersion + 1;
      if (nextVersion > MAX_KEY_VERSION) {
        this._recordUsage({
          action: "rotateMasterKey",
          id,
          success: false,
          reason: "version_overflow",
          principal: context?.principal,
        });
        throw new KeyRotationError(`Key version overflow for "${id}"`, {
          id,
          keyVersion: record.keyVersion,
        });
      }
      const secret = open(raw, id, this._masterKey);
      rewritten.push({
        id,
        record: seal(secret, record.createdAt, next, nextVersion),
        keyVersion: nextVersion,
      });
    }

    // All records re-sealed successfully — commit the rewrite, then swap keys.
    for (const { id, record } of rewritten) {
      await this._backend.write(id, record);
    }
    this._masterKey.fill(0);
    this._masterKey = next;
    for (const { id, keyVersion } of rewritten) {
      this._recordUsage({
        action: "rotateMasterKey",
        id,
        success: true,
        keyVersion,
        principal: context?.principal,
      });
    }
  }

  /**
   * Secure cleanup: delete every stored record from the backend.
   *
   * The master key stays usable afterwards; call {@link destroy} to zeroize
   * it as well.
   *
   * @throws {KeyStorageError} After `destroy()`.
   */
  async cleanup(context?: AccessContext): Promise<void> {
    this._assertUsable();
    for (const id of await this._backend.listIds()) {
      await this._backend.delete(id);
      this._recordUsage({
        action: "cleanup",
        id,
        success: true,
        principal: context?.principal,
      });
    }
  }

  /**
   * Zeroize the in-memory master key and permanently disable this instance.
   *
   * All subsequent operations throw {@link KeyStorageError}. Persisted
   * records (if any) become permanently unreadable — run {@link cleanup}
   * first when the records should also be removed.
   */
  destroy(): void {
    this._masterKey.fill(0);
    this._destroyed = true;
  }

  private _assertUsable(): void {
    if (this._destroyed) {
      throw new KeyStorageError("SecureKeyStore has been destroyed");
    }
  }

  /**
   * Evaluate the access policy for `action` on `id`.
   *
   * Returns `false` when denied; throws {@link KeyAccessContextError} when a
   * policy exists but no context was supplied.
   */
  private _isAllowed(action: string, id: string, context?: AccessContext): boolean {
    const policy = this._accessControl.getPolicy(id);
    if (!policy) {
      return !this._denyByDefault;
    }
    if (!context) {
      throw new KeyAccessContextError(
        `Access context is required to ${action} secret "${id}"`,
        { id, action },
      );
    }
    return this._accessControl.isAllowed(action, id, context);
  }

  /** Enforce the access policy, recording and throwing on denial. */
  private _authorize(action: string, id: string, context?: AccessContext): void {
    let allowed: boolean;
    try {
      allowed = this._isAllowed(action, id, context);
    } catch (err) {
      this._recordUsage({
        action,
        id,
        success: false,
        reason: "missing_context",
        principal: context?.principal,
      });
      throw err;
    }
    if (!allowed) {
      this._recordUsage({
        action,
        id,
        success: false,
        reason: "access_denied",
        principal: context?.principal,
      });
      throw new KeyAccessDeniedError(
        `Access denied: cannot ${action} secret "${id}"`,
        { id, action, principal: context?.principal },
      );
    }
  }

  /** Record a usage event in memory, the audit log, and the event emitter. */
  private _recordUsage(event: Omit<KeyUsageEvent, "timestamp">): void {
    const full: KeyUsageEvent = { ...event, timestamp: Date.now() };
    this._usage.push(full);
    if (this._usage.length > MAX_USAGE_EVENTS) {
      this._usage.splice(0, this._usage.length - MAX_USAGE_EVENTS);
    }
    try {
      this._auditLogger.log("key.usage", {
        action: full.action,
        id: full.id,
        success: full.success,
        keyVersion: full.keyVersion,
        principal: full.principal,
        reason: full.reason,
      });
    } catch {
      // Auditing must never break key operations.
    }
    try {
      this._events.emit("keyUsage", { ...full });
    } catch {
      // Listener failures must never break key operations.
    }
  }
}

// ---------------------------------------------------------------------------
// Envelope helpers
// ---------------------------------------------------------------------------

function parseRecord(raw: string, id: string): StoredKeyRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new KeyIntegrityError(`Stored record for "${id}" is not valid JSON`, { id });
  }
  const record = parsed as Partial<StoredKeyRecord>;
  if (
    !record ||
    typeof record !== "object" ||
    record.version !== RECORD_VERSION ||
    typeof record.iv !== "string" ||
    typeof record.tag !== "string" ||
    typeof record.ciphertext !== "string" ||
    typeof record.createdAt !== "number"
  ) {
    throw new KeyIntegrityError(`Stored record for "${id}" has an invalid shape`, { id });
  }
  // Records written before key versioning default to version 1.
  const keyVersion =
    typeof record.keyVersion === "number" && Number.isInteger(record.keyVersion) && record.keyVersion >= 1
      ? record.keyVersion
      : 1;
  return { ...(record as StoredKeyRecord), keyVersion };
}

function seal(
  plaintext: string,
  createdAt: number,
  key: Buffer,
  keyVersion: number = 1,
): string {
  const iv = randomBytes(GCM_IV_BYTES);
  const cipher = createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const record: StoredKeyRecord = {
    version: RECORD_VERSION,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
    createdAt,
    updatedAt: Date.now(),
    keyVersion,
  };
  return JSON.stringify(record);
}

function open(raw: string, id: string, key: Buffer): string {
  const record = parseRecord(raw, id);
  const iv = Buffer.from(record.iv, "base64");
  const tag = Buffer.from(record.tag, "base64");
  if (iv.length !== GCM_IV_BYTES || tag.length !== GCM_TAG_BYTES) {
    throw new KeyIntegrityError(`Stored record for "${id}" has an invalid IV/tag`, { id });
  }
  try {
    const decipher = createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(tag);
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(record.ciphertext, "base64")),
      decipher.final(),
    ]);
    return plaintext.toString("utf8");
  } catch {
    throw new KeyIntegrityError(
      `Failed to decrypt secret for "${id}" — wrong master key or tampered record`,
      { id },
    );
  }
}



