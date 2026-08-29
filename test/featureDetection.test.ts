import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  detectContractFeatures,
  clearFeatureCache,
  detectFeeBumpSupport,
} from "../src/featureDetection.js";
import type { ContractFeatures } from "../src/types.js";

// Mock @stellar/stellar-sdk — replace real rpc.Server, Account, etc. with vi.fn()
vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual("@stellar/stellar-sdk");
  return {
    ...(actual as Record<string, unknown>),
    Contract: vi.fn().mockImplementation(() => ({
      call: vi.fn().mockReturnValue("operation"),
    })),
    TransactionBuilder: vi
      .fn()
      .mockImplementation(() => ({
        addOperation: vi.fn().mockReturnThis(),
        setTimeout: vi.fn().mockReturnThis(),
        build: vi.fn().mockReturnValue({}),
      })),
    BASE_FEE: "100",
    rpc: {
      Server: vi.fn(),
      Api: {
        isSimulationError: vi.fn(),
        GetTransactionStatus: {
          NOT_FOUND: "NOT_FOUND",
          SUCCESS: "SUCCESS",
        },
      },
      assembleTransaction: vi.fn(),
    },
    Account: vi.fn(),
  };
});

describe("detectContractFeatures", () => {
  const mockConfig = {
    rpcUrl: "https://soroban-testnet.stellar.org",
    contractId: "CCUZ5N4X6V5Y5X7Y7X7Y7X7Y7X7Y7X7Y7X7Y7X7Y7X7Y7X7Y7X7Y7X",
    networkPassphrase: "Test SDF Network ; September 2015",
  };

  beforeEach(() => {
    clearFeatureCache();
  });

  afterEach(() => {
    clearFeatureCache();
  });

  it("returns false for features not present in deployed contract", async () => {
    const { rpc } = await import("@stellar/stellar-sdk");

    // Simulate all methods failing with FunctionNotFound
    (
      rpc.Api.isSimulationError as ReturnType<typeof vi.fn>
    ).mockReturnValue(true);
    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      simulateTransaction: vi
        .fn()
        .mockResolvedValue({ error: "FunctionNotFound" }),
    }));

    const features = await detectContractFeatures(mockConfig);
    expect(features.batchPay).toBe(false);
    expect(features.cloneInvoice).toBe(false);
    expect(features.invoiceGroups).toBe(false);
    expect(features.templates).toBe(false);
    expect(features.archival).toBe(false);
  });

  it("returns true for all features when contract supports them", async () => {
    const { rpc } = await import("@stellar/stellar-sdk");

    // Simulate all methods succeeding
    (
      rpc.Api.isSimulationError as ReturnType<typeof vi.fn>
    ).mockReturnValue(false);
    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      simulateTransaction: vi
        .fn()
        .mockResolvedValue({ result: { retval: "ok" } }),
    }));

    const features = await detectContractFeatures(mockConfig);
    expect(features.batchPay).toBe(true);
    expect(features.cloneInvoice).toBe(true);
    expect(features.invoiceGroups).toBe(true);
    expect(features.templates).toBe(true);
    expect(features.archival).toBe(true);
  });

  it("caches results for 5 minutes to avoid repeated probing", async () => {
    const { rpc } = await import("@stellar/stellar-sdk");

    const simulateTransaction = vi
      .fn()
      .mockResolvedValue({ result: { retval: "ok" } });

    (
      rpc.Api.isSimulationError as ReturnType<typeof vi.fn>
    ).mockReturnValue(false);
    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      simulateTransaction,
    }));

    // First call should probe
    const first = await detectContractFeatures(mockConfig);
    expect(first.batchPay).toBe(true);

    // Second call should use cache
    const second = await detectContractFeatures(mockConfig);
    expect(second.batchPay).toBe(true);

    // Each feature is 5 methods, first call probes 5 times
    expect(simulateTransaction).toHaveBeenCalledTimes(5);
  });

  it("returns typed ContractFeatures with correct shape", async () => {
    const { rpc } = await import("@stellar/stellar-sdk");

    (
      rpc.Api.isSimulationError as ReturnType<typeof vi.fn>
    ).mockReturnValue(false);
    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      simulateTransaction: vi
        .fn()
        .mockResolvedValue({ result: { retval: "ok" } }),
    }));

    const features: ContractFeatures = await detectContractFeatures(mockConfig);
    expect(typeof features.batchPay).toBe("boolean");
    expect(typeof features.cloneInvoice).toBe("boolean");
    expect(typeof features.invoiceGroups).toBe("boolean");
    expect(typeof features.templates).toBe("boolean");
    expect(typeof features.archival).toBe("boolean");
  });

  it("handles mixed availability correctly", async () => {
    const { rpc } = await import("@stellar/stellar-sdk");

    let callIndex = 0;
    const simulateTransaction = vi.fn().mockImplementation(() => {
      callIndex++;
      // First and third methods succeed, others fail
      if (callIndex % 2 === 1) {
        return { result: { retval: "ok" } };
      }
      return { error: "FunctionNotFound" };
    });

    (
      rpc.Api.isSimulationError as ReturnType<typeof vi.fn>
    ).mockImplementation((result: { error?: string }) => {
      return "error" in result;
    });
    (rpc.Server as ReturnType<typeof vi.fn>).mockImplementation(() => ({
      simulateTransaction,
    }));

    const features = await detectContractFeatures(mockConfig);
    // batchPay (1st, odd = ok) -> true
    expect(features.batchPay).toBe(true);
    // cloneInvoice (2nd, even = fail) -> false
    expect(features.cloneInvoice).toBe(false);
    // invoiceGroups (3rd, odd = ok) -> true
    expect(features.invoiceGroups).toBe(true);
    // templates (4th, even = fail) -> false
    expect(features.templates).toBe(false);
    // archival (5th, odd = ok) -> true
    expect(features.archival).toBe(true);
  });
});

describe("detectFeeBumpSupport", () => {
  it("returns true for a network whose base protocol supports fee bumps", () => {
    expect(detectFeeBumpSupport({ protocolVersion: 13 })).toBe(true);
    expect(detectFeeBumpSupport({ protocolVersion: 21 })).toBe(true);
  });

  it("returns false for a network on a protocol older than fee-bump support", () => {
    expect(detectFeeBumpSupport({ protocolVersion: 12 })).toBe(false);
    expect(detectFeeBumpSupport({ protocolVersion: 10 })).toBe(false);
  });
});