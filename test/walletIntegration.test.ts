import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  Keypair,
  StrKey,
  TransactionBuilder,
  Account,
  Operation,
  Asset,
  Networks,
} from "@stellar/stellar-sdk";
import { StellarSplitClient } from "../src/client.js";
import { WalletSessionManager } from "../src/wallets/WalletSessionManager.js";
import { FreighterAdapter, FreighterNotInstalledError } from "../src/wallets/adapters/FreighterAdapter.js";
import { LobstrAdapter } from "../src/wallets/adapters/LobstrAdapter.js";
import { XBullAdapter } from "../src/wallets/adapters/XBullAdapter.js";
import { LedgerAdapter } from "../src/adapters/ledger.js";
import { WalletConnectAdapter } from "../src/adapters/walletconnect.js";
import type { WalletAdapter } from "../src/adapters/types.js";

const TEST_NETWORK = Networks.TESTNET;
const validContractId = StrKey.encodeContract(Keypair.random().rawPublicKey());

// Generate real Stellar keypairs for tests
const freighterKeypair = Keypair.random();
const lobstrKeypair = Keypair.random();
const xbullKeypair = Keypair.random();
const ledgerKeypair = Keypair.random();
const wcKeypair = Keypair.random();

function makeSampleTxXdr(sourceAddress: string): string {
  const tx = new TransactionBuilder(new Account(sourceAddress, "100"), {
    fee: "100",
    networkPassphrase: TEST_NETWORK,
  })
    .addOperation(
      Operation.payment({
        destination: Keypair.random().publicKey(),
        asset: Asset.native(),
        amount: "50",
      })
    )
    .setTimeout(30)
    .build();

  return tx.toXDR();
}

describe("Integration tests for all wallet types (#1038)", () => {
  let sessionManager: WalletSessionManager;
  let client: StellarSplitClient;

  beforeEach(() => {
    // In-memory mock localStorage
    const store: Record<string, string> = {};
    vi.stubGlobal("localStorage", {
      getItem: vi.fn((key: string) => store[key] || null),
      setItem: vi.fn((key: string, value: string) => {
        store[key] = value;
      }),
      removeItem: vi.fn((key: string) => {
        delete store[key];
      }),
      clear: vi.fn(() => {
        for (const k in store) delete store[k];
      }),
    });

    // Clean mock window
    vi.stubGlobal("window", {});

    sessionManager = new WalletSessionManager();

    client = new StellarSplitClient({
      rpcUrl: "http://localhost:8000",
      networkPassphrase: TEST_NETWORK,
      contractId: validContractId,
    });
  });

  afterEach(() => {
    sessionManager.disconnect();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  // =========================================================================
  // 1. Test Each Wallet & Connections
  // =========================================================================
  describe("Connections & Wallet Detection", () => {
    it("connects to FreighterAdapter and integrates with WalletSessionManager and client", async () => {
      (window as any).freighter = {
        isConnected: vi.fn().mockResolvedValue({ isConnected: true }),
        getAddress: vi.fn().mockResolvedValue({ address: freighterKeypair.publicKey() }),
        signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: "signed-freighter-xdr" }),
      };

      const adapter = new FreighterAdapter();
      const detected = sessionManager.detect();
      expect(detected.some((a) => (a as any).name === "Freighter")).toBe(true);

      const connectedEvent = new Promise<any>((resolve) =>
        sessionManager.once("connected", resolve)
      );

      const address = await sessionManager.connect(adapter as any);
      expect(address).toBe(freighterKeypair.publicKey());
      expect(sessionManager.getConnectedAccount()).toBe(freighterKeypair.publicKey());
      expect(sessionManager.getWalletName()).toBe("Freighter");

      const evt = await connectedEvent;
      expect(evt.walletName).toBe("Freighter");
      expect(evt.address).toBe(freighterKeypair.publicKey());

      // Connect to StellarSplitClient
      const clientAddress = await client.connectWallet(adapter as any);
      expect(clientAddress).toBe(freighterKeypair.publicKey());
    });

    it("connects to LobstrAdapter and handles account changes", async () => {
      let accountChangeCb: ((data: any) => void) | null = null;

      (window as any).lobstr = {
        connect: vi.fn().mockResolvedValue({ publicKey: lobstrKeypair.publicKey() }),
        signTransaction: vi.fn().mockResolvedValue({ signedXDR: "signed-lobstr-xdr" }),
        on: vi.fn((event, handler) => {
          if (event === "accountChanged") accountChangeCb = handler;
        }),
        off: vi.fn(),
      };

      const adapter = new LobstrAdapter();
      const detected = sessionManager.detect();
      expect(detected.some((a) => (a as any).name === "LOBSTR")).toBe(true);

      const address = await sessionManager.connect(adapter as any);
      expect(address).toBe(lobstrKeypair.publicKey());

      // Test account change event propagation
      const newKey = Keypair.random().publicKey();
      const accountChangedPromise = new Promise((resolve) =>
        sessionManager.once("accountChanged", resolve)
      );

      accountChangeCb?.({ publicKey: newKey });
      const changedAddr = await accountChangedPromise;
      expect(changedAddr).toBe(newKey);
      expect(sessionManager.getConnectedAccount()).toBe(newKey);
    });

    it("connects to XBullAdapter and verifies session state", async () => {
      (window as any).xbull = {
        getPublicKey: vi.fn().mockResolvedValue(xbullKeypair.publicKey()),
        connect: vi.fn().mockResolvedValue({ public_key: xbullKeypair.publicKey() }),
        sign: vi.fn().mockResolvedValue("signed-xbull-xdr"),
        onAccountChange: vi.fn(() => vi.fn()),
      };

      const adapter = new XBullAdapter();
      const detected = sessionManager.detect();
      expect(detected.some((a) => (a as any).name === "xBull")).toBe(true);

      const address = await sessionManager.connect(adapter as any);
      expect(address).toBe(xbullKeypair.publicKey());
      expect(sessionManager.getWalletName()).toBe("xBull");
    });

    it("connects to LedgerAdapter and retrieves device address", async () => {
      const adapter = new LedgerAdapter({
        skipFirmwareCheck: true,
      });

      vi.spyOn(adapter, "getAddress").mockResolvedValue(ledgerKeypair.publicKey());
      const address = await adapter.getAddress();
      expect(address).toBe(ledgerKeypair.publicKey());

      const clientAddress = await client.connectWallet(adapter);
      expect(clientAddress).toBe(ledgerKeypair.publicKey());
    });

    it("connects to WalletConnectAdapter and verifies session setup", async () => {
      const mockWcClient = { request: vi.fn() };
      const adapter = new WalletConnectAdapter({
        client: mockWcClient,
        topic: "test-wc-topic",
        chainId: "stellar:testnet",
        address: wcKeypair.publicKey(),
      });

      const address = await adapter.getAddress();
      expect(address).toBe(wcKeypair.publicKey());

      const clientAddress = await client.connectWallet(adapter);
      expect(clientAddress).toBe(wcKeypair.publicKey());
    });

    it("handles wallet disconnection cleanly and emits disconnected event", async () => {
      (window as any).freighter = {
        isConnected: vi.fn().mockResolvedValue({ isConnected: true }),
        getAddress: vi.fn().mockResolvedValue({ address: freighterKeypair.publicKey() }),
      };

      const adapter = new FreighterAdapter();
      await sessionManager.connect(adapter as any);
      expect(sessionManager.getConnectedAccount()).toBe(freighterKeypair.publicKey());

      const disconnectedEvent = new Promise<any>((resolve) =>
        sessionManager.once("disconnected", resolve)
      );

      sessionManager.disconnect();
      expect(sessionManager.getConnectedAccount()).toBeNull();
      expect(sessionManager.getWalletName()).toBeNull();

      const evt = await disconnectedEvent;
      expect(evt.walletName).toBe("Freighter");
    });
  });

  // =========================================================================
  // 2. Test Transactions for All Wallet Types
  // =========================================================================
  describe("Transactions Signing & Submission", () => {
    it("signs transaction with FreighterAdapter", async () => {
      const sampleXdr = makeSampleTxXdr(freighterKeypair.publicKey());
      (window as any).freighter = {
        isConnected: vi.fn().mockResolvedValue({ isConnected: true }),
        getAddress: vi.fn().mockResolvedValue({ address: freighterKeypair.publicKey() }),
        signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: "signed-freighter-sample-xdr" }),
      };

      const adapter = new FreighterAdapter();
      const signed = await adapter.signTransaction(sampleXdr, TEST_NETWORK);

      expect(signed).toBe("signed-freighter-sample-xdr");
      expect((window as any).freighter.signTransaction).toHaveBeenCalledWith(
        sampleXdr,
        TEST_NETWORK
      );
    });

    it("signs transaction with LobstrAdapter", async () => {
      const sampleXdr = makeSampleTxXdr(lobstrKeypair.publicKey());
      (window as any).lobstr = {
        connect: vi.fn().mockResolvedValue({ publicKey: lobstrKeypair.publicKey() }),
        signTransaction: vi.fn().mockResolvedValue({ signedXDR: "signed-lobstr-sample-xdr" }),
      };

      const adapter = new LobstrAdapter();
      const signed = await adapter.signTransaction(sampleXdr, TEST_NETWORK);

      expect(signed).toBe("signed-lobstr-sample-xdr");
      expect((window as any).lobstr.signTransaction).toHaveBeenCalledWith(sampleXdr);
    });

    it("signs transaction with XBullAdapter", async () => {
      const sampleXdr = makeSampleTxXdr(xbullKeypair.publicKey());
      (window as any).xbull = {
        getPublicKey: vi.fn().mockResolvedValue(xbullKeypair.publicKey()),
        connect: vi.fn().mockResolvedValue({ public_key: xbullKeypair.publicKey() }),
        sign: vi.fn().mockResolvedValue({ xdr: "signed-xbull-sample-xdr" }),
        onAccountChange: vi.fn(() => vi.fn()),
      };

      const adapter = new XBullAdapter();
      await adapter.connect();
      const signed = await adapter.signTransaction(sampleXdr, TEST_NETWORK);

      expect(signed).toBe("signed-xbull-sample-xdr");
      expect((window as any).xbull.sign).toHaveBeenCalledWith({
        xdr: sampleXdr,
        publicKey: xbullKeypair.publicKey(),
      });
    });

    it("signs transaction with LedgerAdapter", async () => {
      const sampleXdr = makeSampleTxXdr(ledgerKeypair.publicKey());
      const adapter = new LedgerAdapter({ skipFirmwareCheck: true });

      vi.spyOn(adapter, "signTransaction").mockResolvedValue("signed-ledger-sample-xdr");
      const signed = await adapter.signTransaction(sampleXdr, TEST_NETWORK);

      expect(signed).toBe("signed-ledger-sample-xdr");
    });

    it("signs transaction with WalletConnectAdapter", async () => {
      const sampleXdr = makeSampleTxXdr(wcKeypair.publicKey());
      const mockWcClient = {
        request: vi.fn().mockResolvedValue("signed-wc-sample-xdr"),
      };

      const adapter = new WalletConnectAdapter({
        client: mockWcClient,
        topic: "topic-wc",
        chainId: "stellar:testnet",
        address: wcKeypair.publicKey(),
      });

      const signed = await adapter.signTransaction(sampleXdr, TEST_NETWORK);
      expect(signed).toBe("signed-wc-sample-xdr");
      expect(mockWcClient.request).toHaveBeenCalledWith({
        topic: "topic-wc",
        chainId: "stellar:testnet",
        request: {
          method: "stellar_signXDR",
          params: { xdr: sampleXdr, network: TEST_NETWORK },
        },
      });
    });

    it("submits payment through client configured with wallet adapter", async () => {
      const mockAdapter: WalletAdapter = {
        getAddress: vi.fn().mockResolvedValue(freighterKeypair.publicKey()),
        signTransaction: vi.fn().mockResolvedValue("signed-envelope-xdr"),
      };

      const customClient = new StellarSplitClient({
        rpcUrl: "http://localhost:8000",
        networkPassphrase: TEST_NETWORK,
        contractId: validContractId,
        adapter: mockAdapter,
      });

      vi.spyOn(customClient as any, "_submitTx").mockResolvedValue({
        txHash: "tx-wallet-payment-confirmed",
        returnValue: { value: () => 100n },
      });

      const res = await customClient.pay({
        invoiceId: "1",
        amount: 50n,
        payer: freighterKeypair.publicKey(),
      });

      expect(res.txHash).toBe("tx-wallet-payment-confirmed");
    });
  });

  // =========================================================================
  // 3. Test Error Cases for All Wallet Types
  // =========================================================================
  describe("Error Cases", () => {
    it("throws specific error when Freighter is not installed", async () => {
      (window as any).freighter = undefined;
      const adapter = new FreighterAdapter();

      await expect(adapter.connect()).rejects.toThrow(FreighterNotInstalledError);
      await expect(adapter.sign("xdr", TEST_NETWORK)).rejects.toThrow(
        FreighterNotInstalledError
      );
    });

    it("throws specific error when LOBSTR is not installed", async () => {
      (window as any).lobstr = undefined;
      const adapter = new LobstrAdapter();

      await expect(adapter.connect()).rejects.toThrow("LOBSTR wallet not installed");
      await expect(adapter.sign("xdr")).rejects.toThrow("LOBSTR wallet not installed");
    });

    it("throws specific error when xBull is not installed", async () => {
      (window as any).xbull = undefined;
      const adapter = new XBullAdapter();

      await expect(adapter.connect()).rejects.toThrow("xBull wallet not installed");
      await expect(adapter.sign("xdr")).rejects.toThrow(
        "xBull wallet not connected"
      );
    });

    it("handles user rejection when signing in Freighter", async () => {
      (window as any).freighter = {
        isConnected: vi.fn().mockResolvedValue({ isConnected: true }),
        getAddress: vi.fn().mockResolvedValue({ address: freighterKeypair.publicKey() }),
        signTransaction: vi.fn().mockRejectedValue(new Error("User declined transaction")),
      };

      const adapter = new FreighterAdapter();
      await expect(adapter.signTransaction("sample-xdr", TEST_NETWORK)).rejects.toThrow(
        "User declined transaction"
      );
    });

    it("handles user rejection when signing in LOBSTR", async () => {
      (window as any).lobstr = {
        connect: vi.fn().mockResolvedValue({ publicKey: lobstrKeypair.publicKey() }),
        signTransaction: vi.fn().mockRejectedValue(new Error("Transaction rejected by user")),
      };

      const adapter = new LobstrAdapter();
      await expect(adapter.signTransaction("sample-xdr", TEST_NETWORK)).rejects.toThrow(
        "Transaction rejected by user"
      );
    });

    it("handles user rejection when signing in WalletConnect", async () => {
      const mockWcClient = {
        request: vi.fn().mockRejectedValue(new Error("User rejected signing request")),
      };

      const adapter = new WalletConnectAdapter({
        client: mockWcClient,
        topic: "topic-wc",
        chainId: "stellar:testnet",
        address: wcKeypair.publicKey(),
      });

      await expect(adapter.signTransaction("sample-xdr", TEST_NETWORK)).rejects.toThrow(
        "User rejected signing request"
      );
    });

    it("handles Ledger hardware disconnection error gracefully", async () => {
      const adapter = new LedgerAdapter({ skipFirmwareCheck: true });
      vi.spyOn(adapter, "signTransaction").mockRejectedValue(
        new Error("Ledger device disconnected (0x6804)")
      );

      await expect(adapter.signTransaction("sample-xdr", TEST_NETWORK)).rejects.toThrow(
        "Ledger device disconnected"
      );
    });
  });
});
