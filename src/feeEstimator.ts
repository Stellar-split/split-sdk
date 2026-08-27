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

/** Options accepted by {@link estimateFeeForAmount}. */
export interface AmountFeeEstimateOptions {
  /**
   * Protocol fee in basis points (100 bps = 1%). Applied proportionally to
   * `amount`. Defaults to `0`.
   */
  feeBps?: number;

  /**
   * Flat base fee, in stroops, added on top of the proportional fee.
   * Defaults to the Stellar network {@link BASE_FEE}.
   */
  baseFee?: bigint;

  /**
   * When `true` the proportional fee is rounded **up** to the nearest stroop
   * so the estimate never undercharges due to fractional bps. Defaults to
   * `true`.
   */
  roundUp?: boolean;
}

/**
 * Estimate the fee for a given `amount` using exact `bigint` arithmetic.
 *
 * The fee is computed as:
 *
 *     fee = baseFee + ceil(amount * feeBps / 10_000)
 *
 * with `roundUp` controlling whether the proportional term is rounded up or
 * simply truncated. All arithmetic is performed on `bigint` stroops, so there
 * is no floating-point rounding or precision loss.
 *
 * @param amount - Gross amount in stroops; must be non-negative.
 * @param options - {@link AmountFeeEstimateOptions} controlling the fee.
 * @returns The estimated fee in stroops, always a non-negative `bigint`.
 * @throws {RangeError} if `amount` or `feeBps` is negative.
 */
export function estimateFeeForAmount(
  amount: bigint,
  options: AmountFeeEstimateOptions = {}
): bigint {
  const { feeBps = 0, baseFee = BigInt(BASE_FEE), roundUp = true } = options;

  if (amount < 0n) {
    throw new RangeError("amount must be non-negative");
  }
  if (feeBps < 0) {
    throw new RangeError("feeBps must be non-negative");
  }

  const proportionalBps = amount * BigInt(feeBps);
  const proportional = roundUp
    ? (proportionalBps + 9_999n) / 10_000n
    : proportionalBps / 10_000n;

  return baseFee + proportional;
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
