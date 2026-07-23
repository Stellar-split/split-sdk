import { describe, it, expect, vi, beforeEach } from "vitest";
import { HorizonFallbackReader } from "../src/horizonFallback.js";
import type { NormalizedAccount, NormalizedBalance } from "../src/horizonFallback.js";

// ---------------------------------------------------------------------------
// SDK mock — Horizon.Server only; we don't need Soroban RPC here
// ---------------------------------------------------------------------------

const mockLoadAccount = vi.fn();

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual("@stellar/stellar-sdk");
  return {
    ...(actual as Record<string, unknown>),
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
      })),
    },
  };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADDR = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const HORIZON_URL = "https://horizon-testnet.stellar.org";

function makeHorizonAccountResponse(overrides?: Partial<{
  id: string;
  sequence: string;
  balances: object[];
}>) {
  const sequence = overrides?.sequence ?? "1234567890";
  return {
    id: overrides?.id ?? ADDR,
    sequence,
    sequenceNumber: () => sequence,
    incrementSequenceNumber: vi.fn(),
    balances: overrides?.balances ?? [
      { asset_type: "native", balance: "100.0000000" },
      { asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: "GA5ZSEJY…", balance: "50.0000000" },
    ],
  };
}

// ---------------------------------------------------------------------------
// HorizonFallbackReader unit tests
// ---------------------------------------------------------------------------

describe("HorizonFallbackReader", () => {
  let reader: HorizonFallbackReader;

  beforeEach(() => {
    mockLoadAccount.mockReset();
    reader = new HorizonFallbackReader(HORIZON_URL);
  });

  // -------------------------------------------------------------------------
  // getAccount
  // -------------------------------------------------------------------------

  it("getAccount returns a NormalizedAccount with id and sequence", async () => {
    mockLoadAccount.mockResolvedValue(makeHorizonAccountResponse({ sequence: "9999" }));

    const account: NormalizedAccount = await reader.getAccount(ADDR);

    expect(account.id).toBe(ADDR);
    expect(account.sequence).toBe("9999");
  });

  it("getAccount propagates Horizon errors", async () => {
    mockLoadAccount.mockRejectedValue(new Error("Account not found"));

    await expect(reader.getAccount(ADDR)).rejects.toThrow("Account not found");
  });

  // -------------------------------------------------------------------------
  // getAccountBalances
  // -------------------------------------------------------------------------

  it("getAccountBalances returns native balance as 'native'", async () => {
    mockLoadAccount.mockResolvedValue(
      makeHorizonAccountResponse({
        balances: [{ asset_type: "native", balance: "250.0000000" }],
      })
    );

    const balances: NormalizedBalance[] = await reader.getAccountBalances(ADDR);

    expect(balances).toHaveLength(1);
    expect(balances[0]!.asset).toBe("native");
    expect(balances[0]!.balance).toBe("250.0000000");
  });

  it("getAccountBalances formats issued assets as CODE:ISSUER", async () => {
    mockLoadAccount.mockResolvedValue(
      makeHorizonAccountResponse({
        balances: [
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            balance: "42.0000000",
          },
        ],
      })
    );

    const balances = await reader.getAccountBalances(ADDR);

    expect(balances).toHaveLength(1);
    expect(balances[0]!.asset).toBe(
      "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
    );
    expect(balances[0]!.balance).toBe("42.0000000");
  });

  it("getAccountBalances handles mixed native + issued balances", async () => {
    mockLoadAccount.mockResolvedValue(makeHorizonAccountResponse());

    const balances = await reader.getAccountBalances(ADDR);

    expect(balances).toHaveLength(2);
    const assets = balances.map((b) => b.asset);
    expect(assets).toContain("native");
    expect(assets.some((a) => a.includes("USDC"))).toBe(true);
  });

  it("getAccountBalances propagates Horizon errors", async () => {
    mockLoadAccount.mockRejectedValue(new Error("Network error"));

    await expect(reader.getAccountBalances(ADDR)).rejects.toThrow("Network error");
  });
});

// ---------------------------------------------------------------------------
// StellarSplitClient fallback integration tests
// ---------------------------------------------------------------------------

// Re-mock stellar-sdk for the client tests which also need rpc.Server, Contract, etc.
vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual("@stellar/stellar-sdk");
  return {
    ...(actual as Record<string, unknown>),
    Contract: vi.fn().mockImplementation(() => ({
      call: vi.fn().mockReturnValue("mock-operation"),
    })),
    Account: vi.fn().mockImplementation(() => ({})),
    TransactionBuilder: vi.fn().mockImplementation(() => ({
      addOperation: vi.fn().mockReturnThis(),
      setTimeout: vi.fn().mockReturnThis(),
      build: vi.fn().mockReturnValue({}),
    })),
    BASE_FEE: "100",
    nativeToScVal: vi.fn().mockReturnValue("mock-scval"),
    scValToNative: vi.fn().mockReturnValue({}),
    rpc: {
      Server: vi.fn(),
      Api: {
        isSimulationError: vi.fn().mockReturnValue(false),
        GetTransactionStatus: { NOT_FOUND: "NOT_FOUND", SUCCESS: "SUCCESS" },
      },
      assembleTransaction: vi.fn(),
    },
    Horizon: {
      Server: vi.fn().mockImplementation(() => ({
        loadAccount: mockLoadAccount,
      })),
    },
    xdr: (actual as Record<string, unknown>).xdr,
    Keypair: (actual as Record<string, unknown>).Keypair,
  };
});

describe("StellarSplitClient — Horizon fallback integration", () => {
  const baseConfig = {
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABSC4",
  };

  beforeEach(() => {
    mockLoadAccount.mockReset();
  });

  it("getAccount succeeds via RPC when RPC is healthy", async () => {
    const { rpc } = await import("@stellar/stellar-sdk");
    const { StellarSplitClient } = await import("../src/client.js");

    const mockRpcGetAccount = vi.fn().mockResolvedValue({
      accountId: () => ADDR,
      sequenceNumber: () => "100",
    });

    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      getAccount: mockRpcGetAccount,
      simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: {} } }),
    }));

    const client = new StellarSplitClient({
      ...baseConfig,
      horizonUrl: "https://horizon-testnet.stellar.org",
    });

    const account = await client.getAccount(ADDR);

    expect(account.id).toBe(ADDR);
    expect(account.sequence).toBe("100");
    expect(mockRpcGetAccount).toHaveBeenCalledWith(ADDR);
    // Horizon was NOT consulted since RPC succeeded
    expect(mockLoadAccount).not.toHaveBeenCalled();
  });

  it("getAccount falls back to Horizon when RPC getAccount throws", async () => {
    const { rpc } = await import("@stellar/stellar-sdk");
    const { StellarSplitClient } = await import("../src/client.js");

    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      getAccount: vi.fn().mockRejectedValue(new Error("RPC unavailable")),
      simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: {} } }),
    }));

    mockLoadAccount.mockResolvedValue(
      makeHorizonAccountResponse({ id: ADDR, sequence: "55" })
    );

    const client = new StellarSplitClient({
      ...baseConfig,
      horizonUrl: "https://horizon-testnet.stellar.org",
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const account = await client.getAccount(ADDR);
    warnSpy.mockRestore();

    expect(account.id).toBe(ADDR);
    expect(account.sequence).toBe("55");
    expect(mockLoadAccount).toHaveBeenCalledWith(ADDR);
  });

  it("getAccount throws when RPC fails and no horizonUrl is configured", async () => {
    const { rpc } = await import("@stellar/stellar-sdk");
    const { StellarSplitClient } = await import("../src/client.js");

    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      getAccount: vi.fn().mockRejectedValue(new Error("RPC down")),
      simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: {} } }),
    }));

    const client = new StellarSplitClient(baseConfig); // no horizonUrl

    await expect(client.getAccount(ADDR)).rejects.toThrow("RPC down");
  });

  it("getAccountBalances returns Horizon balances with normalised shapes", async () => {
    const { rpc } = await import("@stellar/stellar-sdk");
    const { StellarSplitClient } = await import("../src/client.js");

    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      getAccount: vi.fn(),
      simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: {} } }),
    }));

    mockLoadAccount.mockResolvedValue(
      makeHorizonAccountResponse({
        balances: [
          { asset_type: "native", balance: "10.0000000" },
          {
            asset_type: "credit_alphanum4",
            asset_code: "USDC",
            asset_issuer: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
            balance: "5.0000000",
          },
        ],
      })
    );

    const client = new StellarSplitClient({
      ...baseConfig,
      horizonUrl: "https://horizon-testnet.stellar.org",
    });

    const balances = await client.getAccountBalances(ADDR);

    expect(balances).toHaveLength(2);
    expect(balances.find((b) => b.asset === "native")?.balance).toBe("10.0000000");
    expect(
      balances.find((b) =>
        b.asset === "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"
      )?.balance
    ).toBe("5.0000000");
  });

  it("getAccountBalances throws when no horizonUrl is configured", async () => {
    const { rpc } = await import("@stellar/stellar-sdk");
    const { StellarSplitClient } = await import("../src/client.js");

    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      getAccount: vi.fn(),
      simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: {} } }),
    }));

    const client = new StellarSplitClient(baseConfig);

    await expect(client.getAccountBalances(ADDR)).rejects.toThrow(
      "horizonUrl"
    );
  });
});
