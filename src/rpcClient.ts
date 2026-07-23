/**
 * RpcClient abstraction — injectable dependency for Soroban RPC transport.
 *
 * Extracting this interface allows callers to provide custom transports
 * (test mocks, alternative environments) without monkey-patching.
 */

import {
  rpc as SorobanRpc,
  Transaction,
  FeeBumpTransaction,
  Account,
} from "@stellar/stellar-sdk";

export interface RpcClient {
  simulateTransaction(
    transaction: Transaction,
    addlResources?: SorobanRpc.Server.ResourceLeeway
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse>;

  sendTransaction(
    transaction: Transaction | FeeBumpTransaction
  ): Promise<SorobanRpc.Api.SendTransactionResponse>;

  getTransaction(hash: string): Promise<SorobanRpc.Api.GetTransactionResponse>;

  getEvents(
    request: SorobanRpc.Server.GetEventsRequest
  ): Promise<SorobanRpc.Api.GetEventsResponse>;

  getLatestLedger(): Promise<SorobanRpc.Api.GetLatestLedgerResponse>;

  getAccount(address: string): Promise<Account>;

  getFeeStats(): Promise<SorobanRpc.Api.GetFeeStatsResponse>;
}

/**
 * Default implementation — wraps `SorobanRpc.Server`.
 * Created automatically when no custom `rpcClient` is supplied.
 */
export class SorobanRpcAdapter implements RpcClient {
  private readonly _server: SorobanRpc.Server;

  constructor(rpcUrl: string, options: { allowHttp?: boolean } = {}) {
    this._server = new SorobanRpc.Server(rpcUrl, options);
  }

  get server(): SorobanRpc.Server {
    return this._server;
  }

  simulateTransaction(
    transaction: Transaction,
    addlResources?: SorobanRpc.Server.ResourceLeeway
  ): Promise<SorobanRpc.Api.SimulateTransactionResponse> {
    return this._server.simulateTransaction(transaction, addlResources);
  }

  sendTransaction(
    transaction: Transaction | FeeBumpTransaction
  ): Promise<SorobanRpc.Api.SendTransactionResponse> {
    return this._server.sendTransaction(transaction);
  }

  getTransaction(hash: string): Promise<SorobanRpc.Api.GetTransactionResponse> {
    return this._server.getTransaction(hash);
  }

  getEvents(
    request: SorobanRpc.Server.GetEventsRequest
  ): Promise<SorobanRpc.Api.GetEventsResponse> {
    return this._server.getEvents(request);
  }

  getLatestLedger(): Promise<SorobanRpc.Api.GetLatestLedgerResponse> {
    return this._server.getLatestLedger();
  }

  getAccount(address: string): Promise<Account> {
    return this._server.getAccount(address);
  }

  getFeeStats(): Promise<SorobanRpc.Api.GetFeeStatsResponse> {
    return this._server.getFeeStats();
  }
}
