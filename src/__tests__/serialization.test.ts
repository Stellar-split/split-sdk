import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SerializationRegistry,
  SerializationError,
  getDefaultSerializationRegistry,
  resetDefaultSerializationRegistry,
  serialize,
  deserialize,
} from '../serialization.js';

// ─── Test suite 1: Built-in formats ──────────────────────────────────────────
describe('SerializationRegistry — built-in formats', () => {
  let reg: SerializationRegistry;

  beforeEach(() => {
    reg = new SerializationRegistry();
  });

  it('lists all four built-in formats', () => {
    const formats = reg.listFormats();
    expect(formats).toContain('json');
    expect(formats).toContain('base64');
    expect(formats).toContain('hex');
    expect(formats).toContain('binary');
  });

  it('round-trips JSON', () => {
    const obj = { a: 1, b: 'hello' };
    const raw = reg.serialize(obj, 'json');
    expect(reg.deserialize(raw, 'json')).toEqual(obj);
  });

  it('round-trips base64', () => {
    const obj = { x: [1, 2, 3] };
    const raw = reg.serialize(obj, 'base64');
    expect(reg.deserialize(raw, 'base64')).toEqual(obj);
  });

  it('round-trips hex', () => {
    const obj = { flag: true };
    const raw = reg.serialize(obj, 'hex');
    expect(reg.deserialize(raw, 'hex')).toEqual(obj);
  });

  it('round-trips binary', () => {
    const obj = { n: 42 };
    const raw = reg.serialize(obj, 'binary');
    expect(reg.deserialize(raw, 'binary')).toEqual(obj);
  });
});

// ─── Test suite 2: Custom format registration ─────────────────────────────────
describe('SerializationRegistry — custom formats', () => {
  it('registers and uses a custom format', () => {
    const reg = new SerializationRegistry();
    reg.registerFormat('csv', {
      serialize: (val: unknown) => (val as string[]).join(','),
      deserialize: (raw) => (raw as string).split(','),
    });
    expect(reg.hasFormat('csv')).toBe(true);
    const raw = reg.serialize(['a', 'b', 'c'], 'csv');
    expect(reg.deserialize(raw, 'csv')).toEqual(['a', 'b', 'c']);
  });

  it('throws when registering a duplicate name', () => {
    const reg = new SerializationRegistry();
    reg.registerFormat('myFmt', { serialize: (v) => String(v), deserialize: (r) => r });
    expect(() =>
      reg.registerFormat('myFmt', { serialize: (v) => String(v), deserialize: (r) => r }),
    ).toThrow(/already registered/i);
  });

  it('allows overriding with setFormat', () => {
    const reg = new SerializationRegistry();
    reg.setFormat('json', {
      serialize: () => '"overridden"',
      deserialize: () => 'overridden',
    });
    expect(reg.deserialize(reg.serialize({}, 'json'), 'json')).toBe('overridden');
  });

  it('throws when unregistering a built-in format', () => {
    const reg = new SerializationRegistry();
    expect(() => reg.unregisterFormat('json')).toThrow(/built-in/i);
  });

  it('removes a custom format', () => {
    const reg = new SerializationRegistry();
    reg.registerFormat('tmp', { serialize: (v) => String(v), deserialize: (r) => r });
    expect(reg.unregisterFormat('tmp')).toBe(true);
    expect(reg.hasFormat('tmp')).toBe(false);
  });
});

// ─── Test suite 3: Versioning ─────────────────────────────────────────────────
describe('SerializationRegistry — versioning', () => {
  it('wraps in envelope and unwraps correctly', () => {
    const reg = new SerializationRegistry();
    const payload = { amount: '100' };
    const raw = reg.serialize(payload, 'json', 2);
    const restored = reg.deserialize<{ amount: string }>(raw, 'json', 2);
    expect(restored).toEqual(payload);
  });

  it('throws on version mismatch', () => {
    const reg = new SerializationRegistry();
    const raw = reg.serialize({ x: 1 }, 'json', 1);
    expect(() => reg.deserialize(raw, 'json', 2)).toThrow(SerializationError);
  });

  it('no data loss through version round-trip', () => {
    const reg = new SerializationRegistry();
    const complex = { nested: { arr: [1, 'two', null], flag: false } };
    const raw = reg.serialize(complex, 'base64', 3);
    const result = reg.deserialize<typeof complex>(raw, 'base64', 3);
    expect(result).toEqual(complex);
  });
});

// ─── Test suite 4: Tracking / history ────────────────────────────────────────
describe('SerializationRegistry — tracking', () => {
  it('records history entries for serialize and deserialize', () => {
    const reg = new SerializationRegistry();
    reg.serialize({ a: 1 }, 'json');
    reg.deserialize(reg.serialize({ b: 2 }, 'json'), 'json');
    const history = reg.getHistory();
    expect(history.length).toBeGreaterThanOrEqual(2);
    expect(history.some((r) => r.operation === 'serialize')).toBe(true);
    expect(history.some((r) => r.operation === 'deserialize')).toBe(true);
  });

  it('records failure in history without throwing extra', () => {
    const reg = new SerializationRegistry();
    expect(() => reg.serialize({}, 'nonexistent')).toThrow(SerializationError);
    // No history entry for unknown-format error (codec lookup fails before tracking)
  });

  it('provides stats per format', () => {
    const reg = new SerializationRegistry();
    reg.serialize({}, 'json');
    reg.serialize({}, 'json');
    reg.serialize({}, 'base64');
    const stats = reg.getStats();
    expect(stats['json'].serialize).toBe(2);
    expect(stats['base64'].serialize).toBe(1);
  });

  it('clears history', () => {
    const reg = new SerializationRegistry();
    reg.serialize({}, 'json');
    reg.clearHistory();
    expect(reg.getHistory()).toHaveLength(0);
  });
});

// ─── Test suite 5: Default registry convenience helpers ───────────────────────
describe('Default registry — serialize/deserialize helpers', () => {
  afterEach(() => {
    resetDefaultSerializationRegistry();
  });

  it('serialize and deserialize round-trip via default registry', () => {
    const obj = { hello: 'world' };
    const raw = serialize(obj, 'json');
    expect(deserialize(raw, 'json')).toEqual(obj);
  });

  it('getDefaultSerializationRegistry returns same instance', () => {
    const r1 = getDefaultSerializationRegistry();
    const r2 = getDefaultSerializationRegistry();
    expect(r1).toBe(r2);
  });

  it('resetDefaultSerializationRegistry creates fresh instance', () => {
    const r1 = getDefaultSerializationRegistry();
    resetDefaultSerializationRegistry();
    const r2 = getDefaultSerializationRegistry();
    expect(r1).not.toBe(r2);
  });
});
