import type { WalletAdapter } from "./types.js";

/** Options for constructing a WalletConnectAdapter. */
export interface WalletConnectAdapterOptions {
  /** WalletConnect Sign Client instance (from @walletconnect/sign-client). */
  // Typed as unknown to avoid a hard dependency on @walletconnect/sign-client.
  client: {
    request(args: {
      topic: string;
      chainId: string;
      request: { method: string; params: unknown };
    }): Promise<string>;
  };
  /** Active WalletConnect session topic. */
  topic: string;
  /** Stellar chain ID (e.g. "stellar:testnet"). */
  chainId: string;
  /** The connected wallet's Stellar public key. */
  address: string;
}

/**
 * WalletConnect adapter — routes signing through a WalletConnect session
 * instead of the Freighter browser extension.
 */
export class WalletConnectAdapter implements WalletAdapter {
  private readonly opts: WalletConnectAdapterOptions;

  constructor(opts: WalletConnectAdapterOptions) {
    this.opts = opts;
  }

  async getAddress(): Promise<string> {
    return this.opts.address;
  }

  async signTransaction(xdr: string, network: string): Promise<string> {
    return this.opts.client.request({
      topic: this.opts.topic,
      chainId: this.opts.chainId,
      request: {
        method: "stellar_signXDR",
        params: { xdr, network },
      },
    });
  }
}
