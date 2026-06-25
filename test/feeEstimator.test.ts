import { describe, expect, it, vi } from "vitest";
import { estimateOperationCost, type FeeEstimate } from "../src/feeEstimator.js";
import { rpc as SorobanRpc, BASE_FEE } from "@stellar/stellar-sdk";

describe("feeEstimator", () => {
  it("returns fee estimate with base and resource fees", async () => {
    const mockServer = {
      simulateTransaction: vi.fn().mockResolvedValue({
        minResourceFee: "1000",
      } as SorobanRpc.Api.SimulateTransactionSuccessResponse),
    } as unknown as SorobanRpc.Server;

    const operation = {
      type: "invokeHostFunction",
      function: { type: "wasm" },
    };

    const result = await estimateOperationCost(
      operation,
      "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2",
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

    const operation = { type: "invokeHostFunction" };

    const result = await estimateOperationCost(
      operation,
      "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2",
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

    const operation = { type: "invokeHostFunction" };

    const result = await estimateOperationCost(
      operation,
      "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2",
      mockServer,
      "Test SDF Network ; September 2015"
    );

    expect(result).toHaveProperty("error");
    expect(result).toHaveProperty("baseFee", BASE_FEE.toString());
  });
});
