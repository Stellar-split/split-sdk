/**
 * Unit tests for OperationBuilder (#476)
 *
 * Covers:
 * - addPayment() + addInvokeHostFn() + build() produces a valid multi-op Transaction
 * - Adding > 100 operations throws EnvelopeLimitError with correct context
 * - .dryRun() returns cost and events from a mocked simulation response
 * - .submit() aborts and throws DryRunFailedError when simulation returns an error
 * - bypassDryRun: true causes .submit() to skip simulation and submit directly
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Asset,
  Keypair,
  rpc as SorobanRpc,
  StrKey,
  TransactionBuilder,
  xdr,
  Operation,
} from "@stellar/stellar-sdk";

// --------------------------------------------------------------------------
// Hoist mocks before any import of the module under test
// --------------------------------------------------------------------------

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

const { OperationBuilder } = await import("../src/builder/OperationBuilder.js");
const { EnvelopeLimitError, DryRunFailedError } = await import("../src/errors.js");

// --------------------------------------------------------------------------
// Test helpers
// --------------------------------------------------------------------------

const TEST_RPC_URL = "http://localhost:8000";
const TEST_NETWORK = "Test Network ; Test";
const sourceAddress = Keypair.random().publicKey();

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    rpcUrl: TEST_RPC_URL,
    networkPassphrase: TEST_NETWORK,
    sourceAddress,
    ...overrides,
  };
}

function makePaymentOpts() {
  return {
    destination: Keypair.random().publicKey(),
    asset: Asset.native(),
    amount: "10",
  };
}

function makeInvokeOp() {
  // Use a BumpSequence op as a stand-in for InvokeHostFunction in tests
  const op = Operation.bumpSequence({ bumpTo: "1000" });
  return { operation: op };
}

// A minimal assembled tx stub
const fakeTxStub = {
  toXDR: () => "ASSEMBLED_XDR",
  build: () => fakeTxStub,
};

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

describe("OperationBuilder (#476)", () => {
  beforeEach(() => {
    assembleTransactionMock.mockReset();
    isSimulationErrorMock.mockReset();
    vi.restoreAllMocks();
  });

  // -------------------------------------------------------------------------
  // build()
  // -------------------------------------------------------------------------

  describe("build()", () => {
    it("produces a valid multi-op Transaction that can be serialized to XDR", () => {
      const builder = new OperationBuilder(makeConfig());

      builder
        .addPayment(makePaymentOpts())
        .addInvokeHostFn(makeInvokeOp());

      const tx = builder.build();

      expect(typeof tx.toXDR).toBe("function");
      // Should not throw
      const xdrStr = tx.toXDR();
      expect(typeof xdrStr).toBe("string");
      expect(xdrStr.length).toBeGreaterThan(0);
    });

    it("throws EnvelopeLimitError with { operationCount: 101, limit: 100 } when > 100 ops are added", () => {
      const builder = new OperationBuilder(makeConfig());

      for (let i = 0; i < 101; i++) {
        builder.addBumpSequence({ bumpTo: String(i + 1) });
      }

      let error: unknown;
      try {
        builder.build();
      } catch (e) {
        error = e;
      }

      expect(error).toBeInstanceOf(EnvelopeLimitError);
      const err = error as InstanceType<typeof EnvelopeLimitError>;
      expect(err.operationCount).toBe(101);
      expect(err.limit).toBe(100);
      expect(err.code).toBe("ENVELOPE_LIMIT");
    });

    it("builds successfully with exactly 100 operations", () => {
      const builder = new OperationBuilder(makeConfig());

      for (let i = 0; i < 100; i++) {
        builder.addBumpSequence({ bumpTo: String(i + 1) });
      }

      // Should not throw
      expect(() => builder.build()).not.toThrow();
    });

    it("respects setTimebounds", () => {
      const builder = new OperationBuilder(makeConfig());
      builder.addPayment(makePaymentOpts());
      builder.setTimebounds({ minTime: 0, maxTime: 9_999_999 });

      const tx = builder.build();
      expect(typeof tx.toXDR).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // dryRun()
  // -------------------------------------------------------------------------

  describe("dryRun()", () => {
    it("returns { success: true, cost, events, simulatedXdr } from a mocked simulation", async () => {
      const fakeEvents: xdr.DiagnosticEvent[] = [];
      const simResult = {
        minResourceFee: "1234",
        events: fakeEvents,
        result: { retval: xdr.ScVal.scvVoid() },
      };

      isSimulationErrorMock.mockReturnValue(false);
      assembleTransactionMock.mockReturnValue({
        build: () => ({ toXDR: () => "ASSEMBLED_XDR" }),
      });

      // Patch Server.prototype
      const simulateTransaction = vi.fn().mockResolvedValue(simResult);
      // @ts-expect-error
      SorobanRpc.Server.prototype.simulateTransaction = simulateTransaction;

      const builder = new OperationBuilder(makeConfig());
      builder.addPayment(makePaymentOpts());

      const result = await builder.dryRun();

      expect(result.success).toBe(true);
      expect(result.cost).toBe(1234);
      expect(result.events).toBe(fakeEvents);
      expect(result.simulatedXdr).toBe("ASSEMBLED_XDR");
      expect(simulateTransaction).toHaveBeenCalledTimes(1);
    });

    it("returns { success: false } when simulation returns an error", async () => {
      const errorResult = { error: "Contract execution failed" };

      isSimulationErrorMock.mockReturnValue(true);

      const simulateTransaction = vi.fn().mockResolvedValue(errorResult);
      // @ts-expect-error
      SorobanRpc.Server.prototype.simulateTransaction = simulateTransaction;

      const builder = new OperationBuilder(makeConfig());
      builder.addPayment(makePaymentOpts());

      const result = await builder.dryRun();

      expect(result.success).toBe(false);
      expect(result.cost).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // submit()
  // -------------------------------------------------------------------------

  describe("submit()", () => {
    it("throws DryRunFailedError when simulation contains an error field", async () => {
      const errorResult = { error: "Simulation error: bad auth" };

      isSimulationErrorMock.mockReturnValue(true);

      const simulateTransaction = vi.fn().mockResolvedValue(errorResult);
      // @ts-expect-error
      SorobanRpc.Server.prototype.simulateTransaction = simulateTransaction;

      const builder = new OperationBuilder(makeConfig());
      builder.addPayment(makePaymentOpts());

      await expect(builder.submit()).rejects.toThrow(DryRunFailedError);

      try {
        await builder.submit();
      } catch (e) {
        const err = e as InstanceType<typeof DryRunFailedError>;
        expect(err.code).toBe("DRY_RUN_FAILED");
        expect(err.simulationError).toContain("Simulation error");
      }
    });

    it("bypassDryRun: true skips simulation and submits directly", async () => {
      const simulateTransaction = vi.fn();
      const sendTransaction = vi.fn().mockResolvedValue({
        status: "PENDING",
        hash: "bypass-hash-123",
      });

      // @ts-expect-error
      SorobanRpc.Server.prototype.simulateTransaction = simulateTransaction;
      // @ts-expect-error
      SorobanRpc.Server.prototype.sendTransaction = sendTransaction;

      const builder = new OperationBuilder(makeConfig());
      builder.addPayment(makePaymentOpts());

      const result = await builder.submit({ bypassDryRun: true });

      expect(simulateTransaction).not.toHaveBeenCalled();
      expect(sendTransaction).toHaveBeenCalledTimes(1);
      expect(result.txHash).toBe("bypass-hash-123");
    });

    it("calls sendTransaction when dry-run passes and returns txHash", async () => {
      const simResult = {
        minResourceFee: "500",
        events: [],
        result: { retval: xdr.ScVal.scvVoid() },
      };

      isSimulationErrorMock.mockReturnValue(false);
      assembleTransactionMock.mockReturnValue({
        build: () => ({ toXDR: () => "ASSEMBLED_XDR" }),
      });

      const simulateTransaction = vi.fn().mockResolvedValue(simResult);
      const sendTransaction = vi.fn().mockResolvedValue({
        status: "PENDING",
        hash: "good-hash-456",
      });

      // @ts-expect-error
      SorobanRpc.Server.prototype.simulateTransaction = simulateTransaction;
      // @ts-expect-error
      SorobanRpc.Server.prototype.sendTransaction = sendTransaction;

      vi.spyOn(TransactionBuilder, "fromXDR").mockReturnValue({} as any);

      const builder = new OperationBuilder(makeConfig());
      builder.addPayment(makePaymentOpts());

      const result = await builder.submit();
      expect(result.txHash).toBe("good-hash-456");
      expect(simulateTransaction).toHaveBeenCalledTimes(1);
    });
  });
});
