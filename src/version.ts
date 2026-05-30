import {
  Account,
  Contract,
  rpc as SorobanRpc,
  TransactionBuilder,
  BASE_FEE,
  scValToNative,
} from "@stellar/stellar-sdk";
import type { StellarSplitClientConfig } from "./client.js";
import type { VersionInfo } from "./types.js";

/** The contract API version this SDK was built against. */
export const SDK_CONTRACT_VERSION = "1.0.0";

/**
 * Reads the contract's on-chain `get_version()` and compares it against
 * {@link SDK_CONTRACT_VERSION}.
 *
 * - `compatible: true`  — major versions match.
 * - `compatible: false` — major versions differ (incompatible ABI).
 * - Logs a warning when minor versions differ (compatible but potentially stale).
 */
export async function negotiateVersion(
  config: StellarSplitClientConfig
): Promise<VersionInfo> {
  const server = new SorobanRpc.Server(config.rpcUrl, {
    allowHttp: config.rpcUrl.startsWith("http://"),
  });
  const contract = new Contract(config.contractId);

  const operation = contract.call("get_version");

  const account = await server.getAccount(config.contractId).catch(() => null);
  const sourceAccount =
    account ?? new Account(config.contractId, "0");

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

  const retval = (
    simResult as SorobanRpc.Api.SimulateTransactionSuccessResponse
  ).result?.retval;
  if (!retval) throw new Error("No return value from get_version");

  const contractVersion = String(scValToNative(retval));
  const sdkVersion = SDK_CONTRACT_VERSION;

  const [contractMajor, contractMinor] = contractVersion.split(".").map(Number);
  const [sdkMajor, sdkMinor] = sdkVersion.split(".").map(Number);

  const compatible = contractMajor === sdkMajor;

  if (compatible && contractMinor !== sdkMinor) {
    console.warn(
      `[StellarSplit] Minor version mismatch: contract=${contractVersion}, sdk=${sdkVersion}. ` +
        "Some features may behave differently."
    );
  }

  return { contractVersion, sdkVersion, compatible };
}
