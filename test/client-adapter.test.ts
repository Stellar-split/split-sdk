import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, StrKey, rpc as SorobanRpc, xdr, TransactionBuilder } from "@stellar/stellar-sdk";

const { assembleTransactionMock, isSimulationErrorMock } = vi.hoisted(() => ({
  assembleTransactionMock: vi.fn(),
  isSimulationErrorMock: vi.fn(),
}));

// `rpc.assembleTransaction` / `rpc.Api.isSimulationError` are compiled as
// non-configurable getter exports, so vi.spyOn can't patch them in place —
// mock the whole module instead.
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      assembleTransaction: assembleTransactionMock,
      Api: {
        ...actual.rpc.Api,
        isSimulationError: isSimulationErrorMock,
      },
    },
  };
});

const { StellarSplitClient } = await import("../src/client.js");
const { WalletConnectAdapter } = await import("../src/adapters/walletconnect.js");

// Mock the WalletConnect client
const mockWalletConnectClient = {
  request: vi.fn(),
};

const mockTopic = "mock-topic-123";
const mockChainId = "stellar:testnet";
const mockAddress = Keypair.random().publicKey();

describe("StellarSplitClient with WalletConnect adapter", () => {
  beforeEach(() => {
    mockWalletConnectClient.request.mockReset();
    assembleTransactionMock.mockReset();
    isSimulationErrorMock.mockReset();
  });

  it("uses WalletConnect adapter for signing when provided", async () => {
    mockWalletConnectClient.request.mockResolvedValue("signed-xdr");

    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
      adapter: new WalletConnectAdapter({
        client: mockWalletConnectClient,
        topic: mockTopic,
        chainId: mockChainId,
        address: mockAddress,
      }),
    });

    // Stub the RPC server + module-level Soroban helpers so the real
    // _submitTx path runs end-to-end and genuinely exercises the adapter.
    // @ts-expect-error - augmenting prototype for tests
    SorobanRpc.Server.prototype.getAccount = vi
      .fn()
      .mockResolvedValue({ accountId: () => mockAddress, sequenceNumber: () => "1", incrementSequenceNumber: () => {} });
    // @ts-expect-error
    SorobanRpc.Server.prototype.simulateTransaction = vi.fn().mockResolvedValue({
      result: { retval: xdr.ScVal.scvVoid() },
      minResourceFee: "0",
    });
    // @ts-expect-error
    SorobanRpc.Server.prototype.sendTransaction = vi.fn().mockResolvedValue({ status: "SUCCESS", hash: "tx-hash" });
    // @ts-expect-error
    SorobanRpc.Server.prototype.getTransaction = vi.fn().mockResolvedValue({
      status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
      returnValue: xdr.ScVal.scvVoid(),
    });

    assembleTransactionMock.mockImplementation(() => ({ build: () => ({ toXDR: () => "XDR" }) } as any));
    isSimulationErrorMock.mockImplementation(() => false as any);
    // "signed-xdr" / "XDR" above aren't real XDR — bypass real parsing.
    vi.spyOn(TransactionBuilder, "fromXDR").mockReturnValue({} as any);

    await client.pay({
      payer: mockAddress,
      invoiceId: "123",
      amount: 10_000_000n,
    });

    // Verify that WalletConnect was used instead of Freighter
    expect(mockWalletConnectClient.request).toHaveBeenCalled();
  });
});
