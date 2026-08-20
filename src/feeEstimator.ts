export { detectFeeSurge, clearFeeSurgeCache } from "./feeSurgeDetector.js";
export type { FeeSurgeConfig, FeeRecommendation, CongestionLevel } from "./feeSurgeDetector.js";

/**
 * Fee estimator for operations using RPC simulation.
 *
 * Estimates operation costs without submitting transactions.
 *
 * For surge-aware fee estimation, use {@link detectFeeSurge} from
 * `./feeSurgeDetector.js`.
 */

import { StellarSplitError } from "./errors.js";
import {
  Account,
  TransactionBuilder,
  rpc as SorobanRpc,
  BASE_FEE,
} from "@stellar/stellar-sdk";

export interface FeeEstimate {
  baseFee: string;
  resourceFee: string;
  total: string;
}

/** Fee stats used by {@link estimateFeeForAmount}. */
export interface FeeStats {
  /** Base fee (stroops per operation). */
  baseFee: bigint;
  /** 50th-percentile (median) fee observed (stroops per operation). */
  p50Fee: bigint;
  /** 99th-percentile fee observed (stroops per operation). */
  p99Fee: bigint;
}

/**
 * Estimate the absolute fee (in stroops) and percentage for a payment amount.
 *
 * The estimated fee is derived from the base fee in `feeStats` and never
 * converted to a fractional number — it stays a `bigint` until the caller
 * computes the percentage.
 *
 * @param amount - Payment amount in stroops.
 * @param feeStats - Current on-chain fee statistics.
 * @returns Estimated fee in stroops, the fee as a percentage of the amount,
 *   and the total (amount + fee).
 * @throws {StellarSplitError} with code `INVALID_RECIPIENT` when `amount` is negative.
 */
export function estimateFeeForAmount(
  amount: bigint,
  feeStats: FeeStats,
): { feeLumens: bigint; feePercent: number; totalWithFee: bigint } {
  if (amount < 0n) {
    throw new StellarSplitError(
      "Amount cannot be negative",
      "INVALID_RECIPIENT",
    );
  }

  const feeLumens = feeStats.baseFee;
  const totalWithFee = amount + feeLumens;

  const feePercent = amount === 0n ? 0 : (Number(feeLumens) / Number(amount)) * 100;

  return { feeLumens, feePercent, totalWithFee };
}

export interface FeeEstimateError {
  error: string;
  baseFee: string;
  resourceFee: string;
  total: string;
}

/**
 * Estimate operation cost by simulating it.
 *
 * @param operation - Stellar operation to estimate
 * @param sourceAddress - Source account address
 * @param server - Soroban RPC server
 * @param networkPassphrase - Network passphrase
 * @returns Fee estimate with base and resource fees
 */
export async function estimateOperationCost(
  operation: Record<string, unknown>,
  sourceAddress: string,
  server: SorobanRpc.Server,
  networkPassphrase: string
): Promise<FeeEstimate | FeeEstimateError> {
  try {
    const account = new Account(sourceAddress, "0");
    const tx = new TransactionBuilder(account, {
      fee: BASE_FEE,
      networkPassphrase,
    })
      .addOperation(operation as any)
      .setTimeout(30)
      .build();

    const simResult = await server.simulateTransaction(tx);

    if ("error" in simResult && (simResult as any).error) {
      return {
        error: "Simulation failed",
        baseFee: BASE_FEE.toString(),
        resourceFee: "0",
        total: BASE_FEE.toString(),
      };
    }

    const successResult = simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse;
    const resourceFee = successResult.minResourceFee ?? "0";
    const baseFee = BASE_FEE.toString();
    const total = (BigInt(baseFee) + BigInt(resourceFee)).toString();

    return {
      baseFee,
      resourceFee,
      total,
    };
  } catch {
    return {
      error: "Unable to estimate",
      baseFee: BASE_FEE.toString(),
      resourceFee: "0",
      total: BASE_FEE.toString(),
    };
  }
}
