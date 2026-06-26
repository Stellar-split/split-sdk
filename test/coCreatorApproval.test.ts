import { describe, it, expect, vi, beforeEach } from "vitest";
import { Keypair, StrKey, rpc as SorobanRpc, xdr, TransactionBuilder } from "@stellar/stellar-sdk";

const { assembleTransactionMock, isSimulationErrorMock } = vi.hoisted(() => ({
  assembleTransactionMock: vi.fn(),
  isSimulationErrorMock: vi.fn(),
}));

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
const { CoCreatorApprovalNotRequiredError } = await import("../src/errors.js");

const MOCK_SIGNER = Keypair.random().publicKey();
const CONTRACT_ID = StrKey.encodeContract(Keypair.random().rawPublicKey());

function createClient() {
  return new StellarSplitClient({
    rpcUrl: "https://example.com",
    networkPassphrase: "Test Network",
    contractId: CONTRACT_ID,
  });
}

function mockRpc() {
  SorobanRpc.Server.prototype.getAccount = vi.fn().mockResolvedValue({
    accountId: () => MOCK_SIGNER,
    sequenceNumber: () => "1",
    incrementSequenceNumber: vi.fn(),
  });
  SorobanRpc.Server.prototype.simulateTransaction = vi.fn().mockResolvedValue({
    result: { retval: xdr.ScVal.scvVoid() },
    minResourceFee: "0",
  });
  SorobanRpc.Server.prototype.sendTransaction = vi.fn().mockResolvedValue({
    status: "SUCCESS",
    hash: "tx-hash",
  });
  SorobanRpc.Server.prototype.getTransaction = vi.fn().mockResolvedValue({
    status: SorobanRpc.Api.GetTransactionStatus.SUCCESS,
    returnValue: xdr.ScVal.scvVoid(),
  });
  assembleTransactionMock.mockImplementation(() => ({
    build: () => ({ toXDR: () => "XDR" }),
  }));
  isSimulationErrorMock.mockImplementation(() => false);
  vi.spyOn(TransactionBuilder, "fromXDR").mockReturnValue({} as any);
}

describe("StellarSplitClient — co-creator approval flow", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    assembleTransactionMock.mockReset();
    isSimulationErrorMock.mockReset();
  });

  describe("submitCoCreatorApproval", () => {
    it("builds and submits an approval transaction", async () => {
      mockRpc();
      const client = createClient();

      vi.spyOn(client as any, "_needsCoCreatorApproval").mockResolvedValue(undefined);
      vi.spyOn(client as any, "_submitTx").mockResolvedValue({ txHash: "approve-tx-hash", returnValue: xdr.ScVal.scvVoid() });

      const result = await client.submitCoCreatorApproval("1", MOCK_SIGNER);

      expect(result.txHash).toBe("approve-tx-hash");
    });

    it("throws CoCreatorApprovalNotRequiredError when invoice does not require approval", async () => {
      mockRpc();
      const client = createClient();

      vi.spyOn(client as any, "_needsCoCreatorApproval").mockRejectedValue(
        new CoCreatorApprovalNotRequiredError("1")
      );

      await expect(
        client.submitCoCreatorApproval("1", MOCK_SIGNER)
      ).rejects.toThrow(CoCreatorApprovalNotRequiredError);
    });
  });

  describe("getCoCreatorApprovals", () => {
    it("returns list of addresses that have approved", async () => {
      mockRpc();
      const client = createClient();

      const approvedAddresses = [
        "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
        "GCFX3XM4DW6W46YMETX2NV7NZA3V4FS3RJV7G6J4HZ7LTQH5Y4TTWF3T",
      ];

      vi.spyOn(client as any, "_needsCoCreatorApproval").mockResolvedValue(undefined);
      vi.spyOn(client as any, "_simulateView").mockResolvedValue(approvedAddresses);

      const result = await client.getCoCreatorApprovals("1");

      expect(result).toEqual(approvedAddresses);
    });

    it("throws CoCreatorApprovalNotRequiredError when invoice does not require approval", async () => {
      mockRpc();
      const client = createClient();

      vi.spyOn(client as any, "_needsCoCreatorApproval").mockRejectedValue(
        new CoCreatorApprovalNotRequiredError("1")
      );

      await expect(
        client.getCoCreatorApprovals("1")
      ).rejects.toThrow(CoCreatorApprovalNotRequiredError);
    });
  });

  describe("revokeCoCreatorApproval", () => {
    it("builds and submits a revocation transaction", async () => {
      mockRpc();
      const client = createClient();

      vi.spyOn(client as any, "_needsCoCreatorApproval").mockResolvedValue(undefined);
      vi.spyOn(client as any, "_submitTx").mockResolvedValue({ txHash: "revoke-tx-hash", returnValue: xdr.ScVal.scvVoid() });

      const result = await client.revokeCoCreatorApproval("1", MOCK_SIGNER);

      expect(result.txHash).toBe("revoke-tx-hash");
    });

    it("throws CoCreatorApprovalNotRequiredError when invoice does not require approval", async () => {
      mockRpc();
      const client = createClient();

      vi.spyOn(client as any, "_needsCoCreatorApproval").mockRejectedValue(
        new CoCreatorApprovalNotRequiredError("1")
      );

      await expect(
        client.revokeCoCreatorApproval("1", MOCK_SIGNER)
      ).rejects.toThrow(CoCreatorApprovalNotRequiredError);
    });
  });

  describe("_needsCoCreatorApproval (via public methods)", () => {
    it("throws CoCreatorApprovalNotRequiredError when needs_co_creator_approval returns false", async () => {
      mockRpc();
      const client = createClient();

      vi.spyOn(client as any, "_simulateView").mockResolvedValue(false);

      await expect(
        client.submitCoCreatorApproval("1", MOCK_SIGNER)
      ).rejects.toThrow(CoCreatorApprovalNotRequiredError);
    });

    it("passes when needs_co_creator_approval returns true", async () => {
      mockRpc();
      const client = createClient();

      vi.spyOn(client as any, "_simulateView").mockResolvedValue(true);
      vi.spyOn(client as any, "_submitTx").mockResolvedValue({ txHash: "tx-hash", returnValue: xdr.ScVal.scvVoid() });

      const result = await client.submitCoCreatorApproval("1", MOCK_SIGNER);
      expect(result.txHash).toBe("tx-hash");
    });
  });
});
