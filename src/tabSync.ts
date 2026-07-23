/**
 * Cross-tab state synchronizer using BroadcastChannel API.
 *
 * Ensures that when one browser tab invalidates or updates a cached invoice,
 * all other tabs sharing the same origin receive the invalidation event and
 * evict their local cache entry, preventing stale reads across tabs.
 */

import type { StellarSplitClient, StellarSplitPlugin } from "./client.js";

export type TabSyncEventType =
  | "invoice:invalidated"
  | "cache:cleared"
  | "invoice:updated"
  | "tab:ping";

export interface TabSyncEvent {
  type: TabSyncEventType;
  payload: unknown;
  tabId: string;
  timestamp: number;
}

export interface TabSyncOptions {
  /** BroadcastChannel name. Defaults to "stellar-split-sync". */
  channelName?: string;
  /** Whether to enable periodic pings to detect alive tabs. Defaults to false. */
  enablePings?: boolean;
  /** Ping interval in ms (only when enablePings is true). Defaults to 30000. */
  pingIntervalMs?: number;
}

const DEFAULT_CHANNEL = "stellar-split-sync";

/**
 * Manages cross-tab synchronisation via the BroadcastChannel API.
 *
 * Register as a plugin on StellarSplitClient so that cache invalidation
 * events are automatically broadcast to other tabs.
 */
export class TabSync {
  private channel: BroadcastChannel | null = null;
  private tabId: string;
  private client: StellarSplitClient | null = null;
  private options: Required<TabSyncOptions>;
  private pingInterval: ReturnType<typeof setInterval> | null = null;
  private handler: ((event: MessageEvent) => void) | null = null;

  constructor(options: TabSyncOptions = {}) {
    this.tabId = crypto.randomUUID?.() ?? Math.random().toString(36).slice(2);
    this.options = {
      channelName: options.channelName ?? DEFAULT_CHANNEL,
      enablePings: options.enablePings ?? false,
      pingIntervalMs: options.pingIntervalMs ?? 30000,
    };
  }

  /**
   * Connect to the BroadcastChannel. Call this during plugin `onInit`.
   */
  connect(client: StellarSplitClient): void {
    if (this.channel) return;
    this.client = client;

    try {
      this.channel = new BroadcastChannel(this.options.channelName);

      this.handler = (event: MessageEvent<TabSyncEvent>) => {
        const data = event.data;
        if (!data || data.tabId === this.tabId) return;
        this._handleEvent(data);
      };

      this.channel.addEventListener("message", this.handler);

      if (this.options.enablePings) {
        this.pingInterval = setInterval(() => {
          this._post("tab:ping", {});
        }, this.options.pingIntervalMs);
      }
    } catch {
      console.warn(
        "[TabSync] BroadcastChannel not available – cross-tab sync disabled"
      );
    }
  }

  /**
   * Disconnect from the BroadcastChannel. Call this during plugin `onDestroy`.
   */
  disconnect(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
    if (this.channel && this.handler) {
      this.channel.removeEventListener("message", this.handler);
      this.channel.close();
    }
    this.channel = null;
    this.handler = null;
    this.client = null;
  }

  /**
   * Broadcast a cache invalidation for the given invoiceId to all tabs.
   */
  broadcastInvalidation(invoiceId: string): void {
    this._post("invoice:invalidated", { invoiceId });
  }

  /**
   * Broadcast a full cache clear to all tabs.
   */
  broadcastCacheClear(): void {
    this._post("cache:cleared", {});
  }

  /**
   * Broadcast that an invoice has been updated with fresh data.
   */
  broadcastInvoiceUpdate(invoiceId: string): void {
    this._post("invoice:updated", { invoiceId });
  }

  private _post(type: TabSyncEventType, payload: unknown): void {
    if (!this.channel) return;
    const event: TabSyncEvent = {
      type,
      payload,
      tabId: this.tabId,
      timestamp: Date.now(),
    };
    try {
      this.channel.postMessage(event);
    } catch {
      // Silently fail
    }
  }

  private _handleEvent(data: TabSyncEvent): void {
    switch (data.type) {
      case "invoice:invalidated": {
        const { invoiceId } = data.payload as { invoiceId: string };
        this.client?.invalidateCache(invoiceId);
        break;
      }
      case "cache:cleared": {
        this.client?.clearCache();
        break;
      }
      case "invoice:updated": {
        const { invoiceId } = data.payload as { invoiceId: string };
        this.client?.invalidateCache(invoiceId);
        break;
      }
      case "tab:ping": {
        // Other tab is checking if we are alive — no action needed
        break;
      }
    }
  }
}

/**
 * Plugin wrapper that integrates TabSync with StellarSplitClient lifecycle.
 *
 * Wraps the client's `invalidateCache` and `clearCache` methods so that
 * invalidation events are automatically broadcast to all other tabs.
 *
 * Usage:
 *   const client = new StellarSplitClient({ ... });
 *   client.registerPlugin(tabSyncPlugin());
 */
export function tabSyncPlugin(options?: TabSyncOptions): StellarSplitPlugin {
  const sync = new TabSync(options);
  return {
    name: "tab-sync",
    install(client) {
      const origInvalidate = client.invalidateCache.bind(client);
      const origClear = client.clearCache.bind(client);

      client.invalidateCache = (invoiceId: string) => {
        origInvalidate(invoiceId);
        sync.broadcastInvalidation(invoiceId);
      };

      client.clearCache = () => {
        origClear();
        sync.broadcastCacheClear();
      };
    },
    onInit(client) {
      sync.connect(client);
    },
    onDestroy() {
      sync.disconnect();
    },
  };
}

/**
 * Convenience: attach cross-tab broadcast calls to the client's cache
 * invalidation methods via a plugin.
 */
export function createTabSyncPlugin(options?: TabSyncOptions): StellarSplitPlugin {
  return tabSyncPlugin(options);
}
