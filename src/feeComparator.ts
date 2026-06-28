/**
 * Fee comparator for invoice payment funding paths.
 *
 * Compares estimated total cost of direct token payment vs. DEX swap path
 * to recommend the cheaper option.
 */

import {
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { Invoice } from "./types.js";
import { SimulationFailedError, NoReturnValueError } from "./errors.js";

export interface CostEstimate {
  resourceFee: bigint;
  swapSlippage: bigint;
  totalCost: bigint;
}

export interface FundingPathComparison {
  direct: CostEstimate | "unsupported";
  swap: CostEstimate | "unsupported";
  recommended: "direct" | "swap";
}

export interface FeeComparatorConfig {
  rpcUrl: string;
  networkPassphrase: string;
  contractId: string;
  dexContractId?: string;
}

async function simulateResourceFee(
  server: SorobanRpc.Server,
  contractId: string,
  method: string,
  networkPassphrase: string,
  ...args: any[]
): Promise<bigint> {
  const contract = new Contract(contractId);
  const operation = contract.call(method, ...args);

  const sourceAccount = {
    accountId: () => contractId,
    sequenceNumber: () => "0",
    incrementSequenceNumber: () => {},
  } as any;

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new SimulationFailedError(`Simulation failed: ${simResult.error}`, method, simResult.error);
  }

  const successResult = simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse;
  const resourceFee = BigInt(successResult.minResourceFee ?? "0");
  return resourceFee + BigInt(BASE_FEE);
}

async function getDexSwapQuote(
  server: SorobanRpc.Server,
  dexContractId: string,
  sourceToken: string,
  targetToken: string,
  amount: bigint,
  networkPassphrase: string,
): Promise<{ outputAmount: bigint; slippage: bigint }> {
  const contract = new Contract(dexContractId);
  const operation = contract.call(
    "quote",
    nativeToScVal(sourceToken, { type: "address" }),
    nativeToScVal(targetToken, { type: "address" }),
    nativeToScVal(amount, { type: "i128" }),
  );

  const sourceAccount = {
    accountId: () => dexContractId,
    sequenceNumber: () => "0",
    incrementSequenceNumber: () => {},
  } as any;

  const tx = new TransactionBuilder(sourceAccount, {
    fee: BASE_FEE,
    networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new SimulationFailedError(`DEX quote simulation failed: ${simResult.error}`, "quote", simResult.error);
  }

  const returnVal = (simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse).result?.retval;
  if (!returnVal) throw new NoReturnValueError("DEX quote");

  const outputAmount = BigInt(scValToNative(returnVal));
  const slippage = amount > outputAmount ? amount - outputAmount : 0n;

  return { outputAmount, slippage };
}

export async function compareFundingPaths(
  invoice: Invoice,
  sourceToken: string,
  amount: bigint,
  config: FeeComparatorConfig,
): Promise<FundingPathComparison> {
  const server = new SorobanRpc.Server(config.rpcUrl, {
    allowHttp: config.rpcUrl.startsWith("http://"),
  });

  let direct: CostEstimate | "unsupported" = "unsupported";
  let swap: CostEstimate | "unsupported" = "unsupported";

  const isDirectSupported = sourceToken === invoice.token;

  if (isDirectSupported) {
    try {
      const resourceFee = await simulateResourceFee(
        server,
        config.contractId,
        "pay",
        config.networkPassphrase,
        nativeToScVal(invoice.id, { type: "u64" }),
        nativeToScVal(amount, { type: "i128" }),
      );
      direct = { resourceFee, swapSlippage: 0n, totalCost: resourceFee };
    } catch {
      direct = "unsupported";
    }
  }

  if (config.dexContractId && sourceToken !== invoice.token) {
    try {
      const swapResourceFee = await simulateResourceFee(
        server,
        config.contractId,
        "pay_with_token",
        config.networkPassphrase,
        nativeToScVal(invoice.id, { type: "u64" }),
        nativeToScVal(sourceToken, { type: "address" }),
        nativeToScVal(amount, { type: "i128" }),
      );

      const { slippage } = await getDexSwapQuote(
        server,
        config.dexContractId,
        sourceToken,
        invoice.token,
        amount,
        config.networkPassphrase,
      );

      swap = {
        resourceFee: swapResourceFee,
        swapSlippage: slippage,
        totalCost: swapResourceFee + slippage,
      };
    } catch {
      swap = "unsupported";
    }
  }

  let recommended: "direct" | "swap";
  if (direct === "unsupported" && swap === "unsupported") {
    recommended = "direct";
  } else if (direct === "unsupported") {
    recommended = "swap";
  } else if (swap === "unsupported") {
    recommended = "direct";
  } else {
    recommended = direct.totalCost <= swap.totalCost ? "direct" : "swap";
  }

  return { direct, swap, recommended };
}