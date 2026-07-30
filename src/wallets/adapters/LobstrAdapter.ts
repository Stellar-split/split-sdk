/**
 * LobstrAdapter — Adapter for the LOBSTR wallet extension.
 */

import type { WalletAdapter } from "../../types.js";

type Unsubscribe = () => void;

declare global {
  interface Window {
    lobstr?: {
      connect(): Promise<{ publicKey: string }>;
      signTransaction(xdr: string): Promise<{ signedXDR: string }>;
      on(event: string, handler: (data: any) => void): void;
      off(event: string, handler: (data: any) => void): void;
    };
  }
}

export class LobstrAdapter implements WalletAdapter {
  readonly name = "LOBSTR";
  private accountChangeHandlers: Array<(address: string) => void> = [];

  async connect(): Promise<string> {
    if (!window.lobstr) {
      throw new Error("LOBSTR wallet not installed");
    }

    const result = await window.lobstr.connect();
    
    // Set up account change listener
    this.setupAccountChangeListener();
    
    return result.publicKey;
  }

  async sign(xdr: string): Promise<string> {
    if (!window.lobstr) {
      throw new Error("LOBSTR wallet not installed");
    }

    const result = await window.lobstr.signTransaction(xdr);
    return result.signedXDR;
  }

  async getAddress(): Promise<string> {
    if (!window.lobstr) {
      throw new Error("LOBSTR wallet not installed");
    }

    const result = await window.lobstr.connect();
    return result.publicKey;
  }

  async signTransaction(xdr: string, _network: string): Promise<string> {
    return this.sign(xdr);
  }

  disconnect(): void {
    this.accountChangeHandlers = [];
    // LOBSTR doesn't have explicit disconnect
  }

  onAccountChange(handler: (address: string) => void): Unsubscribe {
    this.accountChangeHandlers.push(handler);
    
    return () => {
      const index = this.accountChangeHandlers.indexOf(handler);
      if (index > -1) {
        this.accountChangeHandlers.splice(index, 1);
      }
    };
  }

  private setupAccountChangeListener(): void {
    if (!window.lobstr) return;

    const handler = (data: any) => {
      const newAddress = data?.publicKey;
      if (newAddress) {
        for (const h of this.accountChangeHandlers) {
          try {
            h(newAddress);
          } catch (err) {
            console.error("Error in account change handler:", err);
          }
        }
      }
    };

    window.lobstr.on("accountChanged", handler);
  }
}
