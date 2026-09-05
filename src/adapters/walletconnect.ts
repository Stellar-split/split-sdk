import type { WalletAdapter } from "./types.js";

/** Session data persisted to localStorage for recovery across reloads. */
export interface PersistedWalletConnectSession {
  topic: string;
  relayUrl: string;
  chainId: string;
  address: string;
  /** Unix timestamp (ms) when the session expires. */
  expiry: number;
}

/** Options for constructing a WalletConnectAdapter. */
export interface WalletConnectAdapterOptions {
  /** WalletConnect Sign Client instance (from @walletconnect/sign-client). */
  // Typed as unknown to avoid a hard dependency on @walletconnect/sign-client.
  client: {
    request(args: {
      topic: string;
      chainId: string;
      request: { method: string; params: unknown };
    }): Promise<string>;
  };
  /** Active WalletConnect session topic. */
  topic?: string;
  /** Stellar chain ID (e.g. "stellar:testnet"). */
  chainId?: string;
  /** The connected wallet's Stellar public key. */
  address?: string;
  /** WalletConnect relay URL. */
  relayUrl?: string;
  /** Session expiry timestamp (ms). */
  expiry?: number;
  /** localStorage key override (default: stellar_split_walletconnect_session). */
  storageKey?: string;
}

const DEFAULT_STORAGE_KEY = "stellar_split_walletconnect_session";

/**
 * WalletConnect adapter — routes signing through a WalletConnect session
 * instead of the Freighter browser extension.
 *
 * Automatically persists the active session to localStorage on connect
 * and restores it on construction when it has not expired.
 */
export class WalletConnectAdapter implements WalletAdapter {
  private readonly client: WalletConnectAdapterOptions["client"];
  private topic: string | undefined;
  private chainId: string | undefined;
  private addressValue: string | undefined;
  private relayUrl: string | undefined;
  private readonly storageKey: string;

  constructor(opts: WalletConnectAdapterOptions) {
    this.client = opts.client;
    this.storageKey = opts.storageKey ?? DEFAULT_STORAGE_KEY;

    if (opts.topic && opts.chainId && opts.address) {
      // Fresh connection supplied directly.
      this.topic = opts.topic;
      this.chainId = opts.chainId;
      this.addressValue = opts.address;
      this.relayUrl = opts.relayUrl;
      if (opts.expiry) {
        this.persist({
          topic: opts.topic,
          relayUrl: opts.relayUrl ?? "",
          chainId: opts.chainId,
          address: opts.address,
          expiry: opts.expiry,
        });
      }
    } else {
      // Attempt to restore a previously persisted session.
      this.restore();
    }
  }

  /** Returns true when a session (restored or explicitly set) is present. */
  get isConnected(): boolean {
    return this.topic !== undefined && this.addressValue !== undefined;
  }

  async getAddress(): Promise<string> {
    if (!this.addressValue) {
      throw new Error(
        "WalletConnect session not available. Connect or restore a session first."
      );
    }
    return this.addressValue;
  }

  async signTransaction(xdr: string, network: string): Promise<string> {
    if (!this.topic || !this.chainId) {
      throw new Error(
        "WalletConnect session not available. Connect or restore a session first."
      );
    }
    return this.client.request({
      topic: this.topic,
      chainId: this.chainId,
      request: {
        method: "stellar_signXDR",
        params: { xdr, network },
      },
    });
  }

  /**
   * Persists a successfully established session so it survives page reloads.
   * Call this once the WalletConnect pairing / session creation has completed.
   */
  persist(session: PersistedWalletConnectSession): void {
    this.topic = session.topic;
    this.chainId = session.chainId;
    this.addressValue = session.address;
    this.relayUrl = session.relayUrl;
    if (typeof localStorage !== "undefined") {
      localStorage.setItem(this.storageKey, JSON.stringify(session));
    }
  }

  /**
   * Clears the active session and removes persisted data from localStorage.
   * The underlying WalletConnect client should also be disconnected by the
   * caller (this adapter does not own the client lifecycle).
   */
  disconnect(): void {
    this.topic = undefined;
    this.chainId = undefined;
    this.addressValue = undefined;
    this.relayUrl = undefined;
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(this.storageKey);
    }
  }

  /** Attempts to restore a session from localStorage. */
  private restore(): void {
    if (typeof localStorage === "undefined") return;
    const raw = localStorage.getItem(this.storageKey);
    if (!raw) return;
    try {
      const session: PersistedWalletConnectSession = JSON.parse(raw);
      if (Date.now() >= session.expiry) {
        // Session has expired — clean it up.
        localStorage.removeItem(this.storageKey);
        return;
      }
      this.topic = session.topic;
      this.chainId = session.chainId;
      this.addressValue = session.address;
      this.relayUrl = session.relayUrl;
    } catch {
      // Malformed storage entry — discard.
      localStorage.removeItem(this.storageKey);
    }
  }
}
