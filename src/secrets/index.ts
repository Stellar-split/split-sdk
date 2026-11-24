/**
 * SDK secrets management.
 *
 * Provides a pluggable, encrypted-at-rest secrets store with immutable
 * versioning, manual and policy-driven rotation, and access tracking.
 * Plaintext secret values are never exposed through listing/tracking APIs.
 */

export type SecretValue = string;

export interface SecretVersion {
  readonly version: number;
  readonly createdAt: number;
  readonly rotatedBy: 'manual' | 'policy' | 'initial';
  /** Ciphertext only — never the plaintext value. */
  readonly ciphertext: string;
}

export interface SecretRecord {
  readonly name: string;
  readonly currentVersion: number;
  readonly versions: ReadonlyArray<SecretVersion>;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly rotationPolicy?: RotationPolicy;
}

export interface RotationPolicy {
  /** Maximum age in milliseconds before a secret should be rotated. */
  readonly maxAgeMs: number;
}

export interface SecretAccessEvent {
  readonly name: string;
  readonly version: number;
  readonly at: number;
  readonly action: 'read' | 'write' | 'rotate';
}

/**
 * Pluggable encryption backend. Implementations must be deterministic for a
 * given key so that stored ciphertext can be decrypted on read.
 */
export interface SecretCipher {
  encrypt(plaintext: SecretValue): string;
  decrypt(ciphertext: string): SecretValue;
}

/**
 * Default in-memory cipher. This is an abstraction boundary: production
 * deployments should supply a real cipher (e.g. KMS-backed). The default
 * keeps plaintext out of stored records and tracking output.
 */
export class InMemoryCipher implements SecretCipher {
  private readonly key: string;

  constructor(key: string) {
    if (!key) {
      throw new Error('InMemoryCipher requires a non-empty key');
    }
    this.key = key;
  }

  encrypt(plaintext: SecretValue): string {
    return Buffer.from(this.xor(plaintext), 'utf8').toString('base64');
  }

  decrypt(ciphertext: string): SecretValue {
    return this.xor(Buffer.from(ciphertext, 'base64').toString('utf8'));
  }

  private xor(input: string): string {
    let out = '';
    for (let i = 0; i < input.length; i++) {
      out += String.fromCharCode(
        input.charCodeAt(i) ^ this.key.charCodeAt(i % this.key.length),
      );
    }
    return out;
  }
}

export interface SecretsManagerOptions {
  cipher?: SecretCipher;
  now?: () => number;
}

export class SecretsManager {
  private readonly cipher: SecretCipher;
  private readonly now: () => number;
  private readonly records = new Map<string, SecretRecord>();
  private readonly accessLog: SecretAccessEvent[] = [];

  constructor(options: SecretsManagerOptions = {}) {
    this.cipher = options.cipher ?? new InMemoryCipher('sdk-default-secrets-key');
    this.now = options.now ?? (() => Date.now());
  }

  /** Store a new secret, creating version 1. */
  set(name: string, value: SecretValue, policy?: RotationPolicy): SecretRecord {
    this.assertName(name);
    const at = this.now();
    const version: SecretVersion = {
      version: 1,
      createdAt: at,
      rotatedBy: 'initial',
      ciphertext: this.cipher.encrypt(value),
    };
    const record: SecretRecord = {
      name,
      currentVersion: 1,
      versions: [version],
      createdAt: at,
      updatedAt: at,
      rotationPolicy: policy,
    };
    this.records.set(name, record);
    this.track(name, 1, 'write');
    return record;
  }

  /** Retrieve the plaintext value of the current version. */
  get(name: string): SecretValue {
    const record = this.require(name);
    return this.getVersion(name, record.currentVersion);
  }

  /** Retrieve the plaintext value of a specific version. */
  getVersion(name: string, version: number): SecretValue {
    const record = this.require(name);
    const entry = record.versions.find((v) => v.version === version);
    if (!entry) {
      throw new Error(`Secret "${name}" has no version ${version}`);
    }
    this.track(name, version, 'read');
    return this.cipher.decrypt(entry.ciphertext);
  }

  /** Rotate a secret, producing a new immutable version. */
  rotate(name: string, value: SecretValue, rotatedBy: 'manual' | 'policy' = 'manual'): SecretRecord {
    const record = this.require(name);
    const at = this.now();
    const nextVersion = record.currentVersion + 1;
    const version: SecretVersion = {
      version: nextVersion,
      createdAt: at,
      rotatedBy,
      ciphertext: this.cipher.encrypt(value),
    };
    const updated: SecretRecord = {
      ...record,
      currentVersion: nextVersion,
      versions: [...record.versions, version],
      updatedAt: at,
    };
    this.records.set(name, updated);
    this.track(name, nextVersion, 'rotate');
    return updated;
  }

  /** Rotate every secret whose policy maxAgeMs has elapsed. */
  rotateDue(rotateValue: (name: string, current: SecretValue) => SecretValue): string[] {
    const rotated: string[] = [];
    const at = this.now();
    for (const record of this.records.values()) {
      if (!record.rotationPolicy) continue;
      if (at - record.updatedAt >= record.rotationPolicy.maxAgeMs) {
        const current = this.getVersion(record.name, record.currentVersion);
        this.rotate(record.name, rotateValue(record.name, current), 'policy');
        rotated.push(record.name);
      }
    }
    return rotated;
  }

  /** List secret metadata without exposing values. */
  list(): SecretRecord[] {
    return Array.from(this.records.values());
  }

  /** Full access tracking log. */
  getAccessLog(): SecretAccessEvent[] {
    return [...this.accessLog];
  }

  private track(name: string, version: number, action: SecretAccessEvent['action']): void {
    this.accessLog.push({ name, version, at: this.now(), action });
  }

  private require(name: string): SecretRecord {
    const record = this.records.get(name);
    if (!record) {
      throw new Error(`Secret "${name}" not found`);
    }
    return record;
  }

  private assertName(name: string): void {
    if (!name || typeof name !== 'string') {
      throw new Error('Secret name must be a non-empty string');
    }
  }
}
