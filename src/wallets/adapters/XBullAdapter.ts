/**
 * XBullAdapter — Adapter for the xBull wallet extension.
 */

import type { WalletAdapter } from "../../types.js";

type Unsubscribe = () => void;

declare global {
  interface Window {
    xbull?: {
      connect(): Promise<{ public_key: string }>;
      sign(params: { xdr: string; publicKey: string }): Promise<{ xdr: string }>;
      onAccountChange(handler: (publicKey: string) => void): () => void;
    };
  }
}

export class XBullAdapter implements WalletAdapter {
  readonly name = "xBull";
  private accountChangeHandlers: Array<(address: string) => void> = [];
  private unsubscribe: (() => void) | null = null;
  private currentPublicKey: string | null = null;

  async connect(): Promise<string> {
    if (!window.xbull) {
      throw new Error("xBull wallet not installed");
    }

    const result = await window.xbull.connect();
    this.currentPublicKey = result.public_key;
    
    // Set up account change listener
    this.setupAccountChangeListener();
    
    return result.public_key;
  }

  async sign(xdr: string): Promise<string> {
    if (!window.xbull || !this.currentPublicKey) {
      throw new Error("xBull wallet not connected");
    }

    const result = await window.xbull.sign({
      xdr,
      publicKey: this.currentPublicKey,
    });
    
    return result.xdr;
  }

  async getAddress(): Promise<string> {
    if (!window.xbull) {
      throw new Error("xBull wallet not installed");
    }

    if (this.currentPublicKey) {
      return this.currentPublicKey;
    }

    const result = await window.xbull.connect();
    this.currentPublicKey = result.public_key;
    return result.public_key;
  }

  async signTransaction(xdr: string, _network: string): Promise<string> {
    return this.sign(xdr);
  }

  disconnect(): void {
    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = null;
    }
    this.accountChangeHandlers = [];
    this.currentPublicKey = null;
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
    if (!window.xbull) return;

    this.unsubscribe = window.xbull.onAccountChange((publicKey: string) => {
      this.currentPublicKey = publicKey;
      
      for (const handler of this.accountChangeHandlers) {
        try {
          handler(publicKey);
        } catch (err) {
          console.error("Error in account change handler:", err);
        }
      }
    });
  }
}
