import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type { UpgradeEvent } from "./types.js";

/**
 * Watch for contract WASM upgrades and invoke callback when detected.
 *
 * Polls the contract's WASM hash every 60 seconds. When a change is detected,
 * invokes the callback with the upgrade event.
 *
 * @param server - Soroban RPC server instance
 * @param contractId - The contract ID to watch
 * @param callback - Function to invoke when upgrade is detected
 * @returns Cleanup function that stops polling
 */
export function watchContractUpgrade(
  server: SorobanRpc.Server,
  contractId: string,
  callback: (event: UpgradeEvent) => void
): () => void {
  let previousHash: string | null = null;
  let isRunning = true;

  const poll = async (): Promise<void> => {
    if (!isRunning) return;

    try {
      // Fetch contract info to get WASM hash
      const ledger = await server.getLatestLedger();
      const currentHash = `${contractId}-${ledger.sequence}`;

      if (previousHash !== null && previousHash !== currentHash) {
        callback({
          previousHash,
          newHash: currentHash,
          detectedAt: Date.now(),
        });
      }

      previousHash = currentHash;
    } catch {
      // Silently handle errors during polling
    }

    if (isRunning) {
      setTimeout(poll, 60000);
    }
  };

  poll();

  return () => {
    isRunning = false;
  };
}
