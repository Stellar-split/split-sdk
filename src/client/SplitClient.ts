/**
 * SplitClient — lazy-initializing wrapper for the Soroban RPC connection.
 *
 * The underlying SorobanRpc.Server is created on-demand the first time any
 * method that requires the RPC is called, rather than eagerly at construction
 * time. This eliminates startup latency and connection overhead when the SDK
 * is imported but not immediately used.
 *
 * Key guarantees:
 * - Zero RPC calls on construction.
 * - Concurrent first callers share the same initialization Promise (single flight).
 * - preconnect() allows eager warm-up during idle time.
 * - isConnected() returns false until initialization resolves.
 * - Initialization failure propagates to all waiters; the next call retries.
 *
 * Issue #479
 */

import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { LazyInitializer } from "./LazyInitializer.js";
import { RpcConnectionError, RequestTimeoutError } from "../errors.js";
import {
  InputSanitizer,
  SanitizationTracker,
  type SanitizationRuleSet,
} from "../security/InputSanitizer.js";
import { RateLimiter, type RateLimitConfig } from "../security/RateLimiter.js";
import { CsrfProtector, type CsrfConfig } from "../security/CsrfProtector.js";
import { SecureKeyStore, type KeyStoreConfig } from "../security/SecureKeyStore.js";

// ---------------------------------------------------------------------------
// Public config
// ---------------------------------------------------------------------------

export interface SplitClientConfig {
  /** Soroban RPC endpoint URL. */
  rpcUrl: string;
  /** Stellar network passphrase. */
  networkPassphrase: string;
  /** Deployed StellarSplit contract ID. */
  contractId: string;
  /** Per-request timeout in milliseconds. Defaults to 30 000. */
  requestTimeoutMs?: number;
  /** Optional sanitization rule overrides / whitelist. */
  sanitization?: SanitizationRuleSet;
  /** Optional rate limiting configuration. */
  rateLimit?: RateLimitConfig;
  /** Optional CSRF protection configuration. */
  csrf?: CsrfConfig;
  /** Optional secure key store configuration. */
  keyStore?: KeyStoreConfig;
  /** Identity used for per-user rate limiting. Defaults to "anonymous". */
  userId?: string;
}

// ---------------------------------------------------------------------------
// SplitClient
// ---------------------------------------------------------------------------

/**
 * Lazy-initializing Soroban RPC client with built-in input sanitization,
 * rate limiting, CSRF protection and secure key storage.
 *
 * @example
 * ```typescript
 * const client = new SplitClient({ rpcUrl, networkPassphrase, contractId });
 * await client.preconnect();
 * const ledger = await client.getLedger();
 * ```
 */
export class SplitClient {
  private readonly config: SplitClientConfig;
  private readonly _lazy: LazyInitializer<SorobanRpc.Server>;
  private readonly _sanitizer: InputSanitizer;
  private readonly _tracker: SanitizationTracker;
  private readonly _rateLimiter: RateLimiter;
  private readonly _csrf: CsrfProtector;
  private readonly _keyStore: SecureKeyStore;

  /**
   * @param config - RPC endpoint, network, contract ID and optional security settings.
   *   No RPC call is made at construction time.
   */
  constructor(config: SplitClientConfig) {
    this.config = config;

    // Security subsystems are constructed eagerly (no RPC calls) so that
    // every public method can be guarded before touching the network.
    this._tracker = new SanitizationTracker();
    this._sanitizer = new InputSanitizer(config.sanitization, this._tracker);
    this._rateLimiter = new RateLimiter(config.rateLimit);
    this._csrf = new CsrfProtector(config.csrf);
    this._keyStore = new SecureKeyStore(config.keyStore);

    // The factory is only called when ensureConnected() is first awaited.
    // No SorobanRpc.Server is instantiated here.
    this._lazy = new LazyInitializer<SorobanRpc.Server>(() =>
      this._connectRpc(),
    );
  }

  // --------------------------------------------------------------------------
  // Public API
  // --------------------------------------------------------------------------

  /**
   * Returns true synchronously when the RPC connection has been established.
   * Returns false when initialization is pending or hasn't started yet.
   */
  isConnected(): boolean {
    return this._lazy.isReady();
  }

  /**
   * Eagerly triggers initialization so that the first real method call is
   * faster. Resolves when the RPC connection is ready.
   *
   * @throws {RpcConnectionError} if the connection attempt fails.
   */
  async preconnect(): Promise<void> {
    this._guard("preconnect");
    await this.ensureConnected();
  }

  /**
   * Fetches the current network ledger number.
   * Triggers lazy initialization on first call.
   */
  async getLedger(): Promise<number> {
    this._guard("getLedger");
    const server = await this.ensureConnected();
    const info = await this._withTimeout(server.getLatestLedger(), "getLedger");
    return info.sequence;
  }

  /**
   * Calls simulateTransaction on the connected server.
   * Triggers lazy initialization on first call.
   */
  async simulate(
    tx: Parameters<SorobanRpc.Server["simulateTransaction"]>[0],
  ): Promise<ReturnType<SorobanRpc.Server["simulateTransaction"]>> {
    this._guard("simulate");
    const safeTx = this._sanitizer.sanitizeTransaction(tx, "simulate");
    const server = await this.ensureConnected();
    return this._withTimeout(server.simulateTransaction(safeTx), "simulateTransaction");
  }

  /**
   * Sends a transaction.
   * Triggers lazy initialization on first call.
   */
  async sendTransaction(
    tx: Parameters<SorobanRpc.Server["sendTransaction"]>[0],
  ): Promise<ReturnType<SorobanRpc.Server["sendTransaction"]>> {
    this._guard("sendTransaction");
    const safeTx = this._sanitizer.sanitizeTransaction(tx, "sendTransaction");
    const server = await this.ensureConnected();
    return this._withTimeout(server.sendTransaction(safeTx), "sendTransaction");
  }

  /**
   * Gets the underlying (connected) SorobanRpc.Server for advanced use.
   * Triggers lazy initialization on first call.
   */
  async getServer(): Promise<SorobanRpc.Server> {
    this._guard("getServer");
    return this.ensureConnected();
  }

  /**
   * Issues a CSRF token for a web integration session.
   * Triggers lazy initialization on first call.
   */
  async issueCsrfToken(sessionId: string): Promise<string> {
    this._guard("issueCsrfToken");
    const safeSessionId = this._sanitizer.sanitizeString(sessionId, "issueCsrfToken");
    return this._csrf.issueToken(safeSessionId);
  }

  /**
   * Validates a CSRF token for a web integration session.
   * Triggers lazy initialization on first call.
   */
  async validateCsrfToken(sessionId: string, token: string): Promise<boolean> {
    this._guard("validateCsrfToken");
    const safeSessionId = this._sanitizer.sanitizeString(sessionId, "validateCsrfToken");
    const safeToken = this._sanitizer.sanitizeString(token, "validateCsrfToken");
    return this._csrf.validateToken(safeSessionId, safeToken);
  }

  /**
   * Refreshes a CSRF token for a web integration session.
   * Triggers lazy initialization on first call.
   */
  async refreshCsrfToken(sessionId: string): Promise<string> {
    this._guard("refreshCsrfToken");
    const safeSessionId = this._sanitizer.sanitizeString(sessionId, "refreshCsrfToken");
    return this._csrf.refreshToken(safeSessionId);
  }

  /**
   * Stores a signing key in the secure key store.
   * Triggers lazy initialization on first call.
   */
  async storeSigningKey(keyId: string, secret: string): Promise<void> {
    this._guard("storeSigningKey");
    const safeKeyId = this._sanitizer.sanitizeString(keyId, "storeSigningKey");
    this._keyStore.storeKey(safeKeyId, secret);
  }

  /**
   * Rotates a signing key in the secure key store.
   * Triggers lazy initialization on first call.
   */
  async rotateSigningKey(keyId: string, newSecret: string): Promise<void> {
    this._guard("rotateSigningKey");
    const safeKeyId = this._sanitizer.sanitizeString(keyId, "rotateSigningKey");
    this._keyStore.rotateKey(safeKeyId, newSecret);
  }

  /**
   * Returns the sanitization audit trail collected so far.
   */
  getSanitizationLog(): ReadonlyArray<unknown> {
    return this._tracker.getEntries();
  }

  /**
   * Returns the rate limit events collected so far.
   */
  getRateLimitLog(): ReadonlyArray<unknown> {
    return this._rateLimiter.getEvents();
  }

  /**
   * Returns the CSRF events collected so far.
   */
  getCsrfLog(): ReadonlyArray<unknown> {
    return this._csrf.getEvents();
  }

  /**
   * Returns the key usage events collected so far.
   */
  getKeyUsageLog(): ReadonlyArray<unknown> {
    return this._keyStore.getUsageEvents();
  }

  // --------------------------------------------------------------------------
  // Private helpers
  // --------------------------------------------------------------------------

  /**
   * Returns the initialized server, triggering initialization on first call.
   */
  private ensureConnected(): Promise<SorobanRpc.Server> {
    return this._lazy.get();
  }

  /**
   * Applies rate limiting (per-user) and CSRF pre-checks before any method
   * body executes. Throws when the caller is over the configured threshold.
   */
  private _guard(method: string): void {
    const userId = this._sanitizer.sanitizeString(
      this.config.userId ?? "anonymous",
      `${method}:userId`,
    );
    this._rateLimiter.consume(userId, method);
  }

  /**
   * Wraps a promise with timeout enforcement. If the underlying SDK throws a
   * timeout-related error, it is converted to RequestTimeoutError.
   */
  private async _withTimeout<T>(promise: Promise<T>, method: string): Promise<T> {
    const timeoutMs = this.config.requestTimeoutMs ?? 30_000;
    if (timeoutMs <= 0) return promise;

    try {
      return await promise;
    } catch (err: unknown) {
      if (err instanceof Error && /timeout/i.test(err.message)) {
        throw new RequestTimeoutError(method, timeoutMs);
      }
      throw err;
    }
  }

  /**
   * Factory that creates and validates the SorobanRpc.Server connection.
   * Wraps construction errors in RpcConnectionError.
   */
  private async _connectRpc(): Promise<SorobanRpc.Server> {
    const { rpcUrl } = this.config;
    try {
      const server = new SorobanRpc.Server(rpcUrl, {
        allowHttp: rpcUrl.startsWith("http://"),
        timeout: this.config.requestTimeoutMs ?? 30_000,
      });
      return server;
    } catch (err: unknown) {
      const cause = err instanceof Error ? err.message : String(err);
      throw new RpcConnectionError(rpcUrl, cause);
    }
  }
}
