import { describe, it, expect, vi, beforeEach } from "vitest";
import { rolloverInvoice } from "../src/invoiceRollover.js";

// ---------------------------------------------------------------------------
// Stellar SDK mock
// ---------------------------------------------------------------------------

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual("@stellar/stellar-sdk");

  const MockTransactionBuilder = vi.fn().mockImplementation(() => ({
    addOperation: vi.fn().mockReturnThis(),
    setTimeout: vi.fn().mockReturnThis(),
    build: vi.fn().mockReturnValue({ toXDR: () => "unsigned-xdr" }),
  }));
  (MockTransactionBuilder as unknown as Record<string, unknown>).fromXDR = vi
    .fn()
    .mockReturnValue({ _tx: true });
  (MockTransactionBuilder as unknown as Record<string, unknown>).buildFeeBumpTransaction =
    vi.fn().mockReturnValue({ toXDR: () => "bump-xdr" });

  return {
    ...(actual as Record<string, unknown>),
    Contract: vi.fn().mockImplementation(() => ({
      call: vi.fn().mockReturnValue({ _op: true }),
    })),
    Account: vi.fn().mockImplementation(() => ({})),
    TransactionBuilder: MockTransactionBuilder,
    BASE_FEE: "100",
    nativeToScVal: vi.fn().mockImplementation((val: unknown) => ({ _val: val })),
    scValToNative: vi.fn().mockReturnValue("42"),
    xdr: {
      ...(actual as Record<string, unknown>).xdr as object,
      ScVal: {
        scvVoid: vi.fn().mockReturnValue({}),
      },
    },
    rpc: {
      Server: vi.fn(),
      assembleTransaction: vi.fn().mockReturnValue({
        build: vi.fn().mockReturnValue({ toXDR: () => "prepared-xdr" }),
      }),
      Api: {
        isSimulationError: vi.fn().mockReturnValue(false),
        GetTransactionStatus: { NOT_FOUND: "NOT_FOUND", SUCCESS: "SUCCESS" },
      },
    },
  };
});

vi.mock("../src/wallet.js", () => ({
  signTransaction: vi.fn().mockResolvedValue("signed-xdr"),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const INVOICE_ID = "7";
const PASSPHRASE = "Test SDF Network ; September 2015";
const CONTRACT_ID = "CCTEST00000000000000000000000000000000000000000000000000000";
const CALLER = "GABCDE00000000000000000000000000000000000000000000000000000";
const FUTURE_DEADLINE = Math.floor(Date.now() / 1000) + 86_400; // +1 day

const BASE_CONFIG = {
  rpcUrl: "https://soroban-testnet.stellar.org",
  networkPassphrase: PASSPHRASE,
  contractId: CONTRACT_ID,
};

function makeServer(overrides: Partial<{
  sendStatus: string;
  txStatus: string;
  returnValue: unknown;
}> = {}) {
  const { sendStatus = "PENDING", txStatus = "SUCCESS", returnValue = {} } = overrides;
  return {
    getAccount: vi.fn().mockResolvedValue({ id: CALLER, sequence: "0" }),
    simulateTransaction: vi.fn().mockResolvedValue({ result: { retval: returnValue } }),
    sendTransaction: vi.fn().mockResolvedValue({ status: sendStatus, hash: "txhash123" }),
    getTransaction: vi.fn().mockResolvedValue({ status: txStatus, returnValue }),
  } as unknown as import("@stellar/stellar-sdk").rpc.Server;
}

beforeEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("rolloverInvoice", () => {
  it("throws when newDeadline is in the past", async () => {
    const pastDeadline = Math.floor(Date.now() / 1000) - 1;
    const server = makeServer();
    await expect(
      rolloverInvoice(INVOICE_ID, pastDeadline, CALLER, server, BASE_CONFIG)
    ).rejects.toThrow("newDeadline must be in the future");
  });

  it("throws when newDeadline equals current time", async () => {
    const nowSecs = Math.floor(Date.now() / 1000);
    const server = makeServer();
    await expect(
      rolloverInvoice(INVOICE_ID, nowSecs, CALLER, server, BASE_CONFIG)
    ).rejects.toThrow("newDeadline must be in the future");
  });

  it("returns newInvoiceId and txHash on success", async () => {
    const { scValToNative } = await import("@stellar/stellar-sdk");
    (scValToNative as unknown as ReturnType<typeof vi.fn>).mockReturnValue("99");

    const server = makeServer();
    const result = await rolloverInvoice(INVOICE_ID, FUTURE_DEADLINE, CALLER, server, BASE_CONFIG);

    expect(result).toEqual({ newInvoiceId: "99", txHash: "txhash123" });
  });

  it("calls rollover_invoice contract method with correct args", async () => {
    const { Contract, nativeToScVal } = await import("@stellar/stellar-sdk");
    const mockCall = vi.fn().mockReturnValue({ _op: true });
    (Contract as ReturnType<typeof vi.fn>).mockImplementation(() => ({ call: mockCall }));

    const server = makeServer();
    await rolloverInvoice(INVOICE_ID, FUTURE_DEADLINE, CALLER, server, BASE_CONFIG);

    expect(mockCall).toHaveBeenCalledWith(
      "rollover_invoice",
      expect.anything(), // invoiceId ScVal
      expect.anything(), // newDeadline ScVal
      expect.anything()  // caller ScVal
    );
    expect(mockCall.mock.calls[0]![0]).toBe("rollover_invoice");

    // Verify nativeToScVal was called with the correct types
    const calls = (nativeToScVal as unknown as ReturnType<typeof vi.fn>).mock.calls;
    const invoiceArg = calls.find((c: unknown[]) => c[0] === BigInt(INVOICE_ID));
    expect(invoiceArg).toBeDefined();
    expect(invoiceArg![1]).toEqual({ type: "u64" });

    const deadlineArg = calls.find((c: unknown[]) => c[0] === BigInt(FUTURE_DEADLINE));
    expect(deadlineArg).toBeDefined();
    expect(deadlineArg![1]).toEqual({ type: "u64" });

    const callerArg = calls.find((c: unknown[]) => c[0] === CALLER);
    expect(callerArg).toBeDefined();
    expect(callerArg![1]).toEqual({ type: "address" });
  });

  it("uses caller as the transaction source address", async () => {
    const server = makeServer();
    await rolloverInvoice(INVOICE_ID, FUTURE_DEADLINE, CALLER, server, BASE_CONFIG);

    expect(server.getAccount).toHaveBeenCalledWith(CALLER);
  });

  it("throws when the server returns a send error", async () => {
    const server = makeServer({ sendStatus: "ERROR" });
    (server.sendTransaction as ReturnType<typeof vi.fn>).mockResolvedValue({
      status: "ERROR",
      errorResult: { detail: "insufficient balance" },
    });

    await expect(
      rolloverInvoice(INVOICE_ID, FUTURE_DEADLINE, CALLER, server, BASE_CONFIG)
    ).rejects.toThrow("Transaction failed");
  });

  it("throws when the transaction is not confirmed", async () => {
    const server = makeServer({ txStatus: "FAILED" });

    await expect(
      rolloverInvoice(INVOICE_ID, FUTURE_DEADLINE, CALLER, server, BASE_CONFIG)
    ).rejects.toThrow("Transaction not confirmed");
  });

  it("throws when simulation returns an error", async () => {
    const { rpc } = await import("@stellar/stellar-sdk");
    (rpc.Api.isSimulationError as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(true);

    const server = {
      getAccount: vi.fn().mockResolvedValue({ id: CALLER, sequence: "0" }),
      simulateTransaction: vi.fn().mockResolvedValue({ error: "contract error" }),
    } as unknown as import("@stellar/stellar-sdk").rpc.Server;

    await expect(
      rolloverInvoice(INVOICE_ID, FUTURE_DEADLINE, CALLER, server, BASE_CONFIG)
    ).rejects.toThrow("Simulation failed");
  });

  it("uses the provided wallet adapter for signing instead of default", async () => {
    const mockAdapter = {
      signTransaction: vi.fn().mockResolvedValue("adapter-signed-xdr"),
    };
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");

    const server = makeServer();
    await rolloverInvoice(INVOICE_ID, FUTURE_DEADLINE, CALLER, server, BASE_CONFIG, mockAdapter);

    expect(mockAdapter.signTransaction).toHaveBeenCalledWith(
      expect.any(String),
      PASSPHRASE
    );
    expect(TransactionBuilder.fromXDR).toHaveBeenCalledWith(
      "adapter-signed-xdr",
      PASSPHRASE
    );
  });

  it("falls back to default signTransaction when no adapter is provided", async () => {
    const { signTransaction } = await import("../src/wallet.js");
    const server = makeServer();

    await rolloverInvoice(INVOICE_ID, FUTURE_DEADLINE, CALLER, server, BASE_CONFIG);

    expect(signTransaction).toHaveBeenCalled();
  });

  it("returns the new invoice ID decoded from contract return value", async () => {
    const { scValToNative } = await import("@stellar/stellar-sdk");
    (scValToNative as unknown as ReturnType<typeof vi.fn>).mockReturnValueOnce(12345);

    const server = makeServer();
    const result = await rolloverInvoice(INVOICE_ID, FUTURE_DEADLINE, CALLER, server, BASE_CONFIG);

    expect(result.newInvoiceId).toBe("12345");
  });
});
