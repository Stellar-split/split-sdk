import { describe, it, expect, vi, beforeEach } from "vitest";
import { rpc as SorobanRpc, xdr, Keypair, StrKey, TransactionBuilder } from "@stellar/stellar-sdk";

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

const { StellarSplitTxBuilder } = await import("../src/txBuilder.js");

const TEST_CONFIG = {
  rpcUrl: "http://localhost:8000",
  networkPassphrase: "Test",
  contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
};

describe("StellarSplitTxBuilder", () => {
  beforeEach(() => {
    assembleTransactionMock.mockReset();
    isSimulationErrorMock.mockReset();
  });

  it("chains operations and submits a single transaction", async () => {
    const sourceAddress = Keypair.random().publicKey();

    // stub server methods
    const getAccount = vi.fn().mockResolvedValue({ accountId: () => sourceAddress, sequenceNumber: () => "1", incrementSequenceNumber: () => {} });
    const simulateTransaction = vi.fn().mockResolvedValue({ result: { retval: xdr.ScVal.scvVoid() }, minResourceFee: "0" });
    const sendTransaction = vi.fn().mockResolvedValue({ status: "SUCCESS", hash: "abc123" });
    const getTransaction = vi.fn().mockResolvedValue({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS, returnValue: xdr.ScVal.scvVoid() });

    // Patch the Server prototype to use our stubs
    // @ts-expect-error - augmenting prototype for tests
    SorobanRpc.Server.prototype.getAccount = getAccount;
    // @ts-expect-error
    SorobanRpc.Server.prototype.simulateTransaction = simulateTransaction;
    // @ts-expect-error
    SorobanRpc.Server.prototype.sendTransaction = sendTransaction;
    // @ts-expect-error
    SorobanRpc.Server.prototype.getTransaction = getTransaction;

    // Ensure assembleTransaction/isSimulationError behave
    assembleTransactionMock.mockImplementation(() => ({ build: () => ({ toXDR: () => "XDR" }) } as any));
    isSimulationErrorMock.mockImplementation(() => false as any);
    // "XDR" above isn't real XDR — bypass real parsing for the signed tx round-trip.
    vi.spyOn(TransactionBuilder, "fromXDR").mockReturnValue({} as any);

    const builder = new StellarSplitTxBuilder(TEST_CONFIG, sourceAddress);
    builder.addPay("1", 100n).addRelease("1");

    const tx = builder.build();
    expect(typeof tx.toXDR).toBe("function");

    const result = await builder.submit();
    expect(result.txHash).toBe("abc123");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("chains addRolloverInvoice with other operations", async () => {
    const sourceAddress = Keypair.random().publicKey();

    const getAccount = vi.fn().mockResolvedValue({ accountId: () => sourceAddress, sequenceNumber: () => "1", incrementSequenceNumber: () => {} });
    const simulateTransaction = vi.fn().mockResolvedValue({ result: { retval: xdr.ScVal.scvVoid() }, minResourceFee: "0" });
    const sendTransaction = vi.fn().mockResolvedValue({ status: "SUCCESS", hash: "rollover123" });
    const getTransaction = vi.fn().mockResolvedValue({ status: SorobanRpc.Api.GetTransactionStatus.SUCCESS, returnValue: xdr.ScVal.scvVoid() });

    // @ts-expect-error
    SorobanRpc.Server.prototype.getAccount = getAccount;
    // @ts-expect-error
    SorobanRpc.Server.prototype.simulateTransaction = simulateTransaction;
    // @ts-expect-error
    SorobanRpc.Server.prototype.sendTransaction = sendTransaction;
    // @ts-expect-error
    SorobanRpc.Server.prototype.getTransaction = getTransaction;

    assembleTransactionMock.mockImplementation(() => ({ build: () => ({ toXDR: () => "XDR" }) } as any));
    isSimulationErrorMock.mockImplementation(() => false as any);
    vi.spyOn(TransactionBuilder, "fromXDR").mockReturnValue({} as any);

    const builder = new StellarSplitTxBuilder(TEST_CONFIG, sourceAddress);
    const futureDeadline = Math.floor(Date.now() / 1000) + 86_400;
    builder.addPay("1", 100n).addRolloverInvoice("7", futureDeadline, sourceAddress).addRelease("1");

    const tx = builder.build();
    expect(typeof tx.toXDR).toBe("function");

    const result = await builder.submit();
    expect(result.txHash).toBe("rollover123");
    expect(sendTransaction).toHaveBeenCalledTimes(1);
  });

  it("addRolloverInvoice builds correct contract call args", () => {
    const sourceAddress = Keypair.random().publicKey();
    const builder = new StellarSplitTxBuilder(TEST_CONFIG, sourceAddress);
    const futureDeadline = Math.floor(Date.now() / 1000) + 86_400;

    builder.addRolloverInvoice("42", futureDeadline, sourceAddress);
    const tx = builder.build();
    expect(typeof tx.toXDR).toBe("function");
  });
});
