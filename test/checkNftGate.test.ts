import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";

const { StellarSplitClient } = await import("../src/client.js");
const { NftGateRequiredError } = await import("../src/errors.js");

const CREATOR = Keypair.random().publicKey();
const NFT_CONTRACT = Keypair.random().publicKey();
const CONTRACT_ID = StrKey.encodeContract(Keypair.random().rawPublicKey());

function createClient() {
  return new StellarSplitClient({
    rpcUrl: "https://example.com",
    networkPassphrase: "Test Network",
    contractId: CONTRACT_ID,
  });
}

function createInvoiceParams() {
  return {
    creator: CREATOR,
    recipients: [{ address: CREATOR, amount: 100n }],
    token: CREATOR,
    deadline: Math.floor(Date.now() / 1000) + 86_400,
  };
}

describe("StellarSplitClient — checkNftGate", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it("returns parsed result when contract returns camelCase fields", async () => {
    const client = createClient();
    const simulateSpy = vi.spyOn(client as any, "_simulateView").mockResolvedValue({
      gated: true,
      hasNft: true,
      contractAddress: NFT_CONTRACT,
    });

    const result = await client.checkNftGate(CREATOR);

    expect(result).toEqual({
      gated: true,
      hasNft: true,
      contractAddress: NFT_CONTRACT,
    });
    expect(simulateSpy).toHaveBeenCalledTimes(1);
  });

  it("handles snake_case contract response fields", async () => {
    const client = createClient();
    vi.spyOn(client as any, "_simulateView").mockResolvedValue({
      gated: true,
      has_nft: false,
      contract_address: NFT_CONTRACT,
    });

    const result = await client.checkNftGate(CREATOR);

    expect(result).toEqual({
      gated: true,
      hasNft: false,
      contractAddress: NFT_CONTRACT,
    });
  });

  it("returns ungated result when no NFT gate is configured", async () => {
    const client = createClient();
    vi.spyOn(client as any, "_simulateView").mockResolvedValue({
      gated: false,
      hasNft: false,
      contractAddress: null,
    });

    const result = await client.checkNftGate(CREATOR);

    expect(result).toEqual({
      gated: false,
      hasNft: false,
      contractAddress: null,
    });
  });

  it("returns safe defaults when simulation fails", async () => {
    const client = createClient();
    vi.spyOn(client as any, "_simulateView").mockRejectedValue(new Error("FunctionNotFound"));

    const result = await client.checkNftGate(CREATOR);

    expect(result).toEqual({
      gated: false,
      hasNft: false,
      contractAddress: null,
    });
  });

  it("returns safe defaults when contract returns an unexpected value", async () => {
    const client = createClient();
    vi.spyOn(client as any, "_simulateView").mockResolvedValue(null);

    const result = await client.checkNftGate(CREATOR);

    expect(result).toEqual({
      gated: false,
      hasNft: false,
      contractAddress: null,
    });
  });

  it("caches results for 30 seconds to avoid redundant RPC calls", async () => {
    const client = createClient();
    const simulateSpy = vi.spyOn(client as any, "_simulateView").mockResolvedValue({
      gated: false,
      hasNft: false,
      contractAddress: null,
    });

    await client.checkNftGate(CREATOR);
    await client.checkNftGate(CREATOR);

    expect(simulateSpy).toHaveBeenCalledTimes(1);
  });

  it("refetches after the 30-second cache expires", async () => {
    const client = createClient();
    const simulateSpy = vi.spyOn(client as any, "_simulateView").mockResolvedValue({
      gated: false,
      hasNft: false,
      contractAddress: null,
    });

    await client.checkNftGate(CREATOR);

    vi.advanceTimersByTime(30_001);

    await client.checkNftGate(CREATOR);

    expect(simulateSpy).toHaveBeenCalledTimes(2);
  });

  it("clearNftGateCache forces a fresh RPC call", async () => {
    const client = createClient();
    const simulateSpy = vi.spyOn(client as any, "_simulateView").mockResolvedValue({
      gated: false,
      hasNft: false,
      contractAddress: null,
    });

    await client.checkNftGate(CREATOR);
    client.clearNftGateCache();
    await client.checkNftGate(CREATOR);

    expect(simulateSpy).toHaveBeenCalledTimes(2);
  });
});

describe("StellarSplitClient — createInvoice NFT gate enforcement", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws NftGateRequiredError when creator is gated without a qualifying NFT", async () => {
    const client = createClient();
    vi.spyOn(client, "checkNftGate").mockResolvedValue({
      gated: true,
      hasNft: false,
      contractAddress: NFT_CONTRACT,
    });

    await expect(client.createInvoice(createInvoiceParams())).rejects.toThrow(
      NftGateRequiredError,
    );
  });

  it("proceeds when creator is gated and holds a qualifying NFT", async () => {
    const client = createClient();
    vi.spyOn(client, "checkNftGate").mockResolvedValue({
      gated: true,
      hasNft: true,
      contractAddress: NFT_CONTRACT,
    });
    vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "create-tx-hash",
      returnValue: xdr.ScVal.scvU64(xdr.Uint64.fromString("42")),
    });

    const result = await client.createInvoice(createInvoiceParams());

    expect(result.txHash).toBe("create-tx-hash");
  });

  it("proceeds when no NFT gate is configured", async () => {
    const client = createClient();
    vi.spyOn(client, "checkNftGate").mockResolvedValue({
      gated: false,
      hasNft: false,
      contractAddress: null,
    });
    vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "create-tx-hash",
      returnValue: xdr.ScVal.scvU64(xdr.Uint64.fromString("42")),
    });

    const result = await client.createInvoice(createInvoiceParams());

    expect(result.txHash).toBe("create-tx-hash");
  });
});
