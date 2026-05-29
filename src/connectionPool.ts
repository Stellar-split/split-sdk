import { rpc as SorobanRpc } from "@stellar/stellar-sdk";

export class ConnectionPool {
  private readonly servers: SorobanRpc.Server[];
  private _index = 0;

  constructor(rpcUrl: string, poolSize: number, allowHttp: boolean) {
    if (poolSize < 1) throw new Error("poolSize must be at least 1");
    this.servers = Array.from(
      { length: poolSize },
      () => new SorobanRpc.Server(rpcUrl, { allowHttp })
    );
  }

  acquire(): SorobanRpc.Server {
    const server = this.servers[this._index]!;
    this._index = (this._index + 1) % this.servers.length;
    return server;
  }

  release(_server: SorobanRpc.Server): void {
    // Round-robin pool; release is a no-op kept for API symmetry
  }

  get size(): number {
    return this.servers.length;
  }
}
