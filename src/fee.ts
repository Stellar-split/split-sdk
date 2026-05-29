/**
 * Fee estimation utilities for StellarSplit SDK.
 */

import {
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  xdr,
} from "@stellar/stellar-sdk";
import type { FeeEstimate } from "./types.js";

/**
 * Derive a congestion level from feeStats.
 *
 * Uses the ratio of the p50 (median) fee to the p99 (high-load) fee:
 *   - ratio >= 0.8  → low congestion   (fees are clustered near the median)
 *   - ratio >= 0.4  → medium congestion
 *   - ratio <  0.4  → high congestion  (p99 is much higher than p50)
 */
function deriveCongestion(
  feeStats: SorobanRpc.Api.GetFeeStatsResponse
): "low" | "medium" | "high" {
  const p50 = Number(feeStats.sorobanInclusionFee.p50);
  const p99 = Number(feeStats.sorobanInclusionFee.p99);

  if (p99 === 0) return "low";
  const ratio = p50 / p99;

  if (ratio >= 0.8) return "low";
  if (ratio >= 0.4) return "medium";
  return "high";
}

/**
 * Estimate the fee for a given operation by simulating it and fetching
 * current network fee statistics.
 *
 * @param server            - Soroban RPC server instance.
 * @param networkPassphrase - Stellar network passphrase.
 * @param contractId        - Contract ID used as the fallback source account.
 * @param operation         - The contract operation to estimate fees for.
 * @returns FeeEstimate with fee in stroops and a congestion indicator.
 */
export async function estimateFee(
  server: SorobanRpc.Server,
  networkPassphrase: string,
  contractId: string,
  operation: xdr.Operation
): Promise<FeeEstimate> {
  // Build a transaction for simulation (source account doesn't need to be real)
  const account = await server.getAccount(contractId).catch(() => null);
  const sourceAccount = account ?? ({
    accountId: () => contractId,
    sequenceNumber: () => "0",
    incrementSequenceNumber: () => {},
  } as Parameters<typeof TransactionBuilder>[0]);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const [simResult, feeStats] = await Promise.all([
    server.simulateTransaction(tx),
    server.getFeeStats(),
  ]);

  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Fee estimation failed: ${simResult.error}`);
  }

  const success = simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse;
  const fee = BigInt(success.minResourceFee ?? BASE_FEE);
  const congestion = deriveCongestion(feeStats);

  return { fee, congestion };
}
