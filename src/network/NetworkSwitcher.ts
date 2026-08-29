import { NetworkPassphraseValidator } from "./NetworkPassphraseValidator";
import { PassphraseMismatchError } from "../errors";

/** Function to flush pending operations before network switch. */
export type FlushPendingFn = () => Promise<void>;

/** Options for network switching behavior. */
export interface NetworkSwitcherOptions {
  /** Timeout in ms for flushing pending operations. Defaults to 5000. */
  flushTimeoutMs?: number;
}

export class NetworkSwitcher {
  /**
   * Switches the network and clears all SDK state to prevent data leakage between networks.
   * Awaits pending operations to complete before switching the network endpoint.
   *
   * @param network - Target network ('mainnet', 'testnet', or 'futurenet')
   * @param client - The SplitClient instance
   * @param flushPending - Injected function to flush pending operations
   * @param options - Configuration options
   */
  static async switchNetwork(
    network: 'mainnet' | 'testnet' | 'futurenet',
    client: any, // Using any here to avoid circular dependency with SplitClient
    flushPending: FlushPendingFn,
    options: NetworkSwitcherOptions = {},
  ): Promise<void> {
    const flushTimeoutMs = options.flushTimeoutMs ?? 5000;

    try {
      client.emit('network:switching', { network });

      // 0. Flush pending operations before switching
      try {
        const flushPromise = flushPending();
        await Promise.race([
          flushPromise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error('Flush pending timeout')),
              flushTimeoutMs,
            ),
          ),
        ]);
      } catch (error) {
        console.warn(
          `[NetworkSwitcher] Flush pending operations timed out or failed: ${error instanceof Error ? error.message : String(error)}. Proceeding with network switch.`,
        );
      }

      // 1. Drain subscriptions
      if (client.subscriptionManager) {
        client.subscriptionManager.stopAll();
      }

      // 2. Clear all caches (As required by AC)
      if (client.cache) {
        client.cache.clear(); // Response cache
      }
      if (client.contractPool) {
        client.contractPool.clear(); // Contract pool cache
      }
      if (client.federationCache) {
        client.federationCache.clear();
      }

      // 3. Update configuration
      const config = client.options.networks[network];
      if (!config) throw new Error(`Configuration for ${network} missing.`);

      client.rpcUrl = config.rpcUrl;
      client.networkPassphrase = config.networkPassphrase;

      // 4. Re-initialize RPC Connection
      client.reinitializeRpc();

      // 5. Re-subscribe
      if (client.subscriptionManager) {
        await client.subscriptionManager.resubscribeAll();
      }

      client.emit('network:switched', { network, rpcUrl: client.rpcUrl });
    } catch (error) {
      client.emit('network:switchFailed', { network, error });
      throw error;
    }
  }

  /**
   * @deprecated Use switchNetwork instead
   */
  static async switchTo(
    network: 'mainnet' | 'testnet' | 'futurenet',
    client: any,
  ): Promise<void> {
    return this.switchNetwork(network, client, async () => {
      // Default no-op flush for backwards compatibility
    });
  }
}
