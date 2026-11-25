/**
 * SDK secrets management.
 *
 * Provides secure storage, versioning, rotation, and tracking of secrets.
 * Secrets are never exposed in plaintext through the public API: values are
 * encrypted at rest via a pluggable backend and only decrypted on explicit
 * retrieval.
 */

export interface SecretVersion {
  /** Monotonically increasing version number, starting at 1. */
  version: number;
  /** Encrypted payload (opaque to callers). */
  ciphertext: string;
  /** ISO timestamp of when this version was created. */
  createdAt: string;
  /** Optional reason for the version (e.g. "initial", "rotation"). */
  reason?: string;
}

export interface SecretRecord {
  name: string;
  /** Current active version number. */
  currentVersion: number;
  /** Immutable version history, ordered by version ascending. */
  versions: SecretVersion[];
  /** ISO timestamp of last rotation, if any. */
  lastRotatedAt?: string;
  /** Rotation policy in milliseconds, if configured. */
  rotationIntervalMs?: number;
}

export interface SecretMetadata {
  name: string;
  currentVersion: number;
  versionCount: number;
  createdAt: string;
  lastRotatedAt?: string;
  rotationIntervalMs?: number;
}

export interface RotationPolicy {
  /** Rotate automatically once the current version is older than this. */
  intervalMs: number;
}

/**
 * Pluggable encryption backend. Implementations must be deterministic enough
 * to round-trip values and must never store plaintext.
 */
export interface SecretsBackend {
  encrypt(plaintext: string): string;
  decrypt(ciphertext: string): string;
}

/**
 * Default in-memory backend. Uses a reversible encoding so the abstraction is
 * usable without external dependencies; production deployments should supply
 * a real crypto backend implementing {@link SecretsBackend}.
 */
export class InMemorySecretsBackend implements SecretsBackend {
  encrypt(plaintext: string): string {
    return Buffer.from(plaintext, "utf8").toString("base64");
  }

  decrypt(ciphertext: string): string {
    return Buffer.from(ciphertext, "base64").toString("utf8");
  }
}

export interface SecretsManagerOptions {
  backend?: SecretsBackend;
  /** Clock injection for deterministic testing. */
  now?: () => Date;
}

export class SecretsManager {
  private readonly backend: SecretsBackend;
  private readonly now: () => Date;
  private readonly secrets = new Map<string, SecretRecord>();

  constructor(options: SecretsManagerOptions = {}) {
    this.backend = options.backend ?? new InMemorySecretsBackend();
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Store a new secret. Creates version 1. Throws if the secret already
   * exists; use {@link rotate} to create new versions.
   */
  set(name: string, value: string, policy?: RotationPolicy): SecretMetadata {
    this.assertName(name);
    if (this.secrets.has(name)) {
      throw new Error(`Secret "${name}" already exists; use rotate() to update it.`);
    }
    const createdAt = this.now().toISOString();
    const record: SecretRecord = {
      name,
      currentVersion: 1,
      versions: [
        {
          version: 1,
          ciphertext: this.backend.encrypt(value),
          createdAt,
          reason: "initial",
        },
      ],
      rotationIntervalMs: policy?.intervalMs,
    };
    this.secrets.set(name, record);
    return this.toMetadata(record);
  }

  /**
   * Retrieve the plaintext value of a secret. Defaults to the current version.
   * Throws if the secret or version does not exist.
   */
  get(name: string, version?: number): string {
    const record = this.requireRecord(name);
    const target = version ?? record.currentVersion;
    const entry = record.versions.find((v) => v.version === target);
    if (!entry) {
      throw new Error(`Secret "${name}" has no version ${target}.`);
    }
    return this.backend.decrypt(entry.ciphertext);
  }

  /**
   * Rotate a secret, creating a new immutable version and advancing the
   * current-version pointer. Returns metadata for the updated secret.
   */
  rotate(name: string, value: string, reason = "rotation"): SecretMetadata {
    const record = this.requireRecord(name);
    const nextVersion = record.currentVersion + 1;
    const createdAt = this.now().toISOString();
    record.versions.push({
      version: nextVersion,
      ciphertext: this.backend.encrypt(value),
      createdAt,
      reason,
    });
    record.currentVersion = nextVersion;
    record.lastRotatedAt = createdAt;
    return this.toMetadata(record);
  }

  /**
   * Rotate every secret whose configured policy interval has elapsed.
   * The provided value factory produces the new plaintext for each secret.
   * Returns the names of secrets that were rotated.
   */
  rotateDue(valueFactory: (name: string) => string): string[] {
    const rotated: string[] = [];
    const nowMs = this.now().getTime();
    for (const record of this.secrets.values()) {
      if (!record.rotationIntervalMs) continue;
      const last = record.lastRotatedAt ?? record.versions[record.versions.length - 1].createdAt;
      if (nowMs - new Date(last).getTime() >= record.rotationIntervalMs) {
        this.rotate(record.name, valueFactory(record.name), "policy");
        rotated.push(record.name);
      }
    }
    return rotated;
  }

  /** List metadata for all tracked secrets (never plaintext). */
  list(): SecretMetadata[] {
    return Array.from(this.secrets.values()).map((r) => this.toMetadata(r));
  }

  /** Return metadata for a single secret, or undefined if untracked. */
  describe(name: string): SecretMetadata | undefined {
    const record = this.secrets.get(name);
    return record ? this.toMetadata(record) : undefined;
  }

  /** Remove a secret and all of its versions. */
  delete(name: string): boolean {
    return this.secrets.delete(name);
  }

  private requireRecord(name: string): SecretRecord {
    const record = this.secrets.get(name);
    if (!record) {
      throw new Error(`Secret "${name}" not found.`);
    }
    return record;
  }

  private assertName(name: string): void {
    if (!name || typeof name !== "string") {
      throw new Error("Secret name must be a non-empty string.");
    }
  }

  private toMetadata(record: SecretRecord): SecretMetadata {
    return {
      name: record.name,
      currentVersion: record.currentVersion,
      versionCount: record.versions.length,
      createdAt: record.versions[0].createdAt,
      lastRotatedAt: record.lastRotatedAt,
      rotationIntervalMs: record.rotationIntervalMs,
    };
  }
}
