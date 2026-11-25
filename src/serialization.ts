/**
 * SDK Data Serialization System (issue #1350)
 *
 * Provides serialization/deserialization utilities with:
 * - Multiple format support (JSON, base64, hex, binary)
 * - Versioned serialization for safe migrations
 * - Custom format registration
 * - Per-operation tracking
 */

export type SerializationFormat = 'json' | 'base64' | 'hex' | 'binary';

export interface SerializationRecord {
  id: string;
  format: SerializationFormat | string;
  version: number;
  operation: 'serialize' | 'deserialize';
  ok: boolean;
  durationMs: number;
  timestamp: number;
  error?: string;
}

export interface VersionedEnvelope<T = unknown> {
  __v: number;
  __fmt: string;
  data: T;
}

export class SerializationError extends Error {
  constructor(
    public readonly format: string,
    public readonly operation: 'serialize' | 'deserialize',
    public readonly cause: unknown,
  ) {
    super(
      `Serialization "${operation}" with format "${format}" failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    this.name = 'SerializationError';
  }
}

export interface FormatCodec<T = unknown> {
  serialize(value: T): string | Uint8Array;
  deserialize(raw: string | Uint8Array): T;
}

/** Built-in JSON codec */
const jsonCodec: FormatCodec = {
  serialize: (value) => JSON.stringify(value),
  deserialize: (raw) => JSON.parse(raw as string) as unknown,
};

/** Built-in base64 codec */
const base64Codec: FormatCodec = {
  serialize: (value) => {
    const json = JSON.stringify(value);
    return Buffer.from(json, 'utf8').toString('base64');
  },
  deserialize: (raw) => {
    const json = Buffer.from(raw as string, 'base64').toString('utf8');
    return JSON.parse(json) as unknown;
  },
};

/** Built-in hex codec */
const hexCodec: FormatCodec = {
  serialize: (value) => {
    const json = JSON.stringify(value);
    return Buffer.from(json, 'utf8').toString('hex');
  },
  deserialize: (raw) => {
    const json = Buffer.from(raw as string, 'hex').toString('utf8');
    return JSON.parse(json) as unknown;
  },
};

/** Built-in binary codec (Uint8Array of JSON utf-8 bytes) */
const binaryCodec: FormatCodec = {
  serialize: (value) => {
    const json = JSON.stringify(value);
    return new TextEncoder().encode(json);
  },
  deserialize: (raw) => {
    const json =
      raw instanceof Uint8Array
        ? new TextDecoder().decode(raw)
        : Buffer.from(raw as string, 'binary').toString('utf8');
    return JSON.parse(json) as unknown;
  },
};

let _trackingCounter = 0;

function nextId(): string {
  return `ser_${Date.now()}_${(_trackingCounter = (_trackingCounter + 1) % 1_000_000)}`;
}

export class SerializationRegistry {
  private readonly codecs = new Map<string, FormatCodec<any>>();
  private readonly history: SerializationRecord[] = [];
  private readonly maxHistory: number;

  constructor(maxHistory = 1000) {
    this.maxHistory = maxHistory;
    this.codecs.set('json', jsonCodec);
    this.codecs.set('base64', base64Codec);
    this.codecs.set('hex', hexCodec);
    this.codecs.set('binary', binaryCodec);
  }

  /** Register a custom format codec. Throws if name is already registered. */
  registerFormat<T>(name: string, codec: FormatCodec<T>): this {
    if (!name) throw new Error('Format name is required');
    if (this.codecs.has(name)) throw new Error(`Format "${name}" is already registered`);
    this.codecs.set(name, codec);
    return this;
  }

  /** Override an existing format or add a new one (no duplicate check). */
  setFormat<T>(name: string, codec: FormatCodec<T>): this {
    if (!name) throw new Error('Format name is required');
    this.codecs.set(name, codec);
    return this;
  }

  unregisterFormat(name: string): boolean {
    const builtIn: SerializationFormat[] = ['json', 'base64', 'hex', 'binary'];
    if ((builtIn as string[]).includes(name)) throw new Error(`Cannot unregister built-in format "${name}"`);
    return this.codecs.delete(name);
  }

  hasFormat(name: string): boolean {
    return this.codecs.has(name);
  }

  listFormats(): string[] {
    return [...this.codecs.keys()];
  }

  /**
   * Serialize a value using the given format.
   * When `version` is provided the result is wrapped in a versioned envelope.
   */
  serialize<T>(
    value: T,
    format: SerializationFormat | string = 'json',
    version?: number,
  ): string | Uint8Array {
    const codec = this.codecs.get(format);
    if (!codec) throw new SerializationError(format, 'serialize', new Error(`Unknown format "${format}"`));

    const id = nextId();
    const start = Date.now();
    try {
      const payload: T | VersionedEnvelope<T> =
        version !== undefined ? { __v: version, __fmt: format, data: value } : value;
      const result = codec.serialize(payload);
      this.track({ id, format, version: version ?? 0, operation: 'serialize', ok: true, durationMs: Date.now() - start, timestamp: start });
      return result;
    } catch (e) {
      this.track({ id, format, version: version ?? 0, operation: 'serialize', ok: false, durationMs: Date.now() - start, timestamp: start, error: e instanceof Error ? e.message : String(e) });
      throw new SerializationError(format, 'serialize', e);
    }
  }

  /**
   * Deserialize a value. When `expectedVersion` is provided, validates the
   * envelope version and unwraps the inner `data`.
   */
  deserialize<T>(
    raw: string | Uint8Array,
    format: SerializationFormat | string = 'json',
    expectedVersion?: number,
  ): T {
    const codec = this.codecs.get(format);
    if (!codec) throw new SerializationError(format, 'deserialize', new Error(`Unknown format "${format}"`));

    const id = nextId();
    const start = Date.now();
    try {
      const parsed = codec.deserialize(raw) as unknown;
      let result: T;
      if (expectedVersion !== undefined) {
        const envelope = parsed as VersionedEnvelope<T>;
        if (envelope.__v === undefined) throw new Error('Missing version envelope (__v)');
        if (envelope.__v !== expectedVersion) {
          throw new Error(`Version mismatch: expected ${expectedVersion}, got ${envelope.__v}`);
        }
        result = envelope.data;
      } else {
        result = parsed as T;
      }
      this.track({ id, format, version: expectedVersion ?? 0, operation: 'deserialize', ok: true, durationMs: Date.now() - start, timestamp: start });
      return result;
    } catch (e) {
      this.track({ id, format, version: expectedVersion ?? 0, operation: 'deserialize', ok: false, durationMs: Date.now() - start, timestamp: start, error: e instanceof Error ? e.message : String(e) });
      throw new SerializationError(format, 'deserialize', e);
    }
  }

  getHistory(): SerializationRecord[] {
    return this.history.map((r) => ({ ...r }));
  }

  getStats(): Record<string, { serialize: number; deserialize: number; failures: number }> {
    const stats: Record<string, { serialize: number; deserialize: number; failures: number }> = {};
    for (const r of this.history) {
      const s = (stats[r.format] ??= { serialize: 0, deserialize: 0, failures: 0 });
      s[r.operation] += 1;
      if (!r.ok) s.failures += 1;
    }
    return stats;
  }

  clearHistory(): void {
    this.history.length = 0;
  }

  private track(record: SerializationRecord): void {
    this.history.push(record);
    if (this.history.length > this.maxHistory) this.history.shift();
  }
}

/** Default singleton registry */
let _defaultRegistry: SerializationRegistry | undefined;

export function getDefaultSerializationRegistry(): SerializationRegistry {
  if (!_defaultRegistry) _defaultRegistry = new SerializationRegistry();
  return _defaultRegistry;
}

export function resetDefaultSerializationRegistry(): void {
  _defaultRegistry = undefined;
}

/** Convenience wrappers using the default registry */
export function serialize<T>(
  value: T,
  format: SerializationFormat | string = 'json',
  version?: number,
): string | Uint8Array {
  return getDefaultSerializationRegistry().serialize(value, format, version);
}

export function deserialize<T>(
  raw: string | Uint8Array,
  format: SerializationFormat | string = 'json',
  expectedVersion?: number,
): T {
  return getDefaultSerializationRegistry().deserialize<T>(raw, format, expectedVersion);
}
