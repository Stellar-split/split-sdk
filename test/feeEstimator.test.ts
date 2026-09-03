import { describe, expect, it, vi } from "vitest";
import { estimateFee, estimateOperationCost, estimateFeeForAmount, type FeeEstimate } from "../src/feeEstimator.js";
import { rpc as SorobanRpc, BASE_FEE, Operation, Asset } from "@stellar/stellar-sdk";

describe("estimateFeeForAmount", () => {
  it("returns the base fee when feeBps is zero", () => {
    expect(estimateFeeForAmount(0n, { baseFee: BigInt(BASE_FEE) })).toBe(BigInt(BASE_FEE));
    expect(estimateFeeForAmount(123_456_789n, { baseFee: BigInt(BASE_FEE) })).toBe(BigInt(BASE_FEE));
  });

  it("computes an exact fee for a whole-number bps using bigint", () => {
    // 100 bps = 1% on 10_000_000 stroops (10 XLM) = 100_000 stroops.
    const fee = estimateFeeForAmount(10_000_000n, { feeBps: 100, baseFee: 0n });
    expect(fee).toBe(100_000n);
  });

  it("rounds up fractional bps to avoid undercharging", () => {
    // 1 bps of 9 stroops = 0.0009 stroop -> rounds up to 1 stroop.
    expect(estimateFeeForAmount(1_000n, { feeBps: 1, baseFee: 0n })).toBe(1n); // 0.1 stroop -> 1
    // Exact multiples stay exact: 10_000 stroops * 1bps = 1 stroop.
    expect(estimateFeeForAmount(10_000n, { feeBps: 1, baseFee: 0n })).toBe(1n);
  });

  it("truncates instead of rounding up when roundUp is false", () => {
    // 1 bps of 1000 stroops = 0.1 stroop -> truncated to 0.
    expect(estimateFeeForAmount(1000n, { feeBps: 1, baseFee: 0n, roundUp: false })).toBe(0n);
  });

  it("adds the flat base fee on top of the proportional fee", () => {
    const fee = estimateFeeForAmount(2000n, { feeBps: 50, baseFee: 1000n });
    // proportional = 2000 * 50 / 10000 = 10; total = 1000 + 10 = 1010.
    expect(fee).toBe(1010n);
  });

  it("handles large amounts without precision loss", () => {
    const huge = 123456789123456789n;
    const fee = estimateFeeForAmount(huge, { feeBps: 250, baseFee: BigInt(BASE_FEE) });
    // proportional = floor(huge * 250 / 10000) = 3086419728086419, remainder 7250 → round-up +1
    expect(fee).toBe(BigInt(BASE_FEE) + (huge * 250n) / 10000n + 1n);
  });

  it("throws on negative amount", () => {
    expect(() => estimateFeeForAmount(-1n)).toThrow(RangeError);
  });

  it("throws on negative feeBps", () => {
    expect(() => estimateFeeForAmount(1000n, { feeBps: -1 })).toThrow(RangeError);
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
