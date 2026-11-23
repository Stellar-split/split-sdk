/**
 * Plugin/middleware system for StellarSplitClient.
 *
 * Plugins intercept SDK method calls to add logging, caching, retry logic,
 * or request transformation without forking the SDK. Plugins can also add
 * custom methods, subscribe to events, and intercept RPC calls.
 */

import { PluginAlreadyRegisteredError } from "./errors.js";

/** Method names that plugins can intercept. */
export type SdkMethodName = "createInvoice" | "pay";

/** Client context passed to plugin install method. */
export interface StellarSplitClientContext {
  on<E extends string>(event: E, handler: (payload: unknown) => void): () => void;
  off<E extends string>(event: E, handler: (payload: unknown) => void): void;
}

/** A plugin that intercepts SDK method calls and extends functionality. */
export interface SdkPlugin<M extends SdkMethodName = SdkMethodName> {
  /** Unique plugin name. */
  name: string;
  /**
   * Called when the plugin is installed on a client.
   * Can be used to add methods, subscribe to events, or initialize state.
   */
  install?(client: StellarSplitClientContext, options?: Record<string, unknown>): void;
  /** Called when the plugin is removed from the registry. */
  uninstall?(): void;
  /**
   * Called before a method executes. May return modified args.
   * Applied in registration order.
   */
  beforeCall?<K extends M>(method: K, args: PluginArgs<K>): PluginArgs<K>;
  /**
   * Called after a method succeeds. May return a modified result.
   * Applied in reverse registration order.
   */
  afterCall?<K extends M>(method: K, result: PluginResult<K>): PluginResult<K>;
  /** Called when a method throws. Applied in reverse registration order. */
  onError?(method: M, err: unknown): void;
}

/** Argument types per method. */
export type PluginArgs<M extends SdkMethodName> =
  M extends "createInvoice" ? import("./types.js").CreateInvoiceParams :
  M extends "pay" ? import("./types.js").PayParams :
  never;

/** Return types per method. */
export type PluginResult<M extends SdkMethodName> =
  M extends "createInvoice" ? { invoiceId: string; txHash: string } :
  M extends "pay" ? { txHash: string } :
  never;

/** Manages a list of registered SdkPlugins. */
export class PluginRegistry {
  private _plugins: SdkPlugin[] = [];
  private _clientContext?: StellarSplitClientContext;

  use(plugin: SdkPlugin, options?: Record<string, unknown>): void {
    if (this._plugins.some((p) => p.name === plugin.name)) {
      throw new PluginAlreadyRegisteredError(plugin.name);
    }
    this._plugins.push(plugin);
    if (this._clientContext && plugin.install) {
      plugin.install(this._clientContext, options);
    }
  }

  setClientContext(context: StellarSplitClientContext): void {
    this._clientContext = context;
  }

  removePlugin(name: string): void {
    const idx = this._plugins.findIndex((p) => p.name === name);
    if (idx !== -1) {
      const [removed] = this._plugins.splice(idx, 1);
      removed?.uninstall?.();
    }
  }

  getPlugins(): string[] {
    return this._plugins.map((p) => p.name);
  }

  runBeforeCall<M extends SdkMethodName>(method: M, args: PluginArgs<M>): PluginArgs<M> {
    let current = args;
    for (const p of this._plugins) {
      if (p.beforeCall) current = p.beforeCall(method, current) ?? current;
    }
    return current;
  }

  runAfterCall<M extends SdkMethodName>(method: M, result: PluginResult<M>): PluginResult<M> {
    let current = result;
    for (const p of [...this._plugins].reverse()) {
      if (p.afterCall) current = p.afterCall(method, current) ?? current;
    }
    return current;
  }

  runOnError(method: SdkMethodName, err: unknown): void {
    for (const p of [...this._plugins].reverse()) {
      p.onError?.(method, err);
    }
  }
}

/**
 * Compose several plugins into one. Hooks run in the given order for
 * beforeCall and in reverse for afterCall/onError; install/uninstall fan out.
 */
export function composePlugins(name: string, plugins: SdkPlugin[]): SdkPlugin {
  return {
    name,
    install(client, options) {
      plugins.forEach((p) => p.install?.(client, options));
    },
    uninstall() {
      [...plugins].reverse().forEach((p) => p.uninstall?.());
    },
    beforeCall(method, args) {
      let cur = args;
      for (const p of plugins) if (p.beforeCall) cur = p.beforeCall(method, cur) ?? cur;
      return cur;
    },
    afterCall(method, result) {
      let cur = result;
      for (const p of [...plugins].reverse()) if (p.afterCall) cur = p.afterCall(method, cur) ?? cur;
      return cur;
    },
    onError(method, err) {
      [...plugins].reverse().forEach((p) => p.onError?.(method, err));
    },
  };
}

/** Built-in plugin that logs every call and its duration via console.debug. */
export const LoggingPlugin: SdkPlugin = {
  name: "LoggingPlugin",
  beforeCall(method, args) {
    (args as unknown as Record<string, unknown>).__logStart = Date.now();
    console.debug(`[StellarSplit] ${method} called`, args);
    return args;
  },
  afterCall(method, result) {
    console.debug(`[StellarSplit] ${method} succeeded`, result);
    return result;
  },
  onError(method, err) {
    console.debug(`[StellarSplit] ${method} errored`, err);
  },
};

/** Built-in plugin that counts method calls per method name. */
export class MetricsPlugin implements SdkPlugin {
  readonly name = "MetricsPlugin";
  private callCounts = new Map<SdkMethodName, number>();

  getMetrics(): Record<string, number> {
    const result: Record<string, number> = {};
    for (const [method, count] of this.callCounts) {
      result[method] = count;
    }
    return result;
  }

  resetMetrics(): void {
    this.callCounts.clear();
  }

  afterCall<K extends SdkMethodName>(method: K, result: PluginResult<K>): PluginResult<K> {
    this.callCounts.set(method, (this.callCounts.get(method) ?? 0) + 1);
    return result;
  }
}