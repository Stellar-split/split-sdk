import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type { SDKHealth } from "./types.js";

type HealthServer = SorobanRpc.Server;

let totalCalls = 0;
let errorCalls = 0;
let startTime = Date.now();
let serverRef: HealthServer | null = null;
let dedupRef: { cacheHitRate: number } | null = null;

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

export async function getSDKHealth(): Promise<SDKHealth> {
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

  return { rpcLatency, cacheHitRate, errorRate, uptimeMs };
}

export function resetSDKHealth(): void {
  totalCalls = 0;
  errorCalls = 0;
  startTime = Date.now();
}
