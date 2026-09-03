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

export interface FeeForAmountOpts {
  feeBps?: number;
  baseFee?: bigint | number;
  roundUp?: boolean;
}

/**
 * Estimate the fee for a given payment amount using basis points.
 *
 * @param amount  - Payment amount in stroops (must be >= 0)
 * @param opts    - `feeBps`: fee rate in basis points (default 0); `baseFee`: flat
 *                  base fee added on top (default 100n); `roundUp`: round up
 *                  fractional stroop (default true)
 * @returns Total fee in stroops (proportional + baseFee)
 */
export function estimateFeeForAmount(
  amount: bigint,
  opts: FeeForAmountOpts = {},
): bigint {
  const { feeBps = 0, baseFee = BigInt(BASE_FEE), roundUp = true } = opts;

  if (amount < 0n) throw new RangeError("amount must be >= 0");
  if (feeBps < 0) throw new RangeError("feeBps must be >= 0");

  const base = typeof baseFee === "number" ? BigInt(baseFee) : baseFee;

  if (feeBps === 0) return base;

  const bps = BigInt(feeBps);
  const numerator = amount * bps;
  const proportional = numerator / 10000n;
  const remainder = numerator % 10000n;
  const rounded = roundUp && remainder > 0n ? proportional + 1n : proportional;

  return base + rounded;
}

export function estimateFee(type: string, params: unknown): number {
  const strategy = feeStrategyRegistry.get(type);
  if (!strategy) {
    throw new RangeError(`Unknown fee estimation strategy: ${type}`);
  }
  return strategy.estimate(params);
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
