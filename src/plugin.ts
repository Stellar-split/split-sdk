/**
 * Plugin/middleware system for StellarSplitClient.
 *
 * Plugins intercept SDK method calls to add logging, caching, retry logic,
 * or request transformation without forking the SDK.
 */

/** Method names that plugins can intercept. */
export type SdkMethodName = "createInvoice" | "pay";

/** A plugin that intercepts SDK method calls. */
export interface SdkPlugin<M extends SdkMethodName = SdkMethodName> {
  /** Unique plugin name. */
  name: string;
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

  use(plugin: SdkPlugin): void {
    if (this._plugins.some((p) => p.name === plugin.name)) {
      throw new Error(`Plugin "${plugin.name}" is already registered.`);
    }
    this._plugins.push(plugin);
  }

  removePlugin(name: string): void {
    const idx = this._plugins.findIndex((p) => p.name === name);
    if (idx !== -1) this._plugins.splice(idx, 1);
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

/** Built-in plugin that logs every call and its duration via console.debug. */
export const LoggingPlugin: SdkPlugin = {
  name: "LoggingPlugin",
  beforeCall(method, args) {
    (args as Record<string, unknown>).__logStart = Date.now();
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
