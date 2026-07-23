import {
  Contract,
  Account,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  scValToNative,
  xdr,
  rpc as SorobanRpc,
} from "@stellar/stellar-sdk";
import type { RolloverResult } from "./types.js";
import type { StellarSplitClientConfig } from "./client.js";
import { signTransaction } from "./wallet.js";
import { SimulationFailedError, TransactionFailedError, TransactionNotConfirmedError, ValidationError } from "./errors.js";

async function _submitTx(
  server: SorobanRpc.Server,
  config: StellarSplitClientConfig,
  sourceAddress: string,
  operation: xdr.Operation,
  adapter?: { signTransaction(xdr: string, network: string): Promise<string> } | null
): Promise<{ txHash: string; returnValue: xdr.ScVal }> {
  const account = await server.getAccount(sourceAddress);

  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
  })
    .addOperation(operation)
    .setTimeout(30)
    .build();

  const simResult = await server.simulateTransaction(tx);
  if (SorobanRpc.Api.isSimulationError(simResult)) {
    throw new SimulationFailedError(`Simulation failed: ${simResult.error}`, "rolloverInvoice", simResult.error);
  }

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();
  const signedXdr = await (adapter
    ? adapter.signTransaction(preparedTx.toXDR(), config.networkPassphrase)
    : signTransaction(preparedTx.toXDR(), config.networkPassphrase));

  const sendResult = await server.sendTransaction(
    TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase)
  );

  if (sendResult.status === "ERROR") {
    throw new TransactionFailedError(`Transaction failed: ${JSON.stringify(sendResult.errorResult)}`);
  }

  const txHash = sendResult.hash;
  let getResult = await server.getTransaction(txHash);
  let attempts = 0;
  while (
    getResult.status === SorobanRpc.Api.GetTransactionStatus.NOT_FOUND &&
    attempts < 20
  ) {
    await new Promise((r) => setTimeout(r, 1500));
    getResult = await server.getTransaction(txHash);
    attempts++;
  }

  if (getResult.status !== SorobanRpc.Api.GetTransactionStatus.SUCCESS) {
    throw new TransactionNotConfirmedError(String(getResult.status));
  }

  const returnValue =
    (getResult as SorobanRpc.Api.GetSuccessfulTransactionResponse).returnValue ??
    xdr.ScVal.scvVoid();

  return { txHash, returnValue };
}

/**
 * Roll an expired invoice over into a new invoice with a fresh deadline,
 * preserving all original settings automatically via the contract.
 *
 * @param invoiceId   - ID of the expired invoice to roll over.
 * @param newDeadline - Unix timestamp (seconds) for the new invoice's deadline.
 *                      Must be in the future (> Date.now() / 1000).
 * @param caller      - Stellar address of the account initiating the rollover.
 * @param server      - Soroban RPC server instance.
 * @param config      - SDK client configuration.
 * @param adapter     - Optional wallet adapter for signing.
 * @returns The new invoice ID and the rollover transaction hash.
 * @throws If newDeadline is not in the future.
 */
export async function rolloverInvoice(
  invoiceId: string,
  newDeadline: number,
  caller: string,
  server: SorobanRpc.Server,
  config: StellarSplitClientConfig,
  adapter?: { signTransaction(xdr: string, network: string): Promise<string> } | null
): Promise<RolloverResult> {
  if (newDeadline <= Date.now() / 1000) {
    throw new ValidationError("newDeadline must be in the future");
  }

  const contract = new Contract(config.contractId);
  const operation = contract.call(
    "rollover_invoice",
    nativeToScVal(BigInt(invoiceId), { type: "u64" }),
    nativeToScVal(BigInt(newDeadline), { type: "u64" }),
    nativeToScVal(caller, { type: "address" })
  );

  const result = await _submitTx(server, config, caller, operation, adapter);
  const newInvoiceId = scValToNative(result.returnValue).toString();

  return { newInvoiceId, txHash: result.txHash };
}
