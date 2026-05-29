/**
 * Protocol fee calculation for StellarSplit.
 */

import { Contract, rpc as SorobanRpc, TransactionBuilder, BASE_FEE, nativeToScVal, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { StellarSplitClientConfig } from "./client.js";

/** Fee breakdown for a payment amount. */
export interface FeeBreakdown {
  /** Gross amount before fee deduction. */
  gross: bigint;
  /** Protocol fee amount. */
  fee: bigint;
  /** Net amount recipient receives. */
  net: bigint;
  /** Fee basis points (1 bps = 0.01%). */
  feeBps: number;
}

/**
 * Calculate the protocol fee for a given amount.
 *
 * Fetches the current fee basis points from the contract and computes
 * the fee and net amounts.
 *
 * @param amount - Gross amount in stroops
 * @param config - Client configuration
 * @returns Fee breakdown with gross, fee, net, and feeBps
 */
export async function calculateFee(
  amount: bigint,
  config: StellarSplitClientConfig
): Promise<FeeBreakdown> {
  const server = new SorobanRpc.Server(config.rpcUrl, {
    allowHttp: config.rpcUrl.startsWith("http://"),
  });
  const contract = new Contract(config.contractId);

  const operation = contract.call("get_fee_bps");

  const account = await server.getAccount(config.contractId).catch(() => null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const sourceAccount = account ?? ({ accountId: () => config.contractId, sequenceNumber: () => "0", incrementSequenceNumber: () => {} } as any);

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new Error(`Simulation failed: ${simResult.error}`);
  }

  const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!returnVal) throw new Error("No return value from get_fee_bps");

  const feeBps = Number(scValToNative(returnVal));
  const fee = (amount * BigInt(feeBps)) / 10_000n;
  const net = amount - fee;

  return {
    gross: amount,
    fee,
    net,
    feeBps,
  };
}
