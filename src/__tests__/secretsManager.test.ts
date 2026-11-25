import { SecretsManager, SecretVersion, RotationPolicy } from '../secrets';

describe('SecretsManager', () => {
  let manager: SecretsManager;

  beforeEach(() => {
    manager = new SecretsManager({ encryptionKey: 'test-encryption-key-32-bytes-long!' });
  });

  describe('storage', () => {
    it('stores and retrieves a secret value', () => {
      manager.set('api-key', 'super-secret-value');
      expect(manager.get('api-key')).toBe('super-secret-value');
    });

    it('does not expose plaintext in the stored record', () => {
      manager.set('api-key', 'super-secret-value');
      const record = manager.describe('api-key');
      expect(record).toBeDefined();
      expect(JSON.stringify(record)).not.toContain('super-secret-value');
    });

    it('throws when retrieving an unknown secret', () => {
      expect(() => manager.get('missing')).toThrow();
    });

    it('deletes a secret', () => {
      manager.set('api-key', 'value');
      manager.delete('api-key');
      expect(manager.has('api-key')).toBe(false);
    });
  });

  describe('versioning', () => {
    it('creates a new version on each set', () => {
      manager.set('api-key', 'v1');
      manager.set('api-key', 'v2');
      const versions = manager.listVersions('api-key');
      expect(versions).toHaveLength(2);
      expect(versions[0].version).toBe(1);
      expect(versions[1].version).toBe(2);
    });

    it('retrieves a specific version', () => {
      manager.set('api-key', 'v1');
      manager.set('api-key', 'v2');
      expect(manager.get('api-key', 1)).toBe('v1');
      expect(manager.get('api-key', 2)).toBe('v2');
    });

    it('returns the current version by default', () => {
      manager.set('api-key', 'v1');
      manager.set('api-key', 'v2');
      expect(manager.get('api-key')).toBe('v2');
      expect(manager.currentVersion('api-key')).toBe(2);
    });

    it('keeps version history immutable', () => {
      manager.set('api-key', 'v1');
      manager.set('api-key', 'v2');
      const versions: SecretVersion[] = manager.listVersions('api-key');
      expect(versions[0].value).toBe('v1');
      expect(versions[0].version).toBe(1);
    });
  });

  describe('rotation', () => {
    it('rotates a secret producing a new version', () => {
      manager.set('api-key', 'v1');
      const rotated = manager.rotate('api-key', () => 'v2-rotated');
      expect(rotated.version).toBe(2);
      expect(manager.get('api-key')).toBe('v2-rotated');
    });

    it('applies a rotation policy based on age', () => {
      const policy: RotationPolicy = { maxAgeMs: 1000 };
      manager.set('api-key', 'v1', { policy });
      const due = manager.isRotationDue('api-key', Date.now() + 2000);
      expect(due).toBe(true);
    });

    it('reports not due when within policy window', () => {
      const policy: RotationPolicy = { maxAgeMs: 100000 };
      manager.set('api-key', 'v1', { policy });
      expect(manager.isRotationDue('api-key')).toBe(false);
    });
  });

  describe('tracking', () => {
    it('tracks metadata for each secret', () => {
      manager.set('api-key', 'v1');
      const record = manager.describe('api-key');
      expect(record.name).toBe('api-key');
      expect(record.currentVersion).toBe(1);
      expect(record.createdAt).toBeInstanceOf(Date);
      expect(record.updatedAt).toBeInstanceOf(Date);
    });

    it('lists all tracked secret names', () => {
      manager.set('a', '1');
      manager.set('b', '2');
      expect(manager.list().sort()).toEqual(['a', 'b']);
    });
  });
});
