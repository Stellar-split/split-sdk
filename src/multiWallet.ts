/**
 * MultiWallet — Unified multi-wallet management with connectors for MetaMask,
 * WalletConnect, and Ledger hardware wallets, including safe fallback handling.
 */

import { StellarSplitError } from "./errors.js";
import type { WalletAdapter } from "./types.js";
import {
  MetaMaskAdapter,
  MetaMaskNotInstalledError,
  MetaMaskConnectionError,
  UserRejectedError,
  type MetaMaskProvider,
} from "./wallets/adapters/MetaMaskAdapter.js";
import {
  WalletConnectAdapter,
  type WalletConnectAdapterOptions,
} from "./adapters/walletconnect.js";
import {
  LedgerAdapter,
  LedgerFirmwareTooOldError,
  type LedgerAdapterOptions,
} from "./adapters/ledger.js";
import {
  FreighterAdapter,
  FreighterNotInstalledError,
  FreighterConnectionError,
} from "./wallets/adapters/FreighterAdapter.js";

// Re-export specific adapters and errors
export {
  MetaMaskAdapter,
  MetaMaskNotInstalledError,
  MetaMaskConnectionError,
  UserRejectedError,
  WalletConnectAdapter,
  LedgerAdapter,
  LedgerFirmwareTooOldError,
  FreighterAdapter,
  FreighterNotInstalledError,
  FreighterConnectionError,
};
export type { WalletAdapter };

// ---------------------------------------------------------------------------
// Multi-Wallet Errors
// ---------------------------------------------------------------------------

export interface WalletAttemptLog {
  walletName: string;
  error: string;
  durationMs: number;
}

export class WalletFallbackExhaustedError extends StellarSplitError {
  readonly attempts: WalletAttemptLog[];

  constructor(attempts: WalletAttemptLog[]) {
    const summary = attempts.map((a) => `${a.walletName}: ${a.error}`).join("; ");
    super(
      `All wallet providers in fallback chain failed: ${summary}`,
      "WALLET_FALLBACK_EXHAUSTED",
      { attempts }
    );
    this.name = "WalletFallbackExhaustedError";
    this.attempts = attempts;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class WalletNotAvailableError extends StellarSplitError {
  readonly walletName: string;

  constructor(walletName: string) {
    super(`Wallet provider '${walletName}' is not available in the current environment.`, "WALLET_NOT_AVAILABLE", {
      walletName,
    });
    this.name = "WalletNotAvailableError";
    this.walletName = walletName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DuplicateWalletError extends StellarSplitError {
  readonly walletName: string;

  constructor(walletName: string) {
    super(`A wallet adapter named '${walletName}' is already registered.`, "DUPLICATE_WALLET", {
      walletName,
    });
    this.name = "DuplicateWalletError";
    this.walletName = walletName;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// Connectors
// ---------------------------------------------------------------------------

/**
 * Connector wrapping MetaMask.
 */
export class MetaMaskConnector implements WalletAdapter {
  readonly name = "MetaMask";
  private readonly adapter: MetaMaskAdapter;

  constructor(options: { provider?: MetaMaskProvider } = {}) {
    this.adapter = new MetaMaskAdapter(options);
  }

  isAvailable(): boolean {
    return this.adapter.isAvailable();
  }

  async connect(): Promise<string> {
    return this.adapter.connect();
  }

  async getAddress(): Promise<string> {
    return this.adapter.getAddress();
  }

  async signTransaction(xdr: string, network: string): Promise<string> {
    return this.adapter.signTransaction(xdr, network);
  }

  disconnect(): void {
    this.adapter.disconnect();
  }

  onAccountChange(handler: (address: string) => void): () => void {
    return this.adapter.onAccountChange(handler);
  }
}

/**
 * Connector wrapping WalletConnect.
 */
export class WalletConnectConnector implements WalletAdapter {
  readonly name = "WalletConnect";
  private adapter: WalletConnectAdapter | null = null;
  private readonly opts?: WalletConnectAdapterOptions;
  private connectedAddress: string | null = null;
  private readonly changeHandlers: Array<(addr: string) => void> = [];

  constructor(opts?: WalletConnectAdapterOptions) {
    this.opts = opts;
    if (opts) {
      this.adapter = new WalletConnectAdapter(opts);
      this.connectedAddress = opts.address;
    }
  }

  isAvailable(): boolean {
    return typeof localStorage !== "undefined" || this.adapter !== null;
  }

  async connect(): Promise<string> {
    if (!this.adapter && this.opts) {
      this.adapter = new WalletConnectAdapter(this.opts);
      this.connectedAddress = this.opts.address;
    }

    if (!this.adapter) {
      throw new StellarSplitError(
        "WalletConnectConnector requires options or active session to connect.",
        "WALLETCONNECT_NOT_CONFIGURED"
      );
    }

    const addr = await this.adapter.getAddress();
    this.connectedAddress = addr;
    return addr;
  }

  async getAddress(): Promise<string> {
    if (this.connectedAddress) return this.connectedAddress;
    if (!this.adapter) throw new StellarSplitError("WalletConnect is not connected.", "NOT_CONNECTED");
    return this.adapter.getAddress();
  }

  async signTransaction(xdr: string, network: string): Promise<string> {
    if (!this.adapter) throw new StellarSplitError("WalletConnect is not connected.", "NOT_CONNECTED");
    return this.adapter.signTransaction(xdr, network);
  }

  disconnect(): void {
    if (this.adapter) {
      this.adapter.disconnect();
      this.adapter = null;
    }
    this.connectedAddress = null;
    this.changeHandlers.forEach((h) => h(""));
  }

  onAccountChange(handler: (address: string) => void): () => void {
    this.changeHandlers.push(handler);
    return () => {
      const idx = this.changeHandlers.indexOf(handler);
      if (idx !== -1) this.changeHandlers.splice(idx, 1);
    };
  }

  /** Expose underlying adapter instance */
  getUnderlyingAdapter(): WalletConnectAdapter | null {
    return this.adapter;
  }
}

/**
 * Connector wrapping Ledger hardware wallet.
 */
export class LedgerConnector implements WalletAdapter {
  readonly name = "Ledger";
  private readonly adapter: LedgerAdapter;
  private connectedAddress: string | null = null;

  constructor(path?: string, options?: LedgerAdapterOptions) {
    this.adapter = new LedgerAdapter(path, options);
  }

  isAvailable(): boolean {
    return (
      typeof navigator !== "undefined" &&
      typeof (navigator as any).hid !== "undefined"
    );
  }

  async connect(): Promise<string> {
    const address = await this.adapter.getAddress();
    this.connectedAddress = address;
    return address;
  }

  async getAddress(): Promise<string> {
    if (this.connectedAddress) return this.connectedAddress;
    const address = await this.adapter.getAddress();
    this.connectedAddress = address;
    return address;
  }

  async signTransaction(xdr: string, network: string): Promise<string> {
    return this.adapter.signTransaction(xdr, network);
  }

  disconnect(): void {
    this.connectedAddress = null;
  }

  onAccountChange(_handler: (address: string) => void): () => void {
    // Hardware wallets don't emit browser account change events
    return () => {};
  }
}

// ---------------------------------------------------------------------------
// MultiWalletManager & Fallback Handling
// ---------------------------------------------------------------------------

export type MultiWalletEventType =
  | "wallet:connected"
  | "wallet:disconnected"
  | "wallet:account_changed"
  | "wallet:switched"
  | "fallback:attempted"
  | "fallback:succeeded"
  | "fallback:exhausted";

export interface MultiWalletEvent {
  type: MultiWalletEventType;
  walletName?: string;
  address?: string;
  error?: string;
  attempts?: WalletAttemptLog[];
  timestamp: number;
}

export type MultiWalletEventListener = (event: MultiWalletEvent) => void;

export interface MultiWalletOptions {
  /** Initial adapters to register, in priority order. */
  adapters?: WalletAdapter[];
  /** Whether to automatically fallback to next provider on connection error. Default: true. */
  autoFallback?: boolean;
}

export class MultiWalletManager {
  private adapters = new Map<string, WalletAdapter>();
  private defaultOrder: string[] = [];
  private activeAdapter: WalletAdapter | null = null;
  private connectedAddress: string | null = null;
  private autoFallback: boolean;
  private readonly listeners = new Set<MultiWalletEventListener>();
  private activeUnsubscribe?: () => void;

  constructor(options: MultiWalletOptions = {}) {
    this.autoFallback = options.autoFallback ?? true;

    if (options.adapters && options.adapters.length > 0) {
      for (const adapter of options.adapters) {
        this.registerAdapter(adapter);
      }
    }
  }

  /**
   * Register a wallet adapter.
   *
   * @throws {@link DuplicateWalletError} if an adapter with the same name is already registered.
   */
  registerAdapter(adapter: WalletAdapter): void {
    const key = adapter.name.toLowerCase();
    if (this.adapters.has(key)) {
      throw new DuplicateWalletError(adapter.name);
    }
    this.adapters.set(key, adapter);
    if (!this.defaultOrder.includes(key)) {
      this.defaultOrder.push(key);
    }
  }

  /**
   * Get all registered wallet adapters.
   */
  getAdapters(): WalletAdapter[] {
    return Array.from(this.adapters.values());
  }

  /**
   * Get an adapter by name (case-insensitive).
   */
  getAdapter(name: string): WalletAdapter | undefined {
    return this.adapters.get(name.toLowerCase());
  }

  /**
   * Detect which of the registered wallets are currently available in the environment.
   *
   * Uses each adapter's `isAvailable()` when present. MetaMask is detected via
   * `window.ethereum` and WalletConnect via a stored session (handled by their
   * respective adapters). Adapters without `isAvailable()` are treated as available.
   */
  async detectAvailable(): Promise<WalletAdapter[]> {
    const available: WalletAdapter[] = [];
    for (const adapter of this.adapters.values()) {
      if (typeof (adapter as any).isAvailable === "function") {
        let ok = false;
        try {
          ok = await (adapter as any).isAvailable();
        } catch {
          ok = false;
        }
        if (ok) available.push(adapter);
      } else {
        available.push(adapter);
      }
    }
    return available;
  }

  /**
   * Connect to a specific wallet by name.
   */
  async connect(walletName: string): Promise<string> {
    const adapter = this.getAdapter(walletName);
    if (!adapter) {
      throw new WalletNotAvailableError(walletName);
    }

    const address = await adapter.connect();
    this.setActiveSession(adapter, address);
    return address;
  }

  /**
   * Switch the active wallet to another registered wallet.
   *
   * Disconnects the currently active adapter (if any), connects the target
   * adapter, and re-subscribes account-change listeners. Emits a
   * `wallet:switched` event on success.
   *
   * @throws {@link WalletNotAvailableError} if the target wallet is not registered.
   */
  async switchWallet(walletName: string): Promise<string> {
    const target = this.getAdapter(walletName);
    if (!target) {
      throw new WalletNotAvailableError(walletName);
    }

    const previousName = this.activeAdapter?.name;

    // Tear down the current session before connecting the new wallet.
    if (this.activeUnsubscribe) {
      this.activeUnsubscribe();
      this.activeUnsubscribe = undefined;
    }
    if (this.activeAdapter) {
      try {
        this.activeAdapter.disconnect();
      } catch {
        // Ignore disconnect errors from the previous wallet.
      }
    }
    this.activeAdapter = null;
    this.connectedAddress = null;

    const address = await target.connect();
    this.setActiveSession(target, address);

    this.emit({
      type: "wallet:switched",
      walletName: target.name,
      address,
      timestamp: Date.now(),
    });

    // Keep the previous wallet name available for listeners that care.
    if (previousName && previousName !== target.name) {
      this.emit({
        type: "wallet:disconnected",
        walletName: previousName,
        timestamp: Date.now(),
      });
    }

    return address;
  }

  /**
   * Connect with safe fallback handling.
   *
   * Tries each wallet in order. If a wallet fails (not installed, rejected, timeout),
   * records the attempt and tries the next available wallet provider.
   *
   * @param preferredOrder - Optional custom order of wallet names to try.
   * @throws {@link WalletFallbackExhaustedError} when all providers fail.
   */
  async connectWithFallback(
    preferredOrder?: string[]
  ): Promise<{ adapter: WalletAdapter; address: string }> {
    const order = preferredOrder && preferredOrder.length > 0
      ? preferredOrder.map((s) => s.toLowerCase())
      : [...this.defaultOrder];

    if (order.length === 0) {
      throw new WalletFallbackExhaustedError([
        { walletName: "none", error: "No wallet adapters registered", durationMs: 0 },
      ]);
    }

    const attempts: WalletAttemptLog[] = [];

    for (const walletKey of order) {
      const adapter = this.adapters.get(walletKey);
      const walletName = adapter ? adapter.name : walletKey;

      if (!adapter) {
        attempts.push({
          walletName,
          error: "Wallet not registered",
          durationMs: 0,
        });
        continue;
      }

      const startTime = Date.now();
      try {
        const address = await adapter.connect();
        const durationMs = Date.now() - startTime;

        this.setActiveSession(adapter, address);

        this.emit({
          type: "fallback:succeeded",
          walletName: adapter.name,
          address,
          timestamp: Date.now(),
        });

        return { adapter, address };
      } catch (err) {
        const durationMs = Date.now() - startTime;
        const errMsg = err instanceof Error ? err.message : String(err);

        const attempt: WalletAttemptLog = {
          walletName: adapter.name,
          error: errMsg,
          durationMs,
        };
        attempts.push(attempt);

        this.emit({
          type: "fallback:attempted",
          walletName: adapter.name,
          error: errMsg,
          timestamp: Date.now(),
        });

        if (!this.autoFallback) {
          throw err;
        }
      }
    }

    this.emit({
      type: "fallback:exhausted",
      attempts,
      timestamp: Date.now(),
    });

    throw new WalletFallbackExhaustedError(attempts);
  }

  /**
   * Sign a transaction with the currently active wallet, with fallback support.
   */
  async signTransaction(xdr: string, network: string): Promise<string> {
    if (!this.activeAdapter) {
      throw new StellarSplitError(
        "No wallet currently connected. Connect a wallet before signing.",
        "WALLET_NOT_CONNECTED"
      );
    }
    return this.activeAdapter.signTransaction(xdr, network);
  }

  /**
   * Disconnect the active wallet session.
   */
  disconnect(): void {
    if (this.activeUnsubscribe) {
      this.activeUnsubscribe();
      this.activeUnsubscribe = undefined;
    }

    const prevName = this.activeAdapter?.name;
    if (this.activeAdapter) {
      this.activeAdapter.disconnect();
    }

    this.activeAdapter = null;
    this.connectedAddress = null;

    this.emit({
      type: "wallet:disconnected",
      walletName: prevName,
      timestamp: Date.now(),
    });
  }

  /** Return the currently active wallet adapter. */
  getActiveAdapter(): WalletAdapter | null {
    return this.activeAdapter;
  }

  /** Return the currently connected address. */
  getConnectedAccount(): string | null {
    return this.connectedAddress;
  }

  /** Check if a wallet is currently connected. */
  isConnected(): boolean {
    return this.activeAdapter !== null && this.connectedAddress !== null;
  }

  /** Subscribe to multi-wallet events. */
  onEvent(listener: MultiWalletEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private setActiveSession(adapter: WalletAdapter, address: string): void {
    if (this.activeUnsubscribe) {
      this.activeUnsubscribe();
      this.activeUnsubscribe = undefined;
    }

    this.activeAdapter = adapter;
    this.connectedAddress = address;

    this.activeUnsubscribe = adapter.onAccountChange((newAddress) => {
      this.connectedAddress = newAddress || null;
      this.emit({
        type: "wallet:account_changed",
        walletName: adapter.name,
        address: newAddress,
        timestamp: Date.now(),
      });
    });

    this.emit({
      type: "wallet:connected",
      walletName: adapter.name,
      address,
      timestamp: Date.now(),
    });
  }

  private emit(event: MultiWalletEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (e) {
        console.error("Error in MultiWalletManager listener:", e);
      }
    }
  }
}
