/**
 * Data transformation utilities: named transforms, custom transforms,
 * safe composition, and execution tracking.
 */

export type TransformFn<I = unknown, O = unknown> = (input: I) => O | Promise<O>;

export interface TransformRecord {
  name: string;
  ok: boolean;
  durationMs: number;
  error?: string;
  timestamp: number;
}

export class TransformError extends Error {
  constructor(
    public readonly transformName: string,
    public readonly cause: unknown,
  ) {
    super(
      `Transform "${transformName}" failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    this.name = "TransformError";
  }
}

/** Built-in transforms. */
export const builtInTransforms = {
  trim: (s: string): string => s.trim(),
  lowercase: (s: string): string => s.toLowerCase(),
  uppercase: (s: string): string => s.toUpperCase(),
  toNumber: (v: unknown): number => {
    const n = Number(v);
    if (Number.isNaN(n)) throw new Error(`Cannot convert ${String(v)} to number`);
    return n;
  },
  toString: (v: unknown): string => String(v),
  pick:
    <T extends object, K extends keyof T>(...keys: K[]) =>
    (obj: T): Pick<T, K> => {
      const out = {} as Pick<T, K>;
      for (const k of keys) if (k in obj) out[k] = obj[k];
      return out;
    },
  omit:
    <T extends object, K extends keyof T>(...keys: K[]) =>
    (obj: T): Omit<T, K> => {
      const out = { ...obj } as T;
      for (const k of keys) delete out[k];
      return out as Omit<T, K>;
    },
} as const;

export class TransformRegistry {
  private readonly transforms = new Map<string, TransformFn<any, any>>();
  private readonly history: TransformRecord[] = [];

  constructor(private readonly maxHistory = 1000) {
    for (const [name, fn] of Object.entries(builtInTransforms)) {
      if (name !== "pick" && name !== "omit") {
        this.transforms.set(name, fn as TransformFn<any, any>);
      }
    }
  }

  /** Register a custom transform. Throws if the name is already used. */
  register<I, O>(name: string, fn: TransformFn<I, O>): this {
    if (!name) throw new Error("Transform name is required");
    if (this.transforms.has(name)) {
      throw new Error(`Transform "${name}" is already registered`);
    }
    this.transforms.set(name, fn);
    return this;
  }

  unregister(name: string): boolean {
    return this.transforms.delete(name);
  }

  has(name: string): boolean {
    return this.transforms.has(name);
  }

  list(): string[] {
    return [...this.transforms.keys()];
  }

  /** Apply a single named transform, tracking the result. */
  async apply<O = unknown>(name: string, input: unknown): Promise<O> {
    const fn = this.transforms.get(name);
    if (!fn) throw new Error(`Unknown transform "${name}"`);
    return this.run(name, fn, input) as Promise<O>;
  }

  /** Compose named transforms (or functions) left to right into one function. */
  compose<O = unknown>(
    ...steps: Array<string | TransformFn<any, any>>
  ): (input: unknown) => Promise<O> {
    const resolved = steps.map((s, i) => {
      if (typeof s === "string") {
        const fn = this.transforms.get(s);
        if (!fn) throw new Error(`Unknown transform "${s}"`);
        return { name: s, fn };
      }
      return { name: s.name || `anonymous#${i}`, fn: s };
    });
    return async (input: unknown) => {
      let value = input;
      for (const step of resolved) value = await this.run(step.name, step.fn, value);
      return value as O;
    };
  }

  getHistory(): TransformRecord[] {
    return this.history.map((r) => ({ ...r }));
  }

  getStats(): Record<string, { calls: number; failures: number }> {
    const stats: Record<string, { calls: number; failures: number }> = {};
    for (const r of this.history) {
      const s = (stats[r.name] ??= { calls: 0, failures: 0 });
      s.calls += 1;
      if (!r.ok) s.failures += 1;
    }
    return stats;
  }

  clearHistory(): void {
    this.history.length = 0;
  }

  private async run(name: string, fn: TransformFn<any, any>, input: unknown): Promise<unknown> {
    const start = Date.now();
    try {
      const out = await fn(input);
      this.track({ name, ok: true, durationMs: Date.now() - start, timestamp: start });
      return out;
    } catch (e) {
      this.track({
        name,
        ok: false,
        durationMs: Date.now() - start,
        error: e instanceof Error ? e.message : String(e),
        timestamp: start,
      });
      throw new TransformError(name, e);
    }
  }

  private track(record: TransformRecord): void {
    this.history.push(record);
    if (this.history.length > this.maxHistory) this.history.shift();
  }
}

/** Compose plain functions left to right without a registry. */
export function composeTransforms<O = unknown>(
  ...fns: Array<TransformFn<any, any>>
): (input: unknown) => Promise<O> {
  return new TransformRegistry().compose<O>(...fns);
}
