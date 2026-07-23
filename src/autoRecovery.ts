/**
 * Auto-recovery monitor for RPC endpoint health.
 *
 * Continuously monitors RPC health and automatically switches endpoints
 * when sustained failures are detected.
 */

import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { checkRPCHealth } from "./health.js";
import { LoadBalancer } from "./loadBalancer.js";
import type { StellarSplitClient } from "./client.js";

export interface AutoRecoveryOptions {
  failureThreshold?: number;
  pollingIntervalMs?: number;
  onSwitch?: (fromUrl: string, toUrl: string, reason: string) => void;
}

/**
 * Monitor for RPC health with automatic endpoint switching.
 */
export class AutoRecoveryMonitor {
  private intervalId: NodeJS.Timeout | null = null;
  private readonly failureThreshold: number;
  private readonly pollingIntervalMs: number;
  private readonly onSwitch: (fromUrl: string, toUrl: string, reason: string) => void;

  constructor(options: AutoRecoveryOptions = {}) {
    this.failureThreshold = options.failureThreshold ?? 3;
    this.pollingIntervalMs = options.pollingIntervalMs ?? 30_000;
    this.onSwitch = options.onSwitch ?? (() => {});
  }

  /**
   * Start monitoring RPC health.
   *
   * @param client - StellarSplitClient instance with server and loadBalancer
   */
  async start(
    client: any
  ): Promise<void> {
    if (this.intervalId !== null) {
      return;
    }

    this.intervalId = setInterval(async () => {
      try {
        const health = await checkRPCHealth(client.server);

        if (health.status === "ok") {
          return;
        }

        const currentState = client.loadBalancer.getEndpointStates();
        for (const endpoint of currentState) {
          if (endpoint.consecutiveFailures >= this.failureThreshold && endpoint.healthy) {
            const nextEndpoint = client.loadBalancer.selectEndpoint();
            this.onSwitch(endpoint.url, nextEndpoint, `Sustained unhealthy: ${health.status}`);
          }
        }
      } catch {
        // Silently ignore monitoring errors
      }
    }, this.pollingIntervalMs);
  }

  /**
   * Stop monitoring RPC health.
   */
  stop(): void {
    if (this.intervalId !== null) {
      clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }
}
