/**
 * WalletSessionManager — Multi-wallet support for Stellar browser extensions.
 * 
 * Detects installed wallet extensions (Freighter, LOBSTR, xBull), abstracts
 * their APIs into a unified WalletAdapter interface, and manages session lifecycle.
 */

import { EventEmitter } from "events";
import type { WalletAdapter } from "../types.js";
import { FreighterAdapter } from "./adapters/FreighterAdapter.js";
import { LobstrAdapter } from "./adapters/LobstrAdapter.js";
import { XBullAdapter } from "./adapters/XBullAdapter.js";

export interface SessionState {
  walletName: string;
  connectedAccount: string;
  timestamp: number;
}

export class WalletNotConnectedError extends Error {
  constructor() {
    super("No wallet is currently connected. Call connectWallet() first.");
    this.name = "WalletNotConnectedError";
  }
}

export class WalletSessionManager extends EventEmitter {
  private activeAdapter: WalletAdapter | null = null;
  private activeWalletName: string | null = null;
  private connectedAccount: string | null = null;
  private sessionKey = "stellarsplit:wallet:session";

  constructor() {
    super();
    this.restoreSession();
  }

  /**
   * Detect all installed wallet extensions in the browser.
   * Returns adapters for wallets that are available.
   */
  detect(): WalletAdapter[] {
    const adapters: WalletAdapter[] = [];

    // Check for Freighter
    if (typeof window !== "undefined" && (window as any).freighter) {
      adapters.push(new FreighterAdapter());
    }

    // Check for LOBSTR
    if (typeof window !== "undefined" && (window as any).lobstr) {
      adapters.push(new LobstrAdapter());
    }

    // Check for xBull
    if (typeof window !== "undefined" && (window as any).xbull) {
      adapters.push(new XBullAdapter());
    }

    return adapters;
  }

  /**
   * Connect to a wallet using the provided adapter.
   * Returns the connected Stellar public key.
   */
  async connect(adapter: WalletAdapter): Promise<string> {
    const address = await adapter.connect();
    
    this.activeAdapter = adapter;
    this.activeWalletName = adapter.name;
    this.connectedAccount = address;

    // Save session state
    this.saveSession();

    // Listen for account changes
    const unsubscribe = adapter.onAccountChange((newAddress) => {
      this.connectedAccount = newAddress;
      this.emit("accountChanged", newAddress);
      this.saveSession();
    });

    this.emit("connected", {
      walletName: adapter.name,
      address,
    });

    return address;
  }

  /**
   * Disconnect the currently active wallet.
   */
  disconnect(): void {
    if (this.activeAdapter) {
      this.activeAdapter.disconnect();
    }

    const previousWallet = this.activeWalletName;
    
    this.activeAdapter = null;
    this.activeWalletName = null;
    this.connectedAccount = null;

    this.clearSession();
    
    this.emit("disconnected", { walletName: previousWallet });
  }

  /**
   * Get the currently active wallet adapter.
   * Throws if no wallet is connected.
   */
  getActiveAdapter(): WalletAdapter {
    if (!this.activeAdapter) {
      throw new WalletNotConnectedError();
    }
    return this.activeAdapter;
  }

  /**
   * Get the currently connected account address.
   */
  getConnectedAccount(): string | null {
    return this.connectedAccount;
  }

  /**
   * Get the name of the currently connected wallet.
   */
  getWalletName(): string | null {
    return this.activeWalletName;
  }

  /**
   * Check if a wallet is currently connected.
   */
  isConnected(): boolean {
    return this.activeAdapter !== null && this.connectedAccount !== null;
  }

  /**
   * Save session state to sessionStorage for page reload recovery.
   */
  private saveSession(): void {
    if (typeof sessionStorage === "undefined") return;

    const state: SessionState = {
      walletName: this.activeWalletName || "",
      connectedAccount: this.connectedAccount || "",
      timestamp: Date.now(),
    };

    try {
      sessionStorage.setItem(this.sessionKey, JSON.stringify(state));
    } catch (err) {
      console.warn("Failed to save wallet session:", err);
    }
  }

  /**
   * Clear session state from sessionStorage.
   */
  private clearSession(): void {
    if (typeof sessionStorage === "undefined") return;

    try {
      sessionStorage.removeItem(this.sessionKey);
    } catch (err) {
      console.warn("Failed to clear wallet session:", err);
    }
  }

  /**
   * Restore session from sessionStorage on page reload.
   */
  private restoreSession(): void {
    if (typeof sessionStorage === "undefined") return;

    try {
      const stored = sessionStorage.getItem(this.sessionKey);
      if (!stored) return;

      const state: SessionState = JSON.parse(stored);
      
      // Check if session is still recent (within 1 hour)
      const age = Date.now() - state.timestamp;
      if (age > 3600000) {
        this.clearSession();
        return;
      }

      // Try to reconnect to the wallet
      const adapters = this.detect();
      const matchingAdapter = adapters.find(
        (a) => a.name === state.walletName
      );

      if (matchingAdapter) {
        // Silently restore the adapter
        this.activeAdapter = matchingAdapter;
        this.activeWalletName = state.walletName;
        this.connectedAccount = state.connectedAccount;

        // Set up account change listener
        matchingAdapter.onAccountChange((newAddress) => {
          this.connectedAccount = newAddress;
          this.emit("accountChanged", newAddress);
          this.saveSession();
        });
      } else {
        // Wallet no longer available
        this.clearSession();
      }
    } catch (err) {
      console.warn("Failed to restore wallet session:", err);
      this.clearSession();
    }
  }
}
