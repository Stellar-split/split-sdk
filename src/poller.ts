/**
 * USDC balance polling utility.
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
