import type {
  WalletAdapter,
  WalletAccountChangeListener,
  WalletConnectResult,
} from "./types.js";

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
  topic: string;
  /** Stellar chain ID (e.g. "stellar:testnet"). */
  chainId: string;
  /** The connected wallet's Stellar public key. */
  address: string;
  /**
   * Relay URL used by the WalletConnect session.
   * Persisted alongside the topic so the session can be restored on reload.
   */
  relayUrl?: string;
  /**
   * Unix timestamp (seconds) at which the WalletConnect session expires.
   * When provided the adapter validates the expiry before restoring a stored
   * session and persists it so future restores can make the same check.
   */
  expiry?: number;
}

/** A custody solution authorized to sign on behalf of the connected wallet. */
export interface SigningDelegation {
  /** Address of the delegate authorized to sign. */
  delegate: string;
  /** Unix timestamp (ms) after which the delegation is no longer valid. */
  expiresAt: number;
}

/** Lifecycle event emitted when a signing delegation is created or revoked. */
export type SigningDelegationEvent =
  | { type: "delegation:created"; delegate: string; expiresAt: number }
  | { type: "delegation:revoked"; delegate: string };

/** Listener invoked for each emitted signing delegation event. */
export type SigningDelegationListener = (event: SigningDelegationEvent) => void;

/** Shape of the data written to / read from localStorage. */
interface PersistedSession {
  topic: string;
  relayUrl: string;
  chainId: string;
  address: string;
  /** Unix timestamp in seconds when this session expires. */
  expiry: number;
}

/** localStorage key used to store the active WalletConnect session. */
const STORAGE_KEY = "stellarsplit:wc:session";

/**
 * WalletConnect adapter — routes signing through a WalletConnect session
 * instead of the Freighter browser extension.
 *
 * ### Session persistence
 * On construction the adapter persists the session to `localStorage` so it
 * survives page reloads. Call the static `restore()` factory to hydrate an
 * adapter from a previously-persisted session without requiring the user to
 * scan a QR code again. `disconnect()` clears the stored data.
 */
export class WalletConnectAdapter implements WalletAdapter {
  /** Stable identifier used for wallet detection and switching. */
  readonly name = "walletconnect";

  private readonly opts: WalletConnectAdapterOptions;
  private readonly delegations = new Map<string, SigningDelegation>();
  private readonly listeners = new Set<SigningDelegationListener>();
  private readonly accountListeners = new Set<WalletAccountChangeListener>();
  private connected = true;

  constructor(opts: WalletConnectAdapterOptions) {
    this.opts = opts;
    // Persist the session immediately on construction.
    this.persistSession();
  }

  // ---------------------------------------------------------------------------
  // WalletAdapter interface
  // ---------------------------------------------------------------------------

  /**
   * A WalletConnect adapter is available when it holds a live client and an
   * active session topic.
   */
  isAvailable(): boolean {
    return Boolean(this.opts.client && this.opts.topic);
  }

  /**
   * Establish (or re-establish) the WalletConnect session.
   *
   * When the adapter already holds a valid session this resolves immediately
   * with the current address. Otherwise it attempts to restore a persisted
   * session; if none is valid the caller must perform a fresh pairing and
   * construct a new adapter.
   */
  async connect(): Promise<WalletConnectResult> {
    if (this.connected && this.isAvailable()) {
      return { address: this.opts.address, chainId: this.opts.chainId };
    }

    const restored = WalletConnectAdapter.restore(this.opts.client);
    if (restored) {
      this.connected = true;
      this.emitAccountChange(restored.opts.address);
      return { address: restored.opts.address, chainId: restored.opts.chainId };
    }

    throw new Error(
      "WalletConnect session is not available; a new pairing is required."
    );
  }

  async getAddress(): Promise<string> {
    return this.opts.address;
  }

  /**
   * Subscribe to account/session changes so wallet switching can react to
   * updates pushed by the WalletConnect session.
   */
  onAccountChange(listener: WalletAccountChangeListener): () => void {
    this.accountListeners.add(listener);
    return () => {
      this.accountListeners.delete(listener);
    };
  }

  /**
   * Authorize a custody solution to sign transactions on behalf of the
   * connected wallet until `expiresAt` (Unix ms).
   */
  delegateSigning(delegate: string, expiresAt: number): SigningDelegation {
    const delegation: SigningDelegation = { delegate, expiresAt };
    this.delegations.set(delegate, delegation);
    this.emit({ type: "delegation:created", delegate, expiresAt });
    return delegation;
  }

  /** Revoke a previously granted signing delegation. */
  revokeDelegation(delegate: string): boolean {
    const removed = this.delegations.delete(delegate);
    if (removed) {
      this.emit({ type: "delegation:revoked", delegate });
    }
    return removed;
  }

  /** List currently active (non-expired) signing delegations. */
  listDelegations(): SigningDelegation[] {
    const now = Date.now();
    return [...this.delegations.values()].filter((d) => d.expiresAt > now);
  }

  /** Subscribe to delegation lifecycle events. Returns an unsubscribe fn. */
  onDelegation(listener: SigningDelegationListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /** Notify delegation listeners of a lifecycle event. */
  private emit(event: SigningDelegationEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures must not break the adapter.
      }
    }
  }

  async signTransaction(xdr: string, network: string): Promise<string> {
    return this.opts.client.request({
      topic: this.opts.topic,
      chainId: this.opts.chainId,
      request: {
        method: "stellar_signXDR",
        params: { xdr, network },
      },
    });
  }

  /**
   * Clear the persisted session data from localStorage and reset internal
   * state so the user must reconnect after the next page load.
   */
  async disconnect(): Promise<void> {
    this.connected = false;
    WalletConnectAdapter.clearStoredSession();
    this.emitAccountChange(null);
  }

  // ---------------------------------------------------------------------------
  // Static helpers for session persistence
  // ---------------------------------------------------------------------------

  /**
   * Restore a previously-persisted WalletConnect session.
   *
   * Returns `null` when:
   * - no session has been stored, or
   * - the stored session has expired.
   *
   * The caller is responsible for providing the live WalletConnect `client`
   * instance; only the session metadata is read from localStorage.
   *
   * @example
   * ```ts
   * const adapter = WalletConnectAdapter.restore(signClient);
   * if (adapter) {
   *   // Session is still valid — no QR scan needed.
   * } else {
   *   // Show QR code and create a new adapter on successful pairing.
   * }
   * ```
   */
  static restore(
    client: WalletConnectAdapterOptions["client"]
  ): WalletConnectAdapter | null {
    const raw = WalletConnectAdapter.readRawSession();
    if (!raw) return null;

    // Validate expiry before restoring.
    const nowSeconds = Math.floor(Date.now() / 1000);
    if (raw.expiry <= nowSeconds) {
      // Stale session — clean up so the user is not stuck.
      WalletConnectAdapter.clearStoredSession();
      return null;
    }

    return new WalletConnectAdapter({
      client,
      topic: raw.topic,
      chainId: raw.chainId,
      address: raw.address,
      relayUrl: raw.relayUrl,
      expiry: raw.expiry,
    });
  }

  /**
   * Remove the persisted session entry from localStorage.
   * Called automatically by `disconnect()`.
   */
  static clearStoredSession(): void {
    try {
      if (typeof localStorage !== "undefined") {
        localStorage.removeItem(STORAGE_KEY);
      }
    } catch {
      // localStorage may be unavailable in some environments (e.g. SSR).
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Notify account-change listeners of a new address (or null on disconnect). */
  private emitAccountChange(address: string | null): void {
    for (const listener of this.accountListeners) {
      try {
        listener(address);
      } catch {
        // Listener failures must not break the adapter.
      }
    }
  }

  /** Write current session data to localStorage. */
  private persistSession(): void {
    try {
      if (typeof localStorage === "undefined") return;

      const data: PersistedSession = {
        topic: this.opts.topic,
        relayUrl: this.opts.relayUrl ?? "",
        chainId: this.opts.chainId,
        address: this.opts.address,
        // Default to 7 days from now if no expiry provided.
        expiry:
          this.opts.expiry ?? Math.floor(Date.now() / 1000) + 7 * 24 * 3600,
      };

      localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
    } catch {
      // Silently ignore write failures (storage quota, SSR, etc.).
    }
  }

  /** Parse raw stored session data without validation. Returns `null` on any error. */
  private static readRawSession(): PersistedSession | null {
    try {
      if (typeof localStorage === "undefined") return null;

      const raw = localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;

      const parsed = JSON.parse(raw) as Partial<PersistedSession>;

      // Basic shape validation.
      if (
        typeof parsed.topic !== "string" ||
        typeof parsed.chainId !== "string" ||
        typeof parsed.address !== "string" ||
        typeof parsed.expiry !== "number"
      ) {
        return null;
      }

      return parsed as PersistedSession;
    } catch {
      return null;
    }
  }
}
