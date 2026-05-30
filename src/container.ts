import type { rpc as SorobanRpc, Transaction } from "@stellar/stellar-sdk";
import type { Invoice } from "./types.js";

export interface IRPCClient extends SorobanRpc.Server {
  getFeeStats(): Promise<SorobanRpc.Api.GetFeeStatsResponse>;
}

export interface ICacheStore<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  invalidate(key: string): void;
  clear(): void;
}

export interface IWalletAdapter {
  getAddress(): Promise<string>;
  signTransaction(xdr: string, network: string): Promise<string>;
}

export interface DIContainerOptions {
  rpcClient?: IRPCClient;
  cacheStore?: ICacheStore<Invoice>;
  walletAdapter?: IWalletAdapter;
}

export class DIContainer {
  private rpcClient?: IRPCClient;
  private cacheStore?: ICacheStore<Invoice>;
  private walletAdapter?: IWalletAdapter;

  constructor(options: DIContainerOptions = {}) {
    this.rpcClient = options.rpcClient;
    this.cacheStore = options.cacheStore;
    this.walletAdapter = options.walletAdapter;
  }

  registerRPCClient(client: IRPCClient): void {
    this.rpcClient = client;
  }

  registerCacheStore(store: ICacheStore<Invoice>): void {
    this.cacheStore = store;
  }

  registerWalletAdapter(adapter: IWalletAdapter): void {
    this.walletAdapter = adapter;
  }

  getRPCClient(): IRPCClient | undefined {
    return this.rpcClient;
  }

  getCacheStore(): ICacheStore<Invoice> | undefined {
    return this.cacheStore;
  }

  getWalletAdapter(): IWalletAdapter | undefined {
    return this.walletAdapter;
  }
}
