/**
 * LobstrAdapter — Adapter for the LOBSTR wallet extension and deep link provider.
 */

import type { WalletAdapter } from "../../types.js";
import { WalletConnectionTimeoutError } from "../../errors.js";

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

/**
 * Options for configuring {@link LobstrAdapter}.
 */
export interface LobstrAdapterOptions {
  /**
   * Maximum time (in milliseconds) to wait for a connection response before timing out.
   * Default: 60000 (60 seconds).
   */
  connectionTimeoutMs?: number;
}

export class LobstrAdapter implements WalletAdapter {
  readonly name = "LOBSTR";
  readonly connectionTimeoutMs: number;
  private accountChangeHandlers: Array<(address: string) => void> = [];
  private accountChangedHandler: ((data: any) => void) | null = null;

  constructor(options?: LobstrAdapterOptions) {
    this.connectionTimeoutMs = options?.connectionTimeoutMs ?? 60_000;
  }

  async connect(): Promise<string> {
    if (!window.lobstr) {
      throw new Error("LOBSTR wallet not installed");
    }

    let timer: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new WalletConnectionTimeoutError(
            `LOBSTR connection timed out after ${this.connectionTimeoutMs}ms`,
            { timeoutMs: this.connectionTimeoutMs },
          ),
        );
      }, this.connectionTimeoutMs);
    });

    try {
      const connectPromise = window.lobstr.connect();
      const result = await Promise.race([connectPromise, timeoutPromise]);

      // Set up account change listener
      this.setupAccountChangeListener();

      return result.publicKey;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
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

    let timer: NodeJS.Timeout | undefined;

    const timeoutPromise = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        reject(
          new WalletConnectionTimeoutError(
            `LOBSTR connection timed out after ${this.connectionTimeoutMs}ms`,
            { timeoutMs: this.connectionTimeoutMs },
          ),
        );
      }, this.connectionTimeoutMs);
    });

    try {
      const connectPromise = window.lobstr.connect();
      const result = await Promise.race([connectPromise, timeoutPromise]);
      return result.publicKey;
    } finally {
      if (timer) {
        clearTimeout(timer);
      }
    }
  }

  async signTransaction(xdr: string, _network: string): Promise<string> {
    return this.sign(xdr);
  }

  disconnect(): void {
    if (this.accountChangedHandler && window.lobstr && typeof window.lobstr.off === "function") {
      window.lobstr.off("accountChanged", this.accountChangedHandler);
      this.accountChangedHandler = null;
    }
    this.accountChangeHandlers = [];
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

    if (this.accountChangedHandler && typeof window.lobstr.off === "function") {
      window.lobstr.off("accountChanged", this.accountChangedHandler);
    }

    this.accountChangedHandler = (data: any) => {
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

    if (typeof window.lobstr.on === "function") {
      window.lobstr.on("accountChanged", this.accountChangedHandler);
    }
  }
}

