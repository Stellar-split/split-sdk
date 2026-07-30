import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type { SDKHealth } from "./types.js";
import type { HorizonProber, HorizonProbeResult } from "./horizonProber.js";

type HealthServer = SorobanRpc.Server;

let totalCalls = 0;
let errorCalls = 0;
let startTime = Date.now();
let serverRef: HealthServer | null = null;
let dedupRef: { cacheHitRate: number } | null = null;
let horizonProberRef: HorizonProber | null = null;

export function recordCall(success: boolean): void {
  totalCalls++;
  if (!success) errorCalls++;
}

export function initHealthDashboard(
  server: HealthServer,
  dedup: { cacheHitRate: number }
): void {
  serverRef = server;
  dedupRef = dedup;
}

/**
 * Register a {@link HorizonProber} with the health dashboard.
 * Its last probe result will be included in the snapshot returned by
 * {@link getSDKHealth}.
 */
export function registerHorizonProber(prober: HorizonProber): void {
  horizonProberRef = prober;
}

/** Extended SDK health snapshot that includes the Horizon prober result. */
export interface SDKHealthSnapshot extends SDKHealth {
  /** Most recent result from the registered {@link HorizonProber}, if any. */
  horizonProbe: HorizonProbeResult | null;
}

export async function getSDKHealth(): Promise<SDKHealthSnapshot> {
  const latencyStart = Date.now();
  let rpcLatency = 0;

  if (serverRef) {
    try {
      await serverRef.getLatestLedger();
      rpcLatency = Date.now() - latencyStart;
    } catch {
      rpcLatency = Date.now() - latencyStart;
    }
  }

  const errorRate = totalCalls === 0 ? 0 : errorCalls / totalCalls;
  const cacheHitRate = dedupRef ? dedupRef.cacheHitRate : 0;
  const uptimeMs = Date.now() - startTime;
  const horizonProbe = horizonProberRef ? horizonProberRef.getLastResult() : null;

  return { rpcLatency, cacheHitRate, errorRate, uptimeMs, horizonProbe };
}

export function resetSDKHealth(): void {
  totalCalls = 0;
  errorCalls = 0;
  startTime = Date.now();
}
