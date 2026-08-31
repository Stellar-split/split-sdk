import { describe, expect, it, vi } from "vitest";
import {
  estimateFee,
  estimateOperationCost,
  estimateFeeForAmount,
  type FeeEstimate,
  type FeeStats,
} from "../src/feeEstimator.js";
import { SdkError, SdkErrorCode } from "../src/errors.js";
import { rpc as SorobanRpc, BASE_FEE, Operation, Asset } from "@stellar/stellar-sdk";

describe("estimateFeeForAmount", () => {
  const sampleFeeStats: FeeStats = {
    baseFee: 100n,
    p50Fee: 150n,
    p99Fee: 300n,
  };

  it("calculates correct fee for known amount and feeStats", () => {
    const result = estimateFeeForAmount(1000n, sampleFeeStats);
    expect(result.feeLumens).toBe(100n);
    expect(result.totalWithFee).toBe(1100n);
    expect(result.feePercent).toBe(10);
  });

  it("calculates fee for large payment amounts with bigint precision", () => {
    const stats: FeeStats = {
      baseFee: 5000n,
      p50Fee: 10000n,
      p99Fee: 20000n,
    };
    const amount = 100_000n;
    const result = estimateFeeForAmount(amount, stats);
    expect(result.feeLumens).toBe(5000n);
    expect(result.totalWithFee).toBe(105_000n);
    expect(result.feePercent).toBe(5);
  });

  it("zero amount returns 0 percent and preserves feeLumens and totalWithFee", () => {
    const result = estimateFeeForAmount(0n, sampleFeeStats);
    expect(result.feeLumens).toBe(100n);
    expect(result.totalWithFee).toBe(100n);
    expect(result.feePercent).toBe(0);
  });

  it("throws SdkError with code INVALID_RECIPIENT on negative amount", () => {
    expect(() => estimateFeeForAmount(-1n, sampleFeeStats)).toThrow(SdkError);
    try {
      estimateFeeForAmount(-100n, sampleFeeStats);
      expect.unreachable("Should have thrown SdkError");
    } catch (err) {
      expect(err).toBeInstanceOf(SdkError);
      expect((err as SdkError).code).toBe(SdkErrorCode.INVALID_RECIPIENT);
      expect((err as SdkError).code).toBe("INVALID_RECIPIENT");
    }
  });
});

describe("estimateOperationCost", () => {
  it("returns fee estimate with base and resource fees", async () => {
    const mockServer = {
      simulateTransaction: vi.fn().mockResolvedValue({
        minResourceFee: "1000",
      } as SorobanRpc.Api.SimulateTransactionSuccessResponse),
    } as unknown as SorobanRpc.Server;

    const operation = Operation.payment({
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      asset: Asset.native(),
      amount: "10",
    });

    const result = await estimateOperationCost(
      operation,
      "GBVMS4VIB7ETO3X6SVVBGCPUJJG6VRM37KYWWFYP52BCX7NREZ72XCIL",
      mockServer,
      "Test SDF Network ; September 2015"
    );

    expect(result).toHaveProperty("baseFee");
    expect(result).toHaveProperty("resourceFee");
    expect(result).toHaveProperty("total");
    expect((result as FeeEstimate).resourceFee).toBe("1000");
  });

  it("handles simulation errors gracefully", async () => {
    const mockServer = {
      simulateTransaction: vi.fn().mockResolvedValue({
        error: "Simulation failed",
      } as SorobanRpc.Api.SimulationError),
    } as unknown as SorobanRpc.Server;

    const operation = Operation.payment({
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      asset: Asset.native(),
      amount: "10",
    });

    const result = await estimateOperationCost(
      operation,
      "GBVMS4VIB7ETO3X6SVVBGCPUJJG6VRM37KYWWFYP52BCX7NREZ72XCIL",
      mockServer,
      "Test SDF Network ; September 2015"
    );

    expect(result).toHaveProperty("error");
    expect(result).toHaveProperty("baseFee");
    expect(result).toHaveProperty("resourceFee");
  });

  it("handles simulation exceptions gracefully", async () => {
    const mockServer = {
      simulateTransaction: vi.fn().mockRejectedValue(new Error("Network error")),
    } as unknown as SorobanRpc.Server;

    const operation = Operation.payment({
      destination: "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      asset: Asset.native(),
      amount: "10",
    });

    const result = await estimateOperationCost(
      operation,
      "GBVMS4VIB7ETO3X6SVVBGCPUJJG6VRM37KYWWFYP52BCX7NREZ72XCIL",
      mockServer,
      "Test SDF Network ; September 2015"
    );

    expect(result).toHaveProperty("error");
    expect(result).toHaveProperty("baseFee", BASE_FEE.toString());
  });

  it("estimates fees via a registered fixed strategy", () => {
    expect(estimateFee("fixed", { fee: 123 })).toBe(123);
  });

  it("estimates fees via a percentile strategy", () => {
    expect(estimateFee("percentile", { samples: [100, 200, 300], percentile: 95 })).toBe(300);
  });

  it("estimates fees via a surge strategy", () => {
    expect(estimateFee("surge", { baseFee: 100, multiplier: 2 })).toBe(200);
  });
});
