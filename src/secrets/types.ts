/**
 * Secrets management type definitions.
 *
 * These types describe secret records, immutable version history, and
 * rotation policy. They are intentionally backend-agnostic so that the
 * storage layer can be swapped without changing consumers.
 */

/**
 * A single immutable version of a secret.
 *
 * The plaintext value is never stored here directly; `ciphertext` holds the
 * encrypted payload produced by the storage backend.
 */
export interface SecretVersion {
  /** Monotonically increasing version number, starting at 1. */
  version: number;
  /** Encrypted secret payload. Never plaintext. */
  ciphertext: string;
  /** Initialization vector / nonce used for encryption, if applicable. */
  iv?: string;
  /** Identifier of the key used to encrypt this version. */
  keyId?: string;
  /** ISO-8601 timestamp of when this version was created. */
  createdAt: string;
  /** Optional actor or system that created this version. */
  createdBy?: string;
  /** Whether this version has been revoked and must not be used. */
  revoked?: boolean;
}

/**
 * Metadata describing a tracked secret without exposing its value.
 */
export interface SecretMetadata {
  /** Unique secret name/identifier. */
  name: string;
  /** Human-readable description. */
  description?: string;
  /** Current active version number. */
  currentVersion: number;
  /** Total number of retained versions. */
  versionCount: number;
  /** ISO-8601 timestamp of creation. */
  createdAt: string;
  /** ISO-8601 timestamp of the last update/rotation. */
  updatedAt: string;
  /** ISO-8601 timestamp of the last rotation, if any. */
  lastRotatedAt?: string;
  /** Optional rotation policy attached to this secret. */
  rotationPolicy?: RotationPolicy;
  /** Arbitrary non-sensitive labels for tracking. */
  labels?: Record<string, string>;
}

/**
 * Policy describing when and how a secret should be rotated.
 */
export interface RotationPolicy {
  /** Maximum age in milliseconds before rotation is due. */
  maxAgeMs?: number;
  /** Maximum number of retained versions (older versions are pruned). */
  maxVersions?: number;
  /** Whether rotation should be performed automatically when due. */
  autoRotate?: boolean;
}

/**
 * Result of a rotation operation.
 */
export interface RotationResult {
  /** Secret name that was rotated. */
  name: string;
  /** Version number that was active before rotation. */
  previousVersion: number;
  /** Newly created active version number. */
  newVersion: number;
  /** ISO-8601 timestamp of the rotation. */
  rotatedAt: string;
}

/**
 * Pluggable storage backend contract.
 *
 * Implementations are responsible for encrypting values at rest. The manager
 * only ever hands plaintext to `put` and receives plaintext from `get`.
 */
export interface SecretsBackend {
  /** Persist an encrypted version for the given secret name. */
  put(name: string, version: SecretVersion, plaintext: string): Promise<void> | void;
  /** Retrieve and decrypt a specific version. */
  get(name: string, version: number): Promise<string | undefined> | string | undefined;
  /** List all stored versions for a secret, newest first. */
  listVersions(name: string): Promise<SecretVersion[]> | SecretVersion[];
  /** Remove a specific version. */
  deleteVersion(name: string, version: number): Promise<void> | void;
  /** Remove all versions for a secret. */
  delete(name: string): Promise<void> | void;
}

/**
 * Options for constructing a secrets manager.
 */
export interface SecretsManagerOptions {
  /** Storage backend. Defaults to an in-memory encrypted backend. */
  backend?: SecretsBackend;
  /** Default rotation policy applied to secrets without an explicit policy. */
  defaultRotationPolicy?: RotationPolicy;
}

export interface SecretRecord {
  metadata: SecretMetadata;
  versions: SecretVersion[];
}
