import { describe, expect, it, vi } from "vitest";
import { estimateOperationCost, type FeeEstimate } from "../src/feeEstimator.js";
import { rpc as SorobanRpc, BASE_FEE, Operation, Asset } from "@stellar/stellar-sdk";

describe("feeEstimator", () => {
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
});
