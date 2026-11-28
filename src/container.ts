import type { rpc as SorobanRpc, Transaction } from "@stellar/stellar-sdk";
import type { Invoice } from "./types.js";

export interface IRPCClient extends SorobanRpc.Server {
  getFeeStats(): Promise<SorobanRpc.Api.GetFeeStatsResponse>;
  close?(): Promise<void> | void;
}

export interface ICacheStore<T> {
  get(key: string): T | undefined;
  set(key: string, value: T): void;
  invalidate(key: string): void;
  clear(): void;
  persist?(): Promise<void> | void;
  close?(): Promise<void> | void;
}

export interface IWalletAdapter {
  getAddress(): Promise<string>;
  signTransaction(xdr: string, network: string): Promise<string>;
  /** Human-readable adapter name (e.g. "Freighter", "Ledger"). */
  name?: string;
  /** Disconnect / revoke the wallet session, if the adapter supports it. */
  disconnect?(): void | Promise<void>;
}

export interface DIContainerOptions {
  rpcClient?: IRPCClient;
  cacheStore?: ICacheStore<Invoice>;
  walletAdapter?: IWalletAdapter;
}

export type DIContainerEvent =
  | "registered"
  | "resolved"
  | "missing"
  | "disposed";

export interface DIContainerEventPayload {
  type: DIContainerEvent;
  token: string;
  value?: unknown;
}

export type DIContainerEventListener = (payload: DIContainerEventPayload) => void;

export class DIContainer {
  private rpcClient?: IRPCClient;
  private cacheStore?: ICacheStore<Invoice>;
  private walletAdapter?: IWalletAdapter;
  private readonly listeners = new Map<DIContainerEvent, Set<DIContainerEventListener>>();

  constructor(options: DIContainerOptions = {}) {
    this.rpcClient = options.rpcClient;
    this.cacheStore = options.cacheStore;
    this.walletAdapter = options.walletAdapter;
  }

  on(event: DIContainerEvent, listener: DIContainerEventListener): () => void {
    let set = this.listeners.get(event);
    if (!set) {
      set = new Set();
      this.listeners.set(event, set);
    }
    set.add(listener);
    return () => {
      set?.delete(listener);
    };
  }

  off(event: DIContainerEvent, listener: DIContainerEventListener): void {
    this.listeners.get(event)?.delete(listener);
  }

  private emit(event: DIContainerEvent, token: string, value?: unknown): void {
    const set = this.listeners.get(event);
    if (!set) {
      return;
    }
    const payload: DIContainerEventPayload = { type: event, token, value };
    for (const listener of set) {
      listener(payload);
    }
  }

  registerRPCClient(client: IRPCClient): void {
    this.rpcClient = client;
    this.emit("registered", "rpcClient", client);
  }

  registerCacheStore(store: ICacheStore<Invoice>): void {
    this.cacheStore = store;
    this.emit("registered", "cacheStore", store);
  }

  registerWalletAdapter(adapter: IWalletAdapter): void {
    this.walletAdapter = adapter;
    this.emit("registered", "walletAdapter", adapter);
  }

  getRPCClient(): IRPCClient | undefined {
    if (!this.rpcClient) {
      this.emit("missing", "rpcClient");
      return undefined;
    }
    this.emit("resolved", "rpcClient", this.rpcClient);
    return this.rpcClient;
  }

  getCacheStore(): ICacheStore<Invoice> | undefined {
    if (!this.cacheStore) {
      this.emit("missing", "cacheStore");
      return undefined;
    }
    this.emit("resolved", "cacheStore", this.cacheStore);
    return this.cacheStore;
  }

  getWalletAdapter(): IWalletAdapter | undefined {
    if (!this.walletAdapter) {
      this.emit("missing", "walletAdapter");
      return undefined;
    }
    this.emit("resolved", "walletAdapter", this.walletAdapter);
    return this.walletAdapter;
  }

  async dispose(): Promise<void> {
    const closers: Array<Promise<void> | void> = [];
    if (this.rpcClient?.close) {
      closers.push(this.rpcClient.close());
    }
    if (this.cacheStore?.close) {
      closers.push(this.cacheStore.close());
    }
    await Promise.all(closers);
    this.rpcClient = undefined;
    this.cacheStore = undefined;
    this.walletAdapter = undefined;
    this.emit("disposed", "container");
    this.listeners.clear();
  }
}
