import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import type { RPCHealth } from "./types.js";

/**
 * Check the health of the configured RPC endpoint.
 *
 * @param server - Soroban RPC server instance
 * @returns Health status with latency and block height
 */
export async function checkRPCHealth(server: SorobanRpc.Server): Promise<RPCHealth> {
  const startTime = Date.now();

  try {
    const ledger = await server.getLatestLedger();
    const latencyMs = Date.now() - startTime;

    const status = latencyMs > 2000 ? "degraded" : "ok";

    return {
      status,
      latencyMs,
      blockHeight: ledger.sequence,
      timestamp: Date.now(),
    };
  } catch {
    return {
      status: "down",
      latencyMs: Date.now() - startTime,
      blockHeight: 0,
      timestamp: Date.now(),
    };
  }
}
