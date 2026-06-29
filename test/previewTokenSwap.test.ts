import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair } from "@stellar/stellar-sdk";
import { StellarSplitClient } from "../src/client.js";
import type { Invoice, PreviewTokenSwapResult } from "../src/types.js";

// Mock the Stellar SDK
vi.mock("@stellar/stellar-sdk", async () => {
   const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
   return {
      ...actual,
      Contract: class MockContract {
         constructor(_id: string) { }
         call(..._args: any[]) {
            return { _method: _args[0], _args: _args.slice(1) };
         }
      },
      TransactionBuilder: class MockTxBuilder {
         operations: any[] = [];
         constructor(_source: any, _opts: any) { }
         addOperation(op: any) {
            this.operations.push(op);
            return this;
         }
         setTimeout(_s: number) {
            return this;
         }
         build() {
            return { toXDR: () => "mock-xdr", operations: this.operations };
         }
      },
      scValToNative: vi.fn((val: any) => {
         if (typeof val === "object" && val.value !== undefined) {
            return BigInt(val.value);
         }
         return BigInt(val);
      }),
      nativeToScVal: vi.fn((...args: any[]) => ({
         _value: args[0],
         _type: args[1]?.type,
      })),
      xdr: {
         ScVal: {
            scvVec: vi.fn((vals: any[]) => ({ _vec: vals })),
            scvVoid: vi.fn(() => ({ _void: true })),
         },
      },
      rpc: {
         Server: class MockServer {
            async getAccount(_addr: string) {
               return {
                  accountId: () => _addr,
                  sequenceNumber: () => "0",
                  incrementSequenceNumber: () => { },
               };
            }
            async simulateTransaction(tx: any) {
               return mockSimulateFn(tx);
            }
         },
         Api: {
            isSimulationError: (result: any) => result.error !== undefined,
         },
         assembleTransaction: vi.fn((tx: any, simResult: any) => ({
            build: () => ({ toXDR: () => "assembled-xdr" }),
         })),
      },
      BASE_FEE: "100",
      Account: vi.fn(),
   };
});

let mockSimulateFn = vi.fn();

const TEST_CONFIG = {
   rpcUrl: "https://soroban-testnet.stellar.org",
   networkPassphrase: "Test SDF Network ; September 2015",
   contractId: "CA6ZKFQZ7LKP7K2WBNBSQJ2OLIYBCWQ3A2YNQZ2CRSZ2W2RGSIZRJVJ",
   dexContractId: "CDEBPEQH5V7K5JQI43C7YBLVYB2LMHF6XFMMHDZ2ZMPTWVDHXVX3L7P7",
};

const mockInvoice: Invoice = {
   id: "123",
   creator: "GCREATOR",
   recipients: [{ address: "GRECIPIENT", amount: 100_000_000n }],
   token: "CUSDC",
   deadline: 9999999999,
   funded: 0n,
   status: "Pending",
   payments: [],
};

describe("previewTokenSwap", () => {
   beforeEach(() => {
      vi.clearAllMocks();
      mockSimulateFn = vi.fn();
   });

   it("returns estimated output and price impact when DEX quote succeeds", async () => {
      const mockServer = {
         async getAccount(_addr: string) {
            return {
               accountId: () => _addr,
               sequenceNumber: () => "0",
               incrementSequenceNumber: () => { },
            };
         },
         async simulateTransaction(tx: any) {
            return mockSimulateFn(tx);
         },
      } as any;

      mockSimulateFn = vi.fn().mockResolvedValue({
         result: {
            retval: { value: "950" }, // Output amount: 950
         },
      });

      const client = new StellarSplitClient(TEST_CONFIG);
      client.server = mockServer;

      // Mock getInvoice to return the test invoice
      vi.spyOn(client, "getInvoice").mockResolvedValue(mockInvoice);

      const result = await client.previewTokenSwap("123", "CXLM", 1000n);

      expect(result.estimatedOutput).toBe(950n);
      expect(result.priceImpactBps).toBe(5); // (1000 - 950) / 1000 * 10000 = 500 bps = 5.00%
      expect(result.route).toEqual(["CXLM", "CUSDC"]);
   });

   it("calculates price impact correctly with larger numbers", async () => {
      const mockServer = {
         async getAccount(_addr: string) {
            return {
               accountId: () => _addr,
               sequenceNumber: () => "0",
               incrementSequenceNumber: () => { },
            };
         },
         async simulateTransaction(tx: any) {
            return mockSimulateFn(tx);
         },
      } as any;

      mockSimulateFn = vi.fn().mockResolvedValue({
         result: {
            retval: { value: "980000000" }, // 98% of input
         },
      });

      const client = new StellarSplitClient(TEST_CONFIG);
      client.server = mockServer;
      vi.spyOn(client, "getInvoice").mockResolvedValue(mockInvoice);

      const result = await client.previewTokenSwap("123", "CXLM", 1000000000n);

      expect(result.estimatedOutput).toBe(980000000n);
      expect(result.priceImpactBps).toBe(200); // 2% price impact = 200 basis points
      expect(result.route).toEqual(["CXLM", "CUSDC"]);
   });

   it("returns 0 price impact when input equals output", async () => {
      const mockServer = {
         async getAccount(_addr: string) {
            return {
               accountId: () => _addr,
               sequenceNumber: () => "0",
               incrementSequenceNumber: () => { },
            };
         },
         async simulateTransaction(tx: any) {
            return mockSimulateFn(tx);
         },
      } as any;

      mockSimulateFn = vi.fn().mockResolvedValue({
         result: {
            retval: { value: "1000" },
         },
      });

      const client = new StellarSplitClient(TEST_CONFIG);
      client.server = mockServer;
      vi.spyOn(client, "getInvoice").mockResolvedValue(mockInvoice);

      const result = await client.previewTokenSwap("123", "CXLM", 1000n);

      expect(result.estimatedOutput).toBe(1000n);
      expect(result.priceImpactBps).toBe(0);
   });

   it("throws error when DEX is not configured", async () => {
      const configWithoutDex = {
         ...TEST_CONFIG,
         dexContractId: undefined,
      };

      const client = new StellarSplitClient(configWithoutDex);

      await expect(client.previewTokenSwap("123", "CXLM", 1000n)).rejects.toThrow(
         "DEX contract not configured on this client"
      );
   });

   it("throws SimulationFailedError when DEX quote simulation fails", async () => {
      const mockServer = {
         async getAccount(_addr: string) {
            return {
               accountId: () => _addr,
               sequenceNumber: () => "0",
               incrementSequenceNumber: () => { },
            };
         },
         async simulateTransaction(tx: any) {
            return mockSimulateFn(tx);
         },
      } as any;

      mockSimulateFn = vi.fn().mockResolvedValue({
         error: "Contract execution failed",
      });

      const client = new StellarSplitClient(TEST_CONFIG);
      client.server = mockServer;
      vi.spyOn(client, "getInvoice").mockResolvedValue(mockInvoice);

      await expect(client.previewTokenSwap("123", "CXLM", 1000n)).rejects.toThrow(
         "DEX quote simulation failed"
      );
   });

   it("throws NoReturnValueError when simulation returns no retval", async () => {
      const mockServer = {
         async getAccount(_addr: string) {
            return {
               accountId: () => _addr,
               sequenceNumber: () => "0",
               incrementSequenceNumber: () => { },
            };
         },
         async simulateTransaction(tx: any) {
            return mockSimulateFn(tx);
         },
      } as any;

      mockSimulateFn = vi.fn().mockResolvedValue({
         result: {
            retval: undefined, // No return value
         },
      });

      const client = new StellarSplitClient(TEST_CONFIG);
      client.server = mockServer;
      vi.spyOn(client, "getInvoice").mockResolvedValue(mockInvoice);

      await expect(client.previewTokenSwap("123", "CXLM", 1000n)).rejects.toThrow(
         "previewTokenSwap"
      );
   });

   it("includes correct route in result", async () => {
      const mockServer = {
         async getAccount(_addr: string) {
            return {
               accountId: () => _addr,
               sequenceNumber: () => "0",
               incrementSequenceNumber: () => { },
            };
         },
         async simulateTransaction(tx: any) {
            return mockSimulateFn(tx);
         },
      } as any;

      mockSimulateFn = vi.fn().mockResolvedValue({
         result: {
            retval: { value: "500" },
         },
      });

      const client = new StellarSplitClient(TEST_CONFIG);
      client.server = mockServer;

      const customInvoice = { ...mockInvoice, token: "CUSDC_DIFFERENT" };
      vi.spyOn(client, "getInvoice").mockResolvedValue(customInvoice);

      const result = await client.previewTokenSwap("456", "CXLM", 1000n);

      expect(result.route).toEqual(["CXLM", "CUSDC_DIFFERENT"]);
   });

   it("handles zero source amount without error", async () => {
      const mockServer = {
         async getAccount(_addr: string) {
            return {
               accountId: () => _addr,
               sequenceNumber: () => "0",
               incrementSequenceNumber: () => { },
            };
         },
         async simulateTransaction(tx: any) {
            return mockSimulateFn(tx);
         },
      } as any;

      mockSimulateFn = vi.fn().mockResolvedValue({
         result: {
            retval: { value: "0" },
         },
      });

      const client = new StellarSplitClient(TEST_CONFIG);
      client.server = mockServer;
      vi.spyOn(client, "getInvoice").mockResolvedValue(mockInvoice);

      const result = await client.previewTokenSwap("123", "CXLM", 0n);

      expect(result.estimatedOutput).toBe(0n);
      expect(result.priceImpactBps).toBe(0); // Should not throw on division by zero
   });
});
