import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  WalletConnectAdapter,
  type PersistedWalletConnectSession,
} from "../src/adapters/walletconnect.js";
import type { WalletAdapter } from "../src/adapters/types.js";

// Mock the WalletConnect client
const mockWalletConnectClient = {
  request: vi.fn(),
};

const mockTopic = "mock-topic-123";
const mockChainId = "stellar:testnet";
const mockAddress = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const mockRelayUrl = "wss://relay.walletconnect.com";

const STORAGE_KEY = "stellar_split_walletconnect_session";

describe("WalletConnectAdapter", () => {
  let adapter: WalletAdapter;

  beforeEach(() => {
    mockWalletConnectClient.request.mockClear();
    // Clear localStorage before each test
    if (typeof localStorage !== "undefined") {
      localStorage.removeItem(STORAGE_KEY);
    }
    adapter = new WalletConnectAdapter({
      client: mockWalletConnectClient,
      topic: mockTopic,
      chainId: mockChainId,
      address: mockAddress,
    });
  });

  describe("getAddress", () => {
    it("returns the configured address", async () => {
      const address = await adapter.getAddress();
      expect(address).toBe(mockAddress);
    });
  });

  describe("signTransaction", () => {
    const mockXdr = "mock-xdr-string";
    const mockNetwork = "Test Network";

    it("calls WalletConnect client with correct parameters", async () => {
      mockWalletConnectClient.request.mockResolvedValue("signed-xdr");

      const result = await adapter.signTransaction(mockXdr, mockNetwork);

      expect(mockWalletConnectClient.request).toHaveBeenCalledWith({
        topic: mockTopic,
        chainId: mockChainId,
        request: {
          method: "stellar_signXDR",
          params: { xdr: mockXdr, network: mockNetwork },
        },
      });
      expect(result).toBe("signed-xdr");
    });

    it("throws error when WalletConnect request fails", async () => {
      mockWalletConnectClient.request.mockRejectedValue(
        new Error("WalletConnect error")
      );

      await expect(
        adapter.signTransaction(mockXdr, mockNetwork)
      ).rejects.toThrow("WalletConnect error");
    });
  });

  describe("persistence", () => {
    it("persists session to localStorage when expiry is provided", () => {
      const expiry = Date.now() + 86_400_000;
      const a = new WalletConnectAdapter({
        client: mockWalletConnectClient,
        topic: mockTopic,
        chainId: mockChainId,
        address: mockAddress,
        relayUrl: mockRelayUrl,
        expiry,
      });

      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw).not.toBeNull();
      const stored: PersistedWalletConnectSession = JSON.parse(raw!);
      expect(stored.topic).toBe(mockTopic);
      expect(stored.chainId).toBe(mockChainId);
      expect(stored.address).toBe(mockAddress);
      expect(stored.relayUrl).toBe(mockRelayUrl);
      expect(stored.expiry).toBe(expiry);
      expect(a.isConnected).toBe(true);
    });

    it("restores session from localStorage on construction when not expired", () => {
      const session: PersistedWalletConnectSession = {
        topic: "restored-topic",
        relayUrl: "wss://relay.example.com",
        chainId: "stellar:mainnet",
        address: "GRESTORED...",
        expiry: Date.now() + 86_400_000,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));

      const a = new WalletConnectAdapter({
        client: mockWalletConnectClient,
      });

      expect(a.isConnected).toBe(true);
      expect(a.getAddress()).resolves.toBe("GRESTORED...");
    });

    it("discards expired session on construction", () => {
      const session: PersistedWalletConnectSession = {
        topic: "expired-topic",
        relayUrl: "wss://relay.example.com",
        chainId: "stellar:mainnet",
        address: "GEXPIRED...",
        expiry: Date.now() - 1,
      };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(session));

      const a = new WalletConnectAdapter({
        client: mockWalletConnectClient,
      });

      expect(a.isConnected).toBe(false);
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });

    it("throws when signing without a session", async () => {
      const a = new WalletConnectAdapter({
        client: mockWalletConnectClient,
      });
      await expect(a.signTransaction("xdr", "testnet")).rejects.toThrow(
        /session not available/
      );
    });
  });

  describe("disconnect", () => {
    it("clears active session and localStorage", () => {
      const expiry = Date.now() + 86_400_000;
      const a = new WalletConnectAdapter({
        client: mockWalletConnectClient,
        topic: mockTopic,
        chainId: mockChainId,
        address: mockAddress,
        expiry,
      });
      expect(a.isConnected).toBe(true);

      a.disconnect();

      expect(a.isConnected).toBe(false);
      expect(localStorage.getItem(STORAGE_KEY)).toBeNull();
    });
  });

  describe("persist", () => {
    it("allows explicit persistence after external pairing", () => {
      const a = new WalletConnectAdapter({
        client: mockWalletConnectClient,
      });
      expect(a.isConnected).toBe(false);

      const session: PersistedWalletConnectSession = {
        topic: "paired-topic",
        relayUrl: "wss://relay.paired.com",
        chainId: "stellar:testnet",
        address: "GPAIRED...",
        expiry: Date.now() + 86_400_000,
      };
      a.persist(session);

      expect(a.isConnected).toBe(true);
      const raw = localStorage.getItem(STORAGE_KEY);
      expect(raw).not.toBeNull();
      expect(JSON.parse(raw!).topic).toBe("paired-topic");
    });
  });
});
