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
}

// ---------------------------------------------------------------------------
// SplitClient
// ---------------------------------------------------------------------------

export class SplitClient {
  private readonly config: SplitClientConfig;
  private readonly _lazy: LazyInitializer<SorobanRpc.Server>;

  constructor(config: SplitClientConfig) {
    this.config = config;

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
    await this.ensureConnected();
  }

  /**
   * Fetches the current network ledger number.
   * Triggers lazy initialization on first call.
   */
  async getLedger(): Promise<number> {
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
    const server = await this.ensureConnected();
    return this._withTimeout(server.simulateTransaction(tx), "simulateTransaction");
  }

  /**
   * Sends a transaction.
   * Triggers lazy initialization on first call.
   */
  async sendTransaction(
    tx: Parameters<SorobanRpc.Server["sendTransaction"]>[0],
  ): Promise<ReturnType<SorobanRpc.Server["sendTransaction"]>> {
    const server = await this.ensureConnected();
    return this._withTimeout(server.sendTransaction(tx), "sendTransaction");
  }

  /**
   * Gets the underlying (connected) SorobanRpc.Server for advanced use.
   * Triggers lazy initialization on first call.
   */
  async getServer(): Promise<SorobanRpc.Server> {
    return this.ensureConnected();
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
