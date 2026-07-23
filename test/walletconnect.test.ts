import { describe, it, expect, vi, beforeEach } from "vitest";
import { WalletConnectAdapter } from "../src/adapters/walletconnect.js";
import type { WalletAdapter } from "../src/adapters/types.js";

// Mock the WalletConnect client
const mockWalletConnectClient = {
  request: vi.fn(),
};

const mockTopic = "mock-topic-123";
const mockChainId = "stellar:testnet";
const mockAddress = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";

describe("WalletConnectAdapter", () => {
  let adapter: WalletAdapter;

  beforeEach(() => {
    mockWalletConnectClient.request.mockClear();
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
      mockWalletConnectClient.request.mockRejectedValue(new Error("WalletConnect error"));
      
      await expect(adapter.signTransaction(mockXdr, mockNetwork)).rejects.toThrow("WalletConnect error");
    });
  });
});
