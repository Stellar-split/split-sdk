/**
 * GracefulShutdownHandler — coordinates Node.js process lifecycle events
 * (SIGTERM, SIGINT) with SDK cleanup: stops accepting new write operations,
 * drains in-flight Soroban RPC calls and transactions, tears down WebSocket
 * subscriptions, and resolves when the process is safe to exit.
 *
 * Usage:
 *   const deregister = GracefulShutdownHandler.register(client);
 *   // ... later, to remove the signal handlers:
 *   deregister();
 *
 * The handler tracks in-flight `submitTransaction()` calls and waits for
 * them to complete (or timeout). New transaction submissions throw
 * {@link ShutdownInProgressError} after shutdown is initiated. Once the
 * drain completes, the SDK's {@link StellarSplitClient.finalizeShutdown}
 * is invoked to tear down subscription managers, connection pools, and
 * other internal resources.
 */

import type { StellarSplitClient } from "../client.js";
import { ShutdownInProgressError } from "../errors.js";

/** Timeout behavior when in-flight requests do not complete within `drainTimeoutMs`. */
export type TimeoutAction = "force" | "error";

/** Configuration for graceful shutdown behavior. */
export interface ShutdownOptions {
  /**
   * Maximum time (ms) to wait for in-flight requests to complete before
   * taking the timeout action. Default: 30 000ms (30 seconds).
   */
  drainTimeoutMs?: number;

  /**
   * OS signals that trigger the shutdown sequence. Default: ["SIGTERM", "SIGINT"].
   */
  signals?: NodeJS.Signals[];

  /**
   * Behavior when `drainTimeoutMs` is exceeded:
   * - `"force"`: resolve the shutdown promise anyway; pending requests are abandoned.
   * - `"error"`: reject the shutdown promise with {@link ShutdownTimeoutError}.
   * Default: "force".
   */
  onTimeout?: TimeoutAction;
}

/** Thrown when the drain timeout expires and `onTimeout: "error"` is configured. */
export class ShutdownTimeoutError extends Error {
  constructor(
    public readonly pendingRequests: Array<{ id: string; method: string; startedAt: number }>,
    drainTimeoutMs: number,
  ) {
    super(
      `Shutdown timeout after ${drainTimeoutMs}ms; ${pendingRequests.length} request(s) still in flight`,
    );
    this.name = "ShutdownTimeoutError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

const DEFAULT_OPTIONS: Required<ShutdownOptions> = {
  drainTimeoutMs: 30_000,
  signals: ["SIGTERM", "SIGINT"],
  onTimeout: "force",
};

/**
 * Manages the graceful shutdown lifecycle for a {@link StellarSplitClient}.
 * Holds a reference to the client and the signal listeners so they can be
 * properly removed when {@link deregister} is called.
 */
class ShutdownHandlerInstance {
  private readonly client: StellarSplitClient;
  private readonly options: Required<ShutdownOptions>;
  private readonly signalListeners = new Map<NodeJS.Signals, () => void>();
  private shutdownPromise: Promise<void> | null = null;
  private shutdownResolve: (() => void) | null = null;
  private shutdownReject: ((err: Error) => void) | null = null;

  constructor(client: StellarSplitClient, options: ShutdownOptions = {}) {
    this.client = client;
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  /**
   * Attach OS signal handlers. Each handler triggers the shutdown sequence.
   * Returns a function that removes all attached listeners.
   */
  register(): () => void {
    for (const signal of this.options.signals) {
      const handler = () => {
        void this.shutdown();
      };
      process.on(signal, handler);
      this.signalListeners.set(signal, handler);
    }

    return () => this.deregister();
  }

  /**
   * Remove all attached signal listeners. After deregistering, the signals
   * no longer trigger the shutdown sequence.
   */
  deregister(): void {
    for (const [signal, handler] of this.signalListeners.entries()) {
      process.off(signal, handler);
    }
    this.signalListeners.clear();
  }

  /**
   * Initiate the shutdown sequence (idempotent). Returns a promise that
   * resolves when the shutdown completes or rejects if `onTimeout: "error"`
   * and the drain timeout is exceeded.
   */
  async shutdown(): Promise<void> {
    if (this.shutdownPromise) return this.shutdownPromise;

    this.shutdownPromise = new Promise<void>((resolve, reject) => {
      this.shutdownResolve = resolve;
      this.shutdownReject = reject;
    });

    void this._executeShutdown();
    return this.shutdownPromise;
  }

  private async _executeShutdown(): Promise<void> {
    try {
      // (1) Stop accepting new write operations
      this.client.beginGracefulShutdown();

      // (2) Await in-flight requests up to drainTimeoutMs
      const drainResult = await this._drainWithTimeout();

      if (!drainResult.completed && this.options.onTimeout === "error") {
        const err = new ShutdownTimeoutError(
          drainResult.pendingRequests,
          this.options.drainTimeoutMs,
        );
        this.shutdownReject?.(err);
        return;
      }

      // (3) Tear down subscriptions, connection pool, and other resources
      await this.client.finalizeShutdown();

      // (4) Resolve the shutdown promise
      this.shutdownResolve?.();
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error));
      this.shutdownReject?.(err);
    }
  }

  private async _drainWithTimeout(): Promise<{
    completed: boolean;
    pendingRequests: Array<{ id: string; method: string; startedAt: number }>;
  }> {
    const drainPromise = this.client.waitForInFlightRequests();
    const timeoutPromise = new Promise<never>((_, reject) => {
      setTimeout(() => reject(new Error("timeout")), this.options.drainTimeoutMs);
    });

    try {
      await Promise.race([drainPromise, timeoutPromise]);
      return { completed: true, pendingRequests: [] };
    } catch {
      // Timeout expired
      const pendingRequests = this.client.getInFlightRequests();
      return { completed: false, pendingRequests };
    }
  }
}

/**
 * Static API for attaching graceful shutdown handlers to a
 * {@link StellarSplitClient}. When the configured OS signals are received,
 * the handler stops accepting new writes, drains in-flight requests,
 * and tears down SDK resources before resolving a shutdown promise.
 */
export class GracefulShutdownHandler {
  /**
   * Attach signal handlers for graceful shutdown. Returns a function that
   * removes the handlers when called.
   *
   * @param client - The SDK client to manage during shutdown.
   * @param options - Optional shutdown configuration.
   * @returns A function that deregisters the signal handlers.
   *
   * @example
   * const client = new StellarSplitClient(config);
   * const deregister = GracefulShutdownHandler.register(client);
   * // ... later:
   * deregister();
   */
  static register(
    client: StellarSplitClient,
    options?: ShutdownOptions,
  ): () => void {
    const instance = new ShutdownHandlerInstance(client, options);
    return instance.register();
  }
}
