/**
 * FreighterAdapter — Adapter for the Freighter wallet extension.
 */

import type { WalletAdapter } from "../../types.js";

type Unsubscribe = () => void;

declare global {
  interface Window {
    freighter?: {
      isConnected(): Promise<boolean>;
      getPublicKey(): Promise<string>;
      signTransaction(xdr: string, network: string): Promise<string>;
    };
  }
}

export class FreighterAdapter implements WalletAdapter {
  readonly name = "Freighter";
  private accountChangeHandlers: Array<(address: string) => void> = [];
  private pollInterval: NodeJS.Timeout | null = null;
  private lastKnownAddress: string | null = null;

  async connect(): Promise<string> {
    if (!window.freighter) {
      throw new Error("Freighter wallet not installed");
    }

    const address = await window.freighter.getPublicKey();
    this.lastKnownAddress = address;
    
    // Start polling for account changes (Freighter doesn't have a native event)
    this.startAccountChangePolling();
    
    return address;
  }

  async sign(xdr: string, network: string): Promise<string> {
    if (!window.freighter) {
      throw new Error("Freighter wallet not installed");
    }

    return await window.freighter.signTransaction(xdr, network);
  }

  async getAddress(): Promise<string> {
    if (!window.freighter) {
      throw new Error("Freighter wallet not installed");
    }

    return await window.freighter.getPublicKey();
  }

  async signTransaction(xdr: string, network: string): Promise<string> {
    return this.sign(xdr, network);
  }

  disconnect(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }
    this.accountChangeHandlers = [];
    this.lastKnownAddress = null;
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

  private startAccountChangePolling(): void {
    if (this.pollInterval) return;

    this.pollInterval = setInterval(async () => {
      try {
        if (!window.freighter) return;
        
        const currentAddress = await window.freighter.getPublicKey();
        
        if (currentAddress !== this.lastKnownAddress) {
          this.lastKnownAddress = currentAddress;
          for (const handler of this.accountChangeHandlers) {
            try {
              handler(currentAddress);
            } catch (err) {
              console.error("Error in account change handler:", err);
            }
          }
        }
      } catch (err) {
        // Wallet might be locked or disconnected
        console.warn("Error polling Freighter account:", err);
      }
    }, 2000); // Poll every 2 seconds
  }
}
