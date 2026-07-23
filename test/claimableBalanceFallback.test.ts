import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  createClaimableRefund,
  getClaimableRefunds,
  isRefundTransferError,
  type ClaimableRefundEntry,
} from "../src/claimableBalanceFallback.js";

// ---------------------------------------------------------------------------
// Stellar SDK mock (hoisting-safe — no top-level vi.fn() refs in factory)
// ---------------------------------------------------------------------------

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual("@stellar/stellar-sdk");
  return {
    ...(actual as Record<string, unknown>),
    Account: vi.fn().mockImplementation((_id: string, _seq: string) => ({
      accountId: () => _id,
      sequenceNumber: () => _seq,
      incrementSequenceNumber: vi.fn(),
    })),
    TransactionBuilder: vi.fn().mockImplementation(() => ({
      addOperation: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue({ _builtTx: true }),
    })),
    BASE_FEE: "100",
    Asset: {
      native: vi.fn().mockReturnValue({
        isNative: () => true,
        getCode: () => "XLM",
      }),
    },
    Claimant: Object.assign(
      vi.fn().mockImplementation((dest: string) => ({ destination: dest })),
      { predicateUnconditional: vi.fn().mockReturnValue(null) }
    ),
    Operation: {
      createClaimableBalance: vi.fn().mockReturnValue({ type: "createClaimableBalance" }),
    },
    Horizon: {
      Server: vi.fn(),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const PAYER = "GBPAYER0000000000000000000000000000000000000000000000000000";
const SOURCE = "GBSOURCE000000000000000000000000000000000000000000000000000";
const HORIZON_URL = "https://horizon-testnet.stellar.org";
const PASSPHRASE = "Test SDF Network ; September 2015";

const BASE_CONFIG = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: PASSPHRASE,
  contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  horizonUrl: HORIZON_URL,
};

function buildMockHorizonServer({
  submitHash = "abc123txhash",
  balanceId = "00000000deadbeef",
  claimableRecords = [] as ClaimableRefundEntry[],
} = {}) {
  const mockOperationsCall = vi.fn().mockResolvedValue({
    records: [
      {
        type: "create_claimable_balance",
        balance_id: balanceId,
      },
    ],
  });
  const mockOperationsForTx = vi.fn().mockReturnValue({ call: mockOperationsCall });
  const mockOperations = vi.fn().mockReturnValue({ forTransaction: mockOperationsForTx });

  const mockClaimableCall = vi.fn().mockResolvedValue({
    records: claimableRecords.map((r) => ({
      id: r.balanceId,
      amount: r.amount,
      asset: r.asset,
      last_modified_ledger: r.lastModifiedLedger,
    })),
  });
  const mockClaimableClaimant = vi.fn().mockReturnValue({ call: mockClaimableCall });
  const mockClaimableBalances = vi.fn().mockReturnValue({ claimant: mockClaimableClaimant });

  return {
    loadAccount: vi.fn().mockResolvedValue({
      accountId: () => SOURCE,
      sequenceNumber: () => "100",
      incrementSequenceNumber: vi.fn(),
    }),
    submitTransaction: vi.fn().mockResolvedValue({ hash: submitHash }),
    operations: mockOperations,
    claimableBalances: mockClaimableBalances,
    _mockOperationsCall: mockOperationsCall,
    _mockClaimableCall: mockClaimableCall,
  };
}

/** Wire Horizon.Server to return a given mock server instance. */
async function setHorizonMock(mockServer: ReturnType<typeof buildMockHorizonServer>) {
  const { Horizon } = await import("@stellar/stellar-sdk");
  (Horizon.Server as ReturnType<typeof vi.fn>).mockImplementation(() => mockServer);
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// isRefundTransferError
// ---------------------------------------------------------------------------

describe("isRefundTransferError", () => {
  it.each([
    ["no account for destination", true],
    ["op_no_trust error returned", true],
    ["trustline not found", true],
    ["AccountMissing on ledger", true],
    ["TrustNotFound during apply", true],
    ["op_no_destination", true],
    ["insufficient balance", false],
    ["simulation timeout", false],
    ["network error", false],
  ])("(%s) → %s", (msg, expected) => {
    expect(isRefundTransferError(new Error(msg))).toBe(expected);
  });

  it("handles non-Error objects", () => {
    expect(isRefundTransferError("op_no_trust encountered")).toBe(true);
    expect(isRefundTransferError({ message: "unknown" })).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// createClaimableRefund
// ---------------------------------------------------------------------------

describe("createClaimableRefund", () => {
  it("submits a transaction and returns balanceId + txHash + fallback flag", async () => {
    const mockServer = buildMockHorizonServer({
      submitHash: "deadbeeftx",
      balanceId: "00000000deadbeef1234",
    });
    await setHorizonMock(mockServer);

    const { Asset } = await import("@stellar/stellar-sdk");
    const result = await createClaimableRefund(
      PAYER,
      10_000_000n,
      Asset.native() as never,
      SOURCE,
      BASE_CONFIG
    );

    expect(result.fallback).toBe(true);
    expect(result.txHash).toBe("deadbeeftx");
    expect(result.balanceId).toBe("00000000deadbeef1234");
    expect(mockServer.submitTransaction).toHaveBeenCalledTimes(1);
  });

  it("calls Operation.createClaimableBalance with correct amount string", async () => {
    const mockServer = buildMockHorizonServer();
    await setHorizonMock(mockServer);

    const { Asset, Operation } = await import("@stellar/stellar-sdk");
    // 12_500_000 stroops = 1.2500000 XLM
    await createClaimableRefund(
      PAYER,
      12_500_000n,
      Asset.native() as never,
      SOURCE,
      BASE_CONFIG
    );

    expect(
      (Operation as unknown as Record<string, ReturnType<typeof vi.fn>>)
        .createClaimableBalance
    ).toHaveBeenCalledWith(
      expect.objectContaining({ amount: "1.2500000" })
    );
  });

  it("falls back to synthetic balance ID when operations endpoint errors", async () => {
    const mockServer = buildMockHorizonServer({ submitHash: "txhash999" });
    mockServer._mockOperationsCall.mockRejectedValue(new Error("Horizon timeout"));
    await setHorizonMock(mockServer);

    const { Asset } = await import("@stellar/stellar-sdk");
    const result = await createClaimableRefund(
      PAYER,
      5_000_000n,
      Asset.native() as never,
      SOURCE,
      BASE_CONFIG
    );

    // Synthetic ID: prefixed zeros + txHash
    expect(result.balanceId).toContain("txhash999");
    expect(result.fallback).toBe(true);
  });

  it("throws when horizonUrl is not configured", async () => {
    const { Asset } = await import("@stellar/stellar-sdk");
    await expect(
      createClaimableRefund(PAYER, 1_000_000n, Asset.native() as never, SOURCE, {
        ...BASE_CONFIG,
        horizonUrl: undefined,
      })
    ).rejects.toThrow("horizonUrl");
  });
});

// ---------------------------------------------------------------------------
// getClaimableRefunds
// ---------------------------------------------------------------------------

describe("getClaimableRefunds", () => {
  it("returns claimable balance entries for the payer", async () => {
    const mockEntries: ClaimableRefundEntry[] = [
      {
        balanceId: "00000000aabbccdd",
        payer: PAYER,
        amount: "5.0000000",
        asset: "native",
        lastModifiedLedger: 100,
      },
      {
        balanceId: "00000000eeff1122",
        payer: PAYER,
        amount: "2.5000000",
        asset: "USDC:GA5ZSEJY",
        lastModifiedLedger: 105,
      },
    ];

    const mockServer = buildMockHorizonServer({ claimableRecords: mockEntries });
    await setHorizonMock(mockServer);

    const results = await getClaimableRefunds(PAYER, BASE_CONFIG);

    expect(results).toHaveLength(2);
    expect(results[0]!.balanceId).toBe("00000000aabbccdd");
    expect(results[0]!.amount).toBe("5.0000000");
    expect(results[1]!.asset).toBe("USDC:GA5ZSEJY");
    expect(results.every((r) => r.payer === PAYER)).toBe(true);
  });

  it("returns an empty array when no claimable balances exist", async () => {
    const mockServer = buildMockHorizonServer({ claimableRecords: [] });
    await setHorizonMock(mockServer);

    const results = await getClaimableRefunds(PAYER, BASE_CONFIG);
    expect(results).toHaveLength(0);
  });

  it("throws when horizonUrl is not configured", async () => {
    await expect(
      getClaimableRefunds(PAYER, { ...BASE_CONFIG, horizonUrl: undefined })
    ).rejects.toThrow("horizonUrl");
  });
});

// ---------------------------------------------------------------------------
// StellarSplitClient.refundInvoice integration
// ---------------------------------------------------------------------------

// Re-mock stellar-sdk for the client tests (adds rpc.Server, Contract, etc.)
vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual("@stellar/stellar-sdk");
  return {
    ...(actual as Record<string, unknown>),
    Contract: vi.fn().mockImplementation(() => ({
      call: vi.fn().mockReturnValue("mock-operation"),
    })),
    Account: vi.fn().mockImplementation((_id: string, _seq: string) => ({
      accountId: () => _id,
      sequenceNumber: () => _seq,
      incrementSequenceNumber: vi.fn(),
    })),
    TransactionBuilder: vi.fn().mockImplementation(() => ({
      addOperation: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue({ toXDR: () => "xdr" }),
    })),
    BASE_FEE: "100",
    nativeToScVal: vi.fn().mockReturnValue("mock-scval"),
    scValToNative: vi.fn().mockReturnValue({}),
    Asset: {
      native: vi.fn().mockReturnValue({ isNative: () => true, getCode: () => "XLM" }),
    },
    Claimant: Object.assign(
      vi.fn().mockImplementation((dest: string) => ({ destination: dest })),
      { predicateUnconditional: vi.fn().mockReturnValue(null) }
    ),
    Operation: {
      createClaimableBalance: vi.fn().mockReturnValue({ type: "createClaimableBalance" }),
      beginSponsoringFutureReserves: vi.fn().mockReturnValue({}),
      endSponsoringFutureReserves: vi.fn().mockReturnValue({}),
    },
    Keypair: (actual as Record<string, unknown>).Keypair,
    xdr: (actual as Record<string, unknown>).xdr,
    rpc: {
      Server: vi.fn(),
      Api: {
        isSimulationError: vi.fn().mockReturnValue(false),
        GetTransactionStatus: { NOT_FOUND: "NOT_FOUND", SUCCESS: "SUCCESS" },
        assembleTransaction: vi.fn(),
      },
      assembleTransaction: vi.fn(),
    },
    Horizon: {
      Server: vi.fn(),
    },
  };
});

describe("StellarSplitClient.refundInvoice", () => {
  const CREATOR = "GBCREATOR000000000000000000000000000000000000000000000000";
  const clientConfig = {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: PASSPHRASE,
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
    horizonUrl: HORIZON_URL,
  };

  it("returns fallback:false on a successful normal refund", async () => {
    const { rpc } = await import("@stellar/stellar-sdk");
    const { StellarSplitClient } = await import("../src/client.js");

    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      getAccount: vi.fn().mockResolvedValue({
        accountId: () => CREATOR,
        sequenceNumber: () => "1",
        incrementSequenceNumber: vi.fn(),
      }),
      simulateTransaction: vi.fn().mockResolvedValue({
        result: { retval: { toXDR: () => Buffer.alloc(0) } },
        minResourceFee: "100",
      }),
      sendTransaction: vi.fn().mockResolvedValue({ status: "PENDING", hash: "normaltxhash" }),
      getTransaction: vi.fn().mockResolvedValue({
        status: "SUCCESS",
        returnValue: { toXDR: () => Buffer.alloc(0) },
      }),
    }));

    const client = new StellarSplitClient(clientConfig);
    // Patch _submitTx to succeed directly
    (client as unknown as Record<string, unknown>)["_submitTx"] = vi
      .fn()
      .mockResolvedValue({ txHash: "normaltxhash", returnValue: {} });
    // Patch getInvoice to avoid real simulation
    (client as unknown as Record<string, unknown>)["getInvoice"] = vi
      .fn()
      .mockResolvedValue({ id: "1", funded: 10_000_000n, status: "Refunded" });

    const result = await client.refundInvoice("1", CREATOR, PAYER);
    expect(result.fallback).toBe(false);
    expect((result as { txHash: string }).txHash).toBe("normaltxhash");
  });

  it("triggers claimable-balance fallback when RPC refund throws a trustline error", async () => {
    const { rpc, Horizon } = await import("@stellar/stellar-sdk");
    const { StellarSplitClient } = await import("../src/client.js");

    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      getAccount: vi.fn().mockResolvedValue({ accountId: () => CREATOR, sequenceNumber: () => "1", incrementSequenceNumber: vi.fn() }),
      simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: {} } }),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
    }));

    const mockHorizon = buildMockHorizonServer({
      submitHash: "fallbacktxhash",
      balanceId: "00000000fallbackbalid",
    });
    (Horizon.Server as ReturnType<typeof vi.fn>).mockImplementation(() => mockHorizon);

    const client = new StellarSplitClient(clientConfig);

    // Patch _submitTx to throw a trustline error
    (client as unknown as Record<string, unknown>)["_submitTx"] = vi
      .fn()
      .mockRejectedValue(new Error("op_no_trust: trustline not found for destination"));

    // Patch getInvoice to return a known invoice
    (client as unknown as Record<string, unknown>)["getInvoice"] = vi
      .fn()
      .mockResolvedValue({ id: "1", funded: 5_000_000n, status: "Pending" });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await client.refundInvoice("1", CREATOR, PAYER);
    warnSpy.mockRestore();

    expect(result.fallback).toBe(true);
    expect((result as ClaimableRefundEntry & { txHash: string }).txHash).toBe("fallbacktxhash");
  });

  it("rethrows the error when no horizonUrl is configured and refund fails", async () => {
    const { rpc } = await import("@stellar/stellar-sdk");
    const { StellarSplitClient } = await import("../src/client.js");

    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      getAccount: vi.fn().mockResolvedValue({ accountId: () => CREATOR, sequenceNumber: () => "1", incrementSequenceNumber: vi.fn() }),
      simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: {} } }),
      sendTransaction: vi.fn(),
      getTransaction: vi.fn(),
    }));

    const client = new StellarSplitClient({
      ...clientConfig,
      horizonUrl: undefined,
    });

    (client as unknown as Record<string, unknown>)["_submitTx"] = vi
      .fn()
      .mockRejectedValue(new Error("op_no_trust: trustline not found"));

    await expect(client.refundInvoice("1", CREATOR, PAYER)).rejects.toThrow(
      "op_no_trust"
    );
  });

  it("getClaimableRefunds returns entries for a payer", async () => {
    const { rpc, Horizon } = await import("@stellar/stellar-sdk");
    const { StellarSplitClient } = await import("../src/client.js");

    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      getAccount: vi.fn().mockResolvedValue({ accountId: () => CREATOR, sequenceNumber: () => "1", incrementSequenceNumber: vi.fn() }),
      simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: {} } }),
    }));

    const mockHorizon = buildMockHorizonServer({
      claimableRecords: [
        { balanceId: "ba1", payer: PAYER, amount: "3.0000000", asset: "native", lastModifiedLedger: 50 },
      ],
    });
    (Horizon.Server as ReturnType<typeof vi.fn>).mockImplementation(() => mockHorizon);

    const client = new StellarSplitClient(clientConfig);
    const refunds = await client.getClaimableRefunds(PAYER);

    expect(refunds).toHaveLength(1);
    expect(refunds[0]!.balanceId).toBe("ba1");
    expect(refunds[0]!.amount).toBe("3.0000000");
  });
});
