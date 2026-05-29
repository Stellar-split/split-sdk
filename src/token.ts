/**
 * SAC token resolver for StellarSplit.
 */

import { Contract, rpc as SorobanRpc, TransactionBuilder, BASE_FEE, scValToNative, xdr } from "@stellar/stellar-sdk";
import type { StellarSplitClientConfig } from "./client.js";

/** Token metadata information. */
export interface TokenInfo {
  /** Token contract address. */
  address: string;
  /** Token symbol (e.g., "USDC"). */
  symbol: string;
  /** Token name (e.g., "USD Coin"). */
  name: string;
  /** Number of decimal places. */
  decimals: number;
}

/** In-memory cache for token metadata. */
const tokenCache = new Map<string, TokenInfo>();

/**
 * Resolve token metadata from a SAC contract address.
 *
 * Fetches symbol, name, and decimals from the contract and caches results.
 *
 * @param address - Token contract address
 * @param config - Client configuration
 * @returns Token metadata
 */
export async function resolveToken(
  address: string,
  config: StellarSplitClientConfig
): Promise<TokenInfo> {
  // Check cache first
  if (tokenCache.has(address)) {
    return tokenCache.get(address)!;
  }

  const server = new SorobanRpc.Server(config.rpcUrl, {
    allowHttp: config.rpcUrl.startsWith("http://"),
  });
  const contract = new Contract(address);

  // Fetch symbol
  const symbolOp = contract.call("symbol");
  const symbolResult = await _simulateCall(server, config, symbolOp);
  const symbol = scValToNative(symbolResult) as string;

  // Fetch name
  const nameOp = contract.call("name");
  const nameResult = await _simulateCall(server, config, nameOp);
  const name = scValToNative(nameResult) as string;

  // Fetch decimals
  const decimalsOp = contract.call("decimals");
  const decimalsResult = await _simulateCall(server, config, decimalsOp);
  const decimals = Number(scValToNative(decimalsResult));

  const tokenInfo: TokenInfo = {
    address,
    symbol,
    name,
    decimals,
  };

  // Cache the result
  tokenCache.set(address, tokenInfo);

  return tokenInfo;
}

/** Helper to simulate a contract call and return the result. */
async function _simulateCall(
  server: SorobanRpc.Server,
  config: StellarSplitClientConfig,
  operation: xdr.Operation
): Promise<xdr.ScVal> {
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
  if (!returnVal) throw new Error("No return value from token contract");

  return returnVal;
}
