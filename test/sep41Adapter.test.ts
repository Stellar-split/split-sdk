import { describe, it, expect, vi, beforeEach } from "vitest";
import { Sep41Adapter } from "../src/sep41Adapter.js";

// ---------------------------------------------------------------------------
// Stellar SDK mock
// ---------------------------------------------------------------------------

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
    scValToNative: vi.fn(),
    rpc: {
      Server: vi.fn(),
      Api: {
        isSimulationError: vi.fn(),
        GetTransactionStatus: { NOT_FOUND: "NOT_FOUND", SUCCESS: "SUCCESS" },
      },
      assembleTransaction: vi.fn(),
    },
    xdr: (actual as Record<string, unknown>).xdr,
  };
});

// ---------------------------------------------------------------------------
// Shared fixture helpers
// ---------------------------------------------------------------------------

const TOKEN_ADDRESS = "CBBD47AB2EB00E041B5B13A596261F07D3FA7F19B566F3BEA881F5D414951F94";
const SOURCE = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
const PASSPHRASE = "Test SDF Network ; September 2015";
const OWNER = "GBOWNER000000000000000000000000000000000000000000000000000";
const SPENDER = "GBSPENDER0000000000000000000000000000000000000000000000000";
const RECIPIENT = "GBRECIPIENT000000000000000000000000000000000000000000000000";

/** Build a mock server whose simulateTransaction resolves based on method name. */
function buildMockServer(
  supportedMethods: Set<string>,
  balanceReturnValue: bigint = 500n
): object {
  return {
    simulateTransaction: vi.fn().mockImplementation(async () => {
      // We can't inspect the operation directly, so method filtering happens
      // through _probeMethod: probes with no args, which the mock responds to
      // by checking the method set via the Contract.call mock override per test.
      return {
        result: { retval: { _type: "i128", value: balanceReturnValue } },
      };
    }),
  };
}

// ---------------------------------------------------------------------------
// Token shape 1: Full SEP-41
// ---------------------------------------------------------------------------

describe("Sep41Adapter — full SEP-41 token", () => {
  let adapter: Sep41Adapter;

  beforeEach(async () => {
    const { rpc, Contract, scValToNative } = await import("@stellar/stellar-sdk");

    (rpc.Api.isSimulationError as ReturnType<typeof vi.fn>).mockReturnValue(false);

    (Contract as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      call: vi.fn().mockReturnValue("mock-operation"),
    }));

    (scValToNative as ReturnType<typeof vi.fn>).mockReturnValue(1000n);

    const mockServer = {
      simulateTransaction: vi.fn().mockResolvedValue({
        result: { retval: "mock-retval" },
      }),
    };

    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => mockServer);

    adapter = new Sep41Adapter(
      TOKEN_ADDRESS,
      new (rpc.Server as ReturnType<typeof vi.fn>)(),
      PASSPHRASE,
      SOURCE
    );
  });

  it("getCapabilities returns all true for a full SEP-41 contract", async () => {
    const caps = await adapter.getCapabilities();
    expect(caps.hasBalance).toBe(true);
    expect(caps.hasTransfer).toBe(true);
    expect(caps.hasTransferFrom).toBe(true);
    expect(caps.hasApprove).toBe(true);
    expect(caps.hasAllowance).toBe(true);
  });

  it("getCapabilities is cached after first call", async () => {
    const { rpc } = await import("@stellar/stellar-sdk");
    const server = (rpc.Server as ReturnType<typeof vi.fn>).mock.results[0]?.value as {
      simulateTransaction: ReturnType<typeof vi.fn>;
    };
    await adapter.getCapabilities();
    const callsBefore = server.simulateTransaction.mock.calls.length;
    await adapter.getCapabilities();
    expect(server.simulateTransaction.mock.calls.length).toBe(callsBefore);
  });

  it("balance() simulates and returns a bigint", async () => {
    const result = await adapter.balance(OWNER);
    expect(typeof result).toBe("bigint");
  });

  it("transfer() returns an xdr.Operation (synchronous)", () => {
    const op = adapter.transfer(OWNER, RECIPIENT, 100n);
    expect(op).toBeDefined();
  });

  it("transferFrom() returns an xdr.Operation (synchronous)", () => {
    const op = adapter.transferFrom(SPENDER, OWNER, RECIPIENT, 100n);
    expect(op).toBeDefined();
  });

  it("approve() returns an xdr.Operation for a full SEP-41 token", async () => {
    const op = await adapter.approve(OWNER, SPENDER, 500n, 1000);
    expect(op).not.toBeNull();
  });

  it("allowance() returns a bigint for a full SEP-41 token", async () => {
    const result = await adapter.allowance(OWNER, SPENDER);
    expect(result).not.toBeNull();
    expect(typeof result).toBe("bigint");
  });
});

// ---------------------------------------------------------------------------
// Token shape 2: Transfer-only (no allowance / approve / transfer_from)
// ---------------------------------------------------------------------------

describe("Sep41Adapter — transfer-only token", () => {
  let adapter: Sep41Adapter;

  beforeEach(async () => {
    const { rpc, Contract, scValToNative } = await import("@stellar/stellar-sdk");

    (scValToNative as ReturnType<typeof vi.fn>).mockReturnValue(250n);

    // Probe: allowance / approve / transfer_from return FunctionNotFound.
    // balance / transfer succeed.
    const probeResults: Record<string, boolean> = {
      balance: true,
      transfer: true,
      transfer_from: false,
      approve: false,
      allowance: false,
    };

    let callIndex = 0;
    (rpc.Api.isSimulationError as ReturnType<typeof vi.fn>).mockImplementation(
      (result: { error?: string }) => "error" in result && !!result.error
    );

    (Contract as ReturnType<typeof vi.fn>).mockImplementation(() => {
      return {
        call: vi.fn().mockImplementation((method: string) => {
          void method;
          return `op-${callIndex++}`;
        }),
      };
    });

    const methodCallOrder = ["balance", "transfer", "transfer_from", "approve", "allowance"];
    let probeIdx = 0;

    const mockServer = {
      simulateTransaction: vi.fn().mockImplementation(async () => {
        // First five calls are probes (one per method, in Promise.all order)
        if (probeIdx < methodCallOrder.length) {
          const method = methodCallOrder[probeIdx++]!;
          if (!probeResults[method]) {
            return { error: "FunctionNotFound: no such function" };
          }
          return { result: { retval: "ok" } };
        }
        // Subsequent calls are actual view simulations (balance, allowance, etc.)
        return { result: { retval: "mock-retval" } };
      }),
    };

    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => mockServer);

    adapter = new Sep41Adapter(
      TOKEN_ADDRESS,
      new (rpc.Server as ReturnType<typeof vi.fn>)(),
      PASSPHRASE,
      SOURCE
    );
  });

  it("getCapabilities reflects a transfer-only contract", async () => {
    const caps = await adapter.getCapabilities();
    expect(caps.hasBalance).toBe(true);
    expect(caps.hasTransfer).toBe(true);
    expect(caps.hasTransferFrom).toBe(false);
    expect(caps.hasApprove).toBe(false);
    expect(caps.hasAllowance).toBe(false);
  });

  it("approve() returns null and logs a warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const op = await adapter.approve(OWNER, SPENDER, 500n);
    expect(op).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("'approve'")
    );
    warnSpy.mockRestore();
  });

  it("allowance() returns null and logs a warning", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await adapter.allowance(OWNER, SPENDER);
    expect(result).toBeNull();
    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("'allowance'")
    );
    warnSpy.mockRestore();
  });

  it("transfer() still returns an operation for a transfer-only token", () => {
    const op = adapter.transfer(OWNER, RECIPIENT, 100n);
    expect(op).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Token shape 3: Missing-method (only balance; all else absent)
// ---------------------------------------------------------------------------

describe("Sep41Adapter — missing-method token (balance only)", () => {
  let adapter: Sep41Adapter;

  beforeEach(async () => {
    const { rpc, Contract, scValToNative } = await import("@stellar/stellar-sdk");

    (scValToNative as ReturnType<typeof vi.fn>).mockReturnValue(0n);

    const supportedMethods = new Set(["balance"]);

    (rpc.Api.isSimulationError as ReturnType<typeof vi.fn>).mockImplementation(
      (result: { error?: string }) => "error" in result && !!result.error
    );

    (Contract as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      call: vi.fn().mockReturnValue("mock-op"),
    }));

    const methodCallOrder = ["balance", "transfer", "transfer_from", "approve", "allowance"];
    let probeIdx = 0;

    const mockServer = {
      simulateTransaction: vi.fn().mockImplementation(async () => {
        if (probeIdx < methodCallOrder.length) {
          const method = methodCallOrder[probeIdx++]!;
          if (!supportedMethods.has(method)) {
            return { error: "FunctionNotFound: no such function" };
          }
          return { result: { retval: "ok" } };
        }
        return { result: { retval: "mock-retval" } };
      }),
    };

    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => mockServer);

    adapter = new Sep41Adapter(
      TOKEN_ADDRESS,
      new (rpc.Server as ReturnType<typeof vi.fn>)(),
      PASSPHRASE,
      SOURCE
    );
  });

  it("getCapabilities shows only balance as present", async () => {
    const caps = await adapter.getCapabilities();
    expect(caps.hasBalance).toBe(true);
    expect(caps.hasTransfer).toBe(false);
    expect(caps.hasTransferFrom).toBe(false);
    expect(caps.hasApprove).toBe(false);
    expect(caps.hasAllowance).toBe(false);
  });

  it("approve() returns null gracefully", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const op = await adapter.approve(OWNER, SPENDER, 100n);
    expect(op).toBeNull();
    warnSpy.mockRestore();
  });

  it("allowance() returns null gracefully", async () => {
    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await adapter.allowance(OWNER, SPENDER);
    expect(result).toBeNull();
    warnSpy.mockRestore();
  });

  it("balance() still resolves even on a minimal contract", async () => {
    const bal = await adapter.balance(OWNER);
    expect(typeof bal).toBe("bigint");
  });
});
