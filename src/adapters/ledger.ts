import TransportWebHID from "@ledgerhq/hw-transport-webhid";
import type Transport from "@ledgerhq/hw-transport";
import Str from "@ledgerhq/hw-app-str";
import type { WalletAdapter } from "../types.js";
import { LedgerFirmwareTooOldError } from "../errors.js";

/** Minimum Ledger Stellar app version required for signing. */
export const MIN_LEDGER_FIRMWARE = "2.0.0";

/** Ledger hardware wallet adapter implementing WalletAdapter. */
export class LedgerAdapter implements WalletAdapter {
  private readonly path: string;
  private readonly skipFirmwareCheck: boolean;

  constructor(options?: { path?: string; skipFirmwareCheck?: boolean }) {
    this.path = options?.path ?? "44'/148'/0'";
    this.skipFirmwareCheck = options?.skipFirmwareCheck ?? false;
  }

  async getAddress(): Promise<string> {
    const transport = await this.openTransport();
    try {
      const str = new Str(transport);
      await this.checkFirmwareVersion(str);
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
      await this.checkFirmwareVersion(str);
      const txBytes = Uint8Array.from(atob(xdr), (c) => c.charCodeAt(0));
      const { signature } = await str.signTransaction(
        this.path,
        txBytes as unknown as Buffer
      );
      const sigBytes = signature as unknown as Uint8Array;
      return btoa(String.fromCharCode(...sigBytes));
    } finally {
      await transport.close();
    }
  }

  private async checkFirmwareVersion(str: Str): Promise<void> {
    if (this.skipFirmwareCheck) return;
    const { version } = await str.getAppConfiguration();
    if (this.versionCompare(version, MIN_LEDGER_FIRMWARE) < 0) {
      throw new LedgerFirmwareTooOldError(MIN_LEDGER_FIRMWARE, version);
    }
  }

  /** Semantic version comparison: returns <0 if a<b, 0 if equal, >0 if a>b. */
  private versionCompare(a: string, b: string): number {
    const pa = a.split(".").map(Number);
    const pb = b.split(".").map(Number);
    for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
      const na = pa[i] || 0;
      const nb = pb[i] || 0;
      if (na < nb) return -1;
      if (na > nb) return 1;
    }
    return 0;
  }

  private async openTransport(): Promise<Transport> {
    try {
      return await TransportWebHID.create();
    } catch {
      throw new Error(
        "Ledger device not connected. Please connect your Ledger and open the Stellar app."
      );
    }
  }
}
