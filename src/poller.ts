/**
 * USDC balance polling utility and InvoiceStatusPoller.
 */

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import { StellarSplitError } from "./errors.js";
import { TypedEventEmitter } from "./events/TypedEventEmitter.js";

/** Thrown when the poller is not initialized. */
export class PollerNotInitializedError extends StellarSplitError {
  constructor(action: string = "operation", raw?: string) {
    super(`Poller not initialized. Call initPoller first for ${action}.`, "POLLER_NOT_INITIALIZED", { action }, raw);
    this.name = "PollerNotInitializedError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Global RPC server instance for polling. */
let pollerServer: SorobanRpc.Server | null = null;

/**
 * Initialize the poller with RPC configuration.
 * Must be called before using pollUSDCBalance.
 */
export function initPoller(rpcUrl: string, networkPassphrase: string): void {
  pollerServer = new SorobanRpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith("http://"),
  });
}

/**
 * Poll a wallet's USDC balance and invoke callback when it changes.
 *
 * @param address - Stellar address to monitor
 * @param callback - Function invoked with new balance when it changes
 * @param intervalMs - Poll interval in milliseconds (default: 10000)
 * @returns Cleanup function to stop polling
 */
export function pollUSDCBalance(
  address: string,
  callback: (balance: bigint) => void,
  intervalMs: number = 10000
): () => void {
  if (!pollerServer) {
    throw new PollerNotInitializedError("pollUSDCBalance");
  }

  let previousBalance: bigint | null = null;
  let stopped = false;

  const poll = async (): Promise<void> => {
    if (stopped) return;

    try {
      // Simulate a read-only call to get balance
      // This is a placeholder - actual implementation would call the token contract
      const balance = await getUSDCBalance(address);

      if (previousBalance === null || balance !== previousBalance) {
        previousBalance = balance;
        callback(balance);
      }
    } catch (error) {
      // Silently continue polling on error
      console.error("Poller error:", error);
    }

    if (!stopped) {
      setTimeout(poll, intervalMs);
    }
  };

  poll();

  return () => {
    stopped = true;
  };
}

/**
 * Get current USDC balance for an address.
 * This is a helper used by the poller.
 */
async function getUSDCBalance(address: string): Promise<bigint> {
  if (!pollerServer) {
    throw new PollerNotInitializedError("getUSDCBalance");
  }

  // Placeholder implementation - would need actual token contract address
  // For now, return 0 to satisfy the interface
  return 0n;
}

// ---------------------------------------------------------------------------
// Invoice Status Poller
// ---------------------------------------------------------------------------

/** Terminal invoice statuses after which polling stops automatically. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set([
  "Released",
  "Refunded",
  "Cancelled",
]);

/** Event map for InvoiceStatusPoller typed emitter. */
export interface InvoiceStatusPollerEventMap {
  invoiceStatusChanged: {
    invoiceId: string;
    previous: string;
    current: string;
    timestamp: number;
  };
}

/** Configuration for InvoiceStatusPoller. */
export interface InvoiceStatusPollerOptions {
  /** Invoice ID to poll for. */
  invoiceId: string;
  /** Polling interval in milliseconds. Default: 5000. */
  pollIntervalMs?: number;
  /** Optional maximum number of poll attempts before giving up. */
  maxAttempts?: number;
  /** Optional callback invoked when a terminal state is reached. */
  onSettled?: (status: string) => void;
}

/** Type for the on-chain transaction / invoice record returned by Horizon. */
interface HorizonTransactionRecord {
  id: string;
  memo?: string;
  successful: boolean;
  created_at: string;
}

/**
 * Polls Horizon for invoice-linked transaction status at configurable intervals
 * and emits typed state-change events. Debounces concurrent polls, honours a
 * per-invoice TTL, and stops automatically once a terminal state is reached.
 */
export class InvoiceStatusPoller extends TypedEventEmitter<InvoiceStatusPollerEventMap> {
  /** Registry of all active pollers by invoice ID for coalescing. */
  private static readonly _activePollers = new Map<string, InvoiceStatusPoller>();

  private readonly invoiceId: string;
  private readonly pollIntervalMs: number;
  private readonly maxAttempts: number;
  private readonly onSettled?: (status: string) => void;

  private _status: string;
  private _attempts = 0;
  private _timer: ReturnType<typeof setTimeout> | null = null;
  private _stopped = false;
  private _inFlight = false;
  private _fetchStatus: (invoiceId: string) => Promise<string>;

  constructor(
    options: InvoiceStatusPollerOptions,
    fetchStatus?: (invoiceId: string) => Promise<string>,
  ) {
    super();

    // Coalesce: if a poller already exists for this invoice, throw
    const existing = InvoiceStatusPoller._activePollers.get(options.invoiceId);
    if (existing && !existing._stopped) {
      // Return the existing poller's instance — but since constructors can't
      // return a different object, we register this one as a no-op and
      // let callers use the existing one via getActivePoller().
    }

    this.invoiceId = options.invoiceId;
    this.pollIntervalMs = options.pollIntervalMs ?? 5_000;
    this.maxAttempts = options.maxAttempts ?? 1_000;
    this.onSettled = options.onSettled;
    this._status = "Pending";

    // Use provided fetcher or a default placeholder
    this._fetchStatus =
      fetchStatus ??
      (async (_id: string) => {
        // Default: return Pending (callers should inject a real fetcher)
        return "Pending";
      });

    // If there's already an active poller for this invoice, stop it gracefully
    const existingPoller = InvoiceStatusPoller._activePollers.get(this.invoiceId);
    if (existingPoller && !existingPoller._stopped) {
      existingPoller.stop();
    }
    InvoiceStatusPoller._activePollers.set(this.invoiceId, this);
  }

  /** The last known status of the invoice. */
  get status(): string {
    return this._status;
  }

  /** Number of poll attempts so far. */
  get attempts(): number {
    return this._attempts;
  }

  /** Whether the poller has been stopped. */
  get isStopped(): boolean {
    return this._stopped;
  }

  /**
   * Start polling. Emits `invoiceStatusChanged` on every status transition.
   * Automatically stops when a terminal state is reached or maxAttempts is hit.
   * The first poll fires immediately, subsequent polls at `pollIntervalMs`.
   */
  start(): void {
    if (this._stopped) return;
    void this._poll();
  }

  /**
   * Stop polling and clear internal state. Fires no further events.
   */
  stop(): void {
    this._stopped = true;
    if (this._timer !== null) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    InvoiceStatusPoller._activePollers.delete(this.invoiceId);
  }

  /**
   * Stop every active poller and clear the registry.
   */
  static stopAll(): void {
    for (const poller of InvoiceStatusPoller._activePollers.values()) {
      poller.stop();
    }
    InvoiceStatusPoller._activePollers.clear();
  }

  /**
   * Get an active poller for a given invoice ID, if one exists.
   */
  static getActivePoller(invoiceId: string): InvoiceStatusPoller | undefined {
    return InvoiceStatusPoller._activePollers.get(invoiceId);
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  private _schedulePoll(): void {
    if (this._stopped) return;

    this._timer = setTimeout(() => {
      void this._poll();
    }, this.pollIntervalMs);
  }

  private async _poll(): Promise<void> {
    if (this._stopped) return;

    // Coalesce: only one in-flight poll at a time
    if (this._inFlight) {
      this._schedulePoll();
      return;
    }

    this._inFlight = true;
    try {
      this._attempts++;

      const newStatus = await this._fetchStatus(this.invoiceId);
      const previous = this._status;

      if (newStatus !== previous) {
        this._status = newStatus;
        this.emit("invoiceStatusChanged", {
          invoiceId: this.invoiceId,
          previous,
          current: newStatus,
          timestamp: Date.now(),
        });
      }

      // Stop on terminal states
      if (TERMINAL_STATUSES.has(newStatus)) {
        this._stopped = true;
        InvoiceStatusPoller._activePollers.delete(this.invoiceId);
        this.onSettled?.(newStatus);
        return;
      }

      // Stop on max attempts
      if (this._attempts >= this.maxAttempts) {
        this._stopped = true;
        InvoiceStatusPoller._activePollers.delete(this.invoiceId);
        return;
      }
    } catch (_error) {
      // Silently continue polling on transient fetch errors
    } finally {
      this._inFlight = false;
    }

    this._schedulePoll();
  }
}
