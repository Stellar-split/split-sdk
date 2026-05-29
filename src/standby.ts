import { rpc as SorobanRpc } from "@stellar/stellar-sdk";

export class WarmStandby {
  private readonly servers: SorobanRpc.Server[];
  private currentIndex = 0;
  private healthCheckHandle: ReturnType<typeof setInterval> | null = null;
  private recoveryHandle: ReturnType<typeof setInterval> | null = null;

  constructor(urls: string[]) {
    this.servers = urls.map(
      (url) => new SorobanRpc.Server(url, { allowHttp: url.startsWith("http://") })
    );
  }

  get server(): SorobanRpc.Server {
    return this.servers[this.currentIndex]!;
  }

  failover(): void {
    if (this.servers.length > 1) {
      this.currentIndex = (this.currentIndex + 1) % this.servers.length;
    }
  }

  start(): void {
    // Keep secondary connections warm with periodic health pings
    this.healthCheckHandle = setInterval(() => {
      const secondaryIdx = this.currentIndex === 0 ? 1 : 0;
      if (secondaryIdx < this.servers.length) {
        void this.servers[secondaryIdx]!.getHealth().catch(() => undefined);
      }
    }, 30_000);

    // Check if primary has recovered and switch back
    this.recoveryHandle = setInterval(() => {
      if (this.currentIndex === 0) return;
      void this.servers[0]!.getHealth()
        .then(() => { this.currentIndex = 0; })
        .catch(() => undefined);
    }, 60_000);
  }

  stop(): void {
    if (this.healthCheckHandle !== null) {
      clearInterval(this.healthCheckHandle);
      this.healthCheckHandle = null;
    }
    if (this.recoveryHandle !== null) {
      clearInterval(this.recoveryHandle);
      this.recoveryHandle = null;
    }
  }
}
