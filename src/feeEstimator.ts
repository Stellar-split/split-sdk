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

import {
  Account,
  TransactionBuilder,
  rpc as SorobanRpc,
  BASE_FEE,
} from "@stellar/stellar-sdk";
import { SdkError, SdkErrorCode } from "./errors.js";
import type { FeeStats } from "./types.js";

export type { FeeStats } from "./types.js";

export interface FeeEstimate {
  baseFee: string;
  resourceFee: string;
  total: string;
}

export interface FeeEstimateError {
  error: string;
  baseFee: string;
  resourceFee: string;
  total: string;
}

export interface FeeEstimationStrategy<TParams = unknown> {
  estimate(params: TParams): number;
}

export const SigningAlgorithmRegistry = new Map<string, never>();

const feeStrategyRegistry = new Map<string, FeeEstimationStrategy<any>>([
  ["fixed", { estimate: (params: { fee: number }) => params.fee }],
  ["percentile", { estimate: (params: { samples: number[]; percentile: number }) => {
    const sorted = [...params.samples].sort((a, b) => a - b);
    if (sorted.length === 0) return 0;
    const index = Math.min(sorted.length - 1, Math.floor((params.percentile / 100) * sorted.length));
    return sorted[index] ?? 0;
  } }],
  ["surge", { estimate: (params: { baseFee: number; multiplier: number }) => params.baseFee * params.multiplier }],
]);

export function estimateFee(type: string, params: unknown): number {
  const strategy = feeStrategyRegistry.get(type);
  if (!strategy) {
    throw new RangeError(`Unknown fee estimation strategy: ${type}`);
  }
  return strategy.estimate(params);
}

/**
 * Estimates transaction fee for a given payment amount based on fee statistics.
 *
 * @param amount - Payment amount in stroops (must be non-negative)
 * @param feeStats - Fee statistics including baseFee, p50Fee, and p99Fee
 * @returns Object with feeLumens (bigint), feePercent (number), and totalWithFee (bigint)
 * @throws {SdkError} with code `INVALID_RECIPIENT` if `amount` is negative
 */
export function estimateFeeForAmount(
  amount: bigint,
  feeStats: FeeStats,
): { feeLumens: bigint; feePercent: number; totalWithFee: bigint } {
  if (amount < 0n) {
    throw new SdkError(
      "Payment amount cannot be negative",
      SdkErrorCode.INVALID_RECIPIENT,
      { amount },
    );
  }

  const feeLumens = feeStats.baseFee;
  const totalWithFee = amount + feeLumens;
  const feePercent = amount === 0n ? 0 : (Number(feeLumens) / Number(amount)) * 100;

  return {
    feeLumens,
    feePercent,
    totalWithFee,
  };
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
