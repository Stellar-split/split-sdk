import { rpc as SorobanRpc } from "@stellar/stellar-sdk";

export const TESTNET_RPC = "https://soroban-testnet.stellar.org";
export const TESTNET_PASSPHRASE = "Test SDF Network ; September 2015";
export const TESTNET_HORIZON = "https://horizon-testnet.stellar.org";

export function formatTxDebug(tx: any): string {
  const ledger = tx?.ledger ?? tx?.transaction?.ledger ?? tx?.latestLedger;
  const hash = tx?.hash ?? tx?.transactionHash;
  const status = tx?.status;
  return `txStatus=${status} ledger=${ledger} hash=${hash}`;
}

export async function getTxDebug(rpcUrl: string, txHash: string): Promise<any> {
  const server = new SorobanRpc.Server(rpcUrl, {
    allowHttp: rpcUrl.startsWith("http://"),
  });
  return await server.getTransaction(txHash);
}
