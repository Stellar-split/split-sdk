/**
 * MetaMaskAdapter — Adapter for MetaMask wallet provider.
 *
 * Provides connection, address retrieval, transaction signing, and account
 * change subscriptions via injected `window.ethereum` (or MetaMask provider).
 */

import type { WalletAdapter } from "../../types.js";
import { StellarSplitError } from "../../errors.js";

/** Install URL shown to users when MetaMask is not found. */
export const METAMASK_INSTALL_URL = "https://metamask.io/download/";

export class MetaMaskNotInstalledError extends StellarSplitError {
  constructor() {
    super(
      `MetaMask extension is not installed. Install it from ${METAMASK_INSTALL_URL}`,
      "METAMASK_NOT_INSTALLED",
      { installUrl: METAMASK_INSTALL_URL }
    );
    this.name = "MetaMaskNotInstalledError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class MetaMaskConnectionError extends StellarSplitError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "METAMASK_CONNECTION_ERROR", context);
    this.name = "MetaMaskConnectionError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class UserRejectedError extends StellarSplitError {
  constructor(action: string = "action") {
    super(`User rejected the ${action} request in MetaMask.`, "USER_REJECTED", { action });
    this.name = "UserRejectedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export interface MetaMaskProvider {
  isMetaMask?: boolean;
  request(args: { method: string; params?: unknown[] | Record<string, unknown> }): Promise<unknown>;
  on?(event: string, handler: (...args: any[]) => void): void;
  removeListener?(event: string, handler: (...args: any[]) => void): void;
}

export interface MetaMaskAdapterOptions {
  /** Optional custom Ethereum provider to override window.ethereum. */
  provider?: MetaMaskProvider;
}

export class MetaMaskAdapter implements WalletAdapter {
  readonly name = "MetaMask";
  private customProvider?: MetaMaskProvider;
  private connectedAddress: string | null = null;
  private accountChangeHandlers: Array<(address: string) => void> = [];
  private accountsChangedBound?: (accounts: string[]) => void;

  constructor(options: MetaMaskAdapterOptions = {}) {
    this.customProvider = options.provider;
  }

  private getProvider(): MetaMaskProvider | null {
    if (this.customProvider) return this.customProvider;
    if (typeof window !== "undefined" && (window as any).ethereum) {
      const eth = (window as any).ethereum;
      if (eth.providers && Array.isArray(eth.providers)) {
        return eth.providers.find((p: MetaMaskProvider) => p.isMetaMask) ?? eth;
      }
      return eth;
    }
    return null;
  }

  /** Check whether MetaMask is available in the current environment. */
  isAvailable(): boolean {
    const provider = this.getProvider();
    return provider !== null && (provider.isMetaMask === true || provider.request !== undefined);
  }

  /**
   * Connect to MetaMask and request account access.
   * Returns the connected public address.
   */
  async connect(): Promise<string> {
    const provider = this.getProvider();
    if (!provider) {
      throw new MetaMaskNotInstalledError();
    }

    try {
      const accounts = (await provider.request({
        method: "eth_requestAccounts",
      })) as string[];

      if (!accounts || accounts.length === 0) {
        throw new MetaMaskConnectionError("No accounts returned from MetaMask.");
      }

      this.connectedAddress = accounts[0]!;
      this.setupAccountChangeListener(provider);
      return this.connectedAddress;
    } catch (err: any) {
      if (err?.code === 4001 || err?.message?.includes("rejected")) {
        throw new UserRejectedError("connection");
      }
      throw new MetaMaskConnectionError(
        `Failed to connect to MetaMask: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Return the currently connected address. */
  async getAddress(): Promise<string> {
    if (this.connectedAddress) {
      return this.connectedAddress;
    }

    const provider = this.getProvider();
    if (!provider) {
      throw new MetaMaskNotInstalledError();
    }

    const accounts = (await provider.request({
      method: "eth_accounts",
    })) as string[];

    if (!accounts || accounts.length === 0) {
      throw new MetaMaskConnectionError("MetaMask is not connected. Call connect() first.");
    }

    this.connectedAddress = accounts[0]!;
    return this.connectedAddress;
  }

  /**
   * Sign a transaction XDR string using MetaMask.
   */
  async signTransaction(xdr: string, _network: string): Promise<string> {
    const address = await this.getAddress();
    const provider = this.getProvider();
    if (!provider) {
      throw new MetaMaskNotInstalledError();
    }

    try {
      const signature = (await provider.request({
        method: "personal_sign",
        params: [xdr, address],
      })) as string;

      return signature;
    } catch (err: any) {
      if (err?.code === 4001 || err?.message?.includes("rejected")) {
        throw new UserRejectedError("signing");
      }
      throw new MetaMaskConnectionError(
        `MetaMask transaction signing failed: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /** Disconnect the wallet session. */
  disconnect(): void {
    const provider = this.getProvider();
    if (provider && provider.removeListener && this.accountsChangedBound) {
      provider.removeListener("accountsChanged", this.accountsChangedBound);
    }
    this.connectedAddress = null;
    this.accountChangeHandlers = [];
  }

  /** Register an account change listener. */
  onAccountChange(handler: (address: string) => void): () => void {
    this.accountChangeHandlers.push(handler);

    const provider = this.getProvider();
    if (provider) {
      this.setupAccountChangeListener(provider);
    }

    return () => {
      this.accountChangeHandlers = this.accountChangeHandlers.filter((h) => h !== handler);
    };
  }

  private setupAccountChangeListener(provider: MetaMaskProvider): void {
    if (!provider.on || this.accountsChangedBound) return;

    this.accountsChangedBound = (accounts: string[]) => {
      const newAddress = accounts && accounts.length > 0 ? accounts[0]! : "";
      this.connectedAddress = newAddress || null;
      for (const handler of this.accountChangeHandlers) {
        try {
          handler(newAddress);
        } catch (e) {
          console.error("Error in MetaMask account change handler:", e);
        }
      }
    };

    provider.on("accountsChanged", this.accountsChangedBound);
  }
}
