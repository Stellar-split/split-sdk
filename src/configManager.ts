/** Layered configuration management: loading, deep merging, environments. */

export type ConfigObject = { [key: string]: unknown };

export function deepMerge<T extends ConfigObject>(base: T, override: ConfigObject): T {
  const out: ConfigObject = { ...base };
  for (const [k, v] of Object.entries(override)) {
    const cur = out[k];
    if (isPlain(cur) && isPlain(v)) out[k] = deepMerge(cur, v);
    else if (v !== undefined) out[k] = v;
  }
  return out as T;
}

function isPlain(v: unknown): v is ConfigObject {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export type ConfigSource = ConfigObject | (() => ConfigObject | Promise<ConfigObject>);

export interface ConfigChange {
  source: string;
  at: number;
}

export class ConfigManager<T extends ConfigObject = ConfigObject> {
  private config: ConfigObject = {};
  private history: ConfigChange[] = [];
  private environments = new Map<string, ConfigObject>();

  constructor(private env: string = "default") {}

  /** Register overrides applied when the given environment is active. */
  defineEnvironment(name: string, overrides: ConfigObject): this {
    this.environments.set(name, overrides);
    return this;
  }

  setEnvironment(name: string): void {
    this.env = name;
  }

  getEnvironment(): string {
    return this.env;
  }

  /** Load a source (object or sync/async loader) and merge it over current config. */
  async load(source: ConfigSource, name = "anonymous"): Promise<void> {
    const data = typeof source === "function" ? await source() : source;
    this.config = deepMerge(this.config, data);
    this.history.push({ source: name, at: Date.now() });
  }

  /** Load from environment variables with a prefix, e.g. SPLIT_RPC_URL -> rpcUrl. */
  loadEnvVars(prefix: string, vars: Record<string, string | undefined> = process.env): void {
    const data: ConfigObject = {};
    for (const [k, v] of Object.entries(vars)) {
      if (v === undefined || !k.startsWith(prefix)) continue;
      const key = k
        .slice(prefix.length)
        .toLowerCase()
        .replace(/_([a-z])/g, (_, c: string) => c.toUpperCase());
      data[key] = v;
    }
    this.config = deepMerge(this.config, data);
    this.history.push({ source: `env:${prefix}`, at: Date.now() });
  }

  /** Effective config: base merged with the active environment's overrides. */
  get(): T {
    return deepMerge(this.config, this.environments.get(this.env) ?? {}) as T;
  }

  getHistory(): ConfigChange[] {
    return [...this.history];
  }
}
