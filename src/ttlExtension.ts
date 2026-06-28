import {
  Account,
  Contract,
  Operation,
  TransactionBuilder,
  BASE_FEE,
  nativeToScVal,
  xdr,
  StrKey,
  rpc as SorobanRpc,
} from "@stellar/stellar-sdk";
import type { StellarSplitClientConfig } from "./client.js";
import { TtlExtensionFailedError } from "./errors.js";

export interface TtlExtensionOptions {
  source: string;
  extendTo: number;
  ledgerKeys: xdr.LedgerKey[];
}

export interface TtlExtensionResult {
  txHash: string;
  extendedKeys: number;
}

export function buildContractDataLedgerKey(
  contractId: string,
  key: xdr.ScVal,
  durability: "persistent" | "temporary" = "persistent"
): xdr.LedgerKey {
  const rawContractId = StrKey.decodeContract(contractId);
  const scAddressFn = (xdr.ScAddress as any).scAddressTypeContract || (xdr.ScAddress as any).contract;
  return xdr.LedgerKey.contractData(
    new xdr.LedgerKeyContractData({
      contract: scAddressFn(rawContractId),
      key,
      durability:
        durability === "persistent"
          ? xdr.ContractDataDurability.persistent()
          : xdr.ContractDataDurability.temporary(),
    })
  );
}

export function buildInvoiceStorageKey(invoiceId: string): xdr.ScVal {
  return nativeToScVal(BigInt(invoiceId), { type: "u64" });
}

export function buildInvoiceDataLedgerKey(
  contractId: string,
  invoiceId: string
): xdr.LedgerKey {
  return buildContractDataLedgerKey(
    contractId,
    buildInvoiceStorageKey(invoiceId),
    "persistent"
  );
}

export async function extendStorageTtl(
  config: StellarSplitClientConfig,
  options: TtlExtensionOptions
): Promise<TtlExtensionResult> {
  const rpcUrl = Array.isArray(config.rpcUrl)
    ? config.rpcUrl[0]!
    : config.rpcUrl;
  const server = new SorobanRpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith("http://"),
  });
  const contract = new Contract(config.contractId);

  const sorobanData = new xdr.SorobanTransactionData({
    resources: new xdr.SorobanResources({
      footprint: new xdr.LedgerFootprint({
        readOnly: options.ledgerKeys,
        readWrite: [],
      }),
      instructions: 0,
      readBytes: 0,
      writeBytes: 0,
    }),
    resourceFee: xdr.Int64.fromString("0"),
    ext: new (xdr.ExtensionPoint as any)(0),
  });

  const account = await server.getAccount(options.source);
  const tx = new TransactionBuilder(account, {
    fee: BASE_FEE,
    networkPassphrase: config.networkPassphrase,
    sorobanData,
  })
    .addOperation(
      ((Operation as any).extendFootprintTtl || (Operation as any).extendFootprintTTL)({
        extendTo: options.extendTo,
      })
    )
    .setTimeout(30)
    .build();

const simResult = await server.simulateTransaction(tx);
   if (SorobanRpc.Api.isSimulationError(simResult)) {
     throw new TtlExtensionFailedError(`TTL extension simulation failed: ${simResult.error}`);
   }

  const preparedTx = SorobanRpc.assembleTransaction(tx, simResult).build();

  const adapter = config.adapter;
  let signedXdr: string;
  if (adapter && typeof adapter.signTransaction === "function") {
    signedXdr = await adapter.signTransaction(
      preparedTx.toXDR(),
      config.networkPassphrase
    );
  } else {
    const { signTransaction } = await import("./wallet.js");
    signedXdr = await signTransaction(
      preparedTx.toXDR(),
      config.networkPassphrase
    );
  }

  const sendResult = await server.sendTransaction(
    TransactionBuilder.fromXDR(signedXdr, config.networkPassphrase)
  );

if (sendResult.status === "ERROR") {
     throw new TtlExtensionFailedError(
       `TTL extension transaction failed: ${JSON.stringify(sendResult.errorResult)}`
     );
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
     throw new TtlExtensionFailedError(
       `TTL extension transaction not confirmed: ${getResult.status}`
     );
   }

  return { txHash, extendedKeys: options.ledgerKeys.length };
}
