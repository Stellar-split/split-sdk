import TransportWebHID from "@ledgerhq/hw-transport-webhid";
import Str from "@ledgerhq/hw-app-str";
import type { WalletAdapter } from "../types.js";

/** Ledger hardware wallet adapter implementing WalletAdapter. */
export class LedgerAdapter implements WalletAdapter {
  private readonly path: string;

  constructor(path = "44'/148'/0'") {
    this.path = path;
  }

  async getAddress(): Promise<string> {
    const transport = await this.openTransport();
    try {
      const str = new Str(transport);
      const { publicKey } = await str.getPublicKey(this.path);
      return publicKey;
    } finally {
      await transport.close();
    }
  }

  async signTransaction(xdr: string, _network: string): Promise<string> {
    const transport = await this.openTransport();
    try {
      const str = new Str(transport);
      const { signature } = await str.signTransaction(
        this.path,
        Buffer.from(xdr, "base64")
      );
      return Buffer.from(signature).toString("base64");
    } finally {
      await transport.close();
    }
  }

  private async openTransport(): Promise<InstanceType<typeof TransportWebHID>> {
    try {
      return await TransportWebHID.create();
    } catch {
      throw new Error(
        "Ledger device not connected. Please connect your Ledger and open the Stellar app."
      );
    }
  }
}
