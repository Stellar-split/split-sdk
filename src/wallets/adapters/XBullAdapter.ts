/**
 * XBullAdapter — Adapter for the xBull wallet extension.
 *
 * Before connecting, the adapter reads `window.xBullSDK.version` and rejects
 * with an `ExtensionVersionError` when the installed version is older than
 * `MIN_XBULL_VERSION`. This prevents cryptic runtime errors caused by API
 * surface mismatches with outdated extension builds.
 */

import type { WalletAdapter } from "../../types.js";

type Unsubscribe = () => void;

declare global {
  interface Window {
    xbull?: {
      connect(): Promise<{ public_key: string }>;
      sign(params: { xdr: string; publicKey: string }): Promise<{ xdr: string }>;
      onAccountChange(handler: (publicKey: string) => void): () => void;
    };
    /** xBull SDK namespace that exposes the installed extension version. */
    xBullSDK?: {
      version: string;
    };
  }
}

/**
 * Minimum xBull extension version that supports the current API surface used
 * by this adapter. Versions below this value do not expose all required
 * methods and will cause cryptic runtime errors.
 *
 * Export this constant so integrators can display the required version in
 * their own UI if needed.
 */
export const MIN_XBULL_VERSION = "2.0.0";

/**
 * Thrown when the installed xBull extension version is older than
 * `MIN_XBULL_VERSION`.
 */
export class ExtensionVersionError extends Error {
  /** The version string reported by the installed extension. */
  readonly installedVersion: string;
  /** The minimum version required by this adapter. */
  readonly requiredVersion: string;

  constructor(installedVersion: string, requiredVersion: string) {
    super(
      `xBull extension version ${installedVersion} is below the required ` +
        `minimum version ${requiredVersion}. Please update the xBull extension.`
    );
    this.name = "ExtensionVersionError";
    this.installedVersion = installedVersion;
    this.requiredVersion = requiredVersion;
    // Maintain correct instanceof checks in transpiled environments.
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class XBullAdapter implements WalletAdapter {
  readonly name = "xBull";
  private accountChangeHandlers: Array<(address: string) => void> = [];
  private unsubscribe: (() => void) | null = null;
  private currentPublicKey: string | null = null;

  /** Check whether the xBull extension is available in the current environment. */
  isAvailable(): boolean {
    return typeof window !== "undefined" && !!window.xbull;
  }

  async connect(): Promise<string> {
    if (!window.xbull) {
      throw new Error("xBull wallet not installed");
    }

    // Verify the extension version before attempting to use its API.
    this.assertVersionCompatible();

    const result = await window.xbull.connect();
    this.currentPublicKey = result.public_key;
    
    // Set up account change listener
    this.setupAccountChangeListener();
    
    return result.public_key;
  }

  async sign(xdr: string): Promise<string> {
    if (!window.xbull || !this.currentPublicKey) {
      throw new Error("xBull wallet not connected");
    }

    const result = await window.xbull.sign({
      xdr,
      publicKey: this.currentPublicKey,
    });
    
    return result.xdr;
  }

  async getAddress(): Promise<string> {
    if (!window.xbull) {
      throw new Error("xBull wallet not installed");
    }

    if (this.currentPublicKey) {
      return this.currentPublicKey;
    }

    const result = await window.xbull.connect();
    this.currentPublicKey = result.public_key;
    return result.public_key;
  }

  async signTransaction(xdr: string, _network: string): Promise<string> {
    return this.sign(xdr);
  }

  disconnect(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.accountChangeHandlers = [];
    this.currentPublicKey = null;
  }

  onAccountChange(handler: (address: string) => void): Unsubscribe {
    this.accountChangeHandlers.push(handler);
    
    return () => {
      const index = this.accountChangeHandlers.indexOf(handler);
      if (index > -1) {
        this.accountChangeHandlers.splice(index, 1);
      }
    };
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * Compare the installed xBull extension version against `MIN_XBULL_VERSION`.
   * Throws `ExtensionVersionError` when the installed version is too old.
   *
   * If `window.xBullSDK.version` is not present the check is skipped to avoid
   * a false-positive on versions that do not yet expose the property.
   */
  private assertVersionCompatible(): void {
    const installed = window.xBullSDK?.version;
    if (!installed) return; // Cannot determine version; allow connection attempt.

    if (XBullAdapter.compareVersions(installed, MIN_XBULL_VERSION) < 0) {
      throw new ExtensionVersionError(installed, MIN_XBULL_VERSION);
    }
  }

  /**
   * Simple semver-style comparison.
   * Returns a negative number when `a < b`, 0 when equal, positive when `a > b`.
   */
  static compareVersions(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    const len = Math.max(pa.length, pb.length);

    for (let i = 0; i < len; i++) {
      const diff = (pa[i] ?? 0) - (pb[i] ?? 0);
      if (diff !== 0) return diff;
    }

    return 0;
  }

  private setupAccountChangeListener(): void {
    if (!window.xbull) return;

    // Drop the previous registration before installing a new one so that
    // repeated connect() calls (e.g. reconnect after a dropped session or a
    // component remount) never leave more than one live listener registered
    // with the wallet.  Mirrors the approach used by LobstrAdapter.
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }

    this.unsubscribe = window.xbull.onAccountChange((publicKey: string) => {
      this.currentPublicKey = publicKey;
      
      for (const handler of this.accountChangeHandlers) {
        try {
          handler(publicKey);
        } catch (err) {
          console.error("Error in account change handler:", err);
        }
      }
    });
  }
}
