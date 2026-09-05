import { describe, it, expect, vi } from "vitest";
import {
  splitExecutor,
  SPLIT_RATIO_TOLERANCE,
  type SplitRecipient,
} from "../src/payments/splitExecutor.js";
import { SplitRatioSumError } from "../src/errors.js";

// Mock the subentry guard so tests don't hit Horizon
vi.mock("../src/account/subentryGuard.js", () => ({
  checkSubentryCapacity: vi.fn().mockResolvedValue({ sufficient: true, availableSlots: 10 }),
  SubentryCapacityGuardError: class extends Error {},
}));

describe("splitExecutor", () => {
  it("proceeds when no ratios are provided", async () => {
    const recipients: SplitRecipient[] = [
      { address: "GABC...", amount: 5_000_000n },
      { address: "GDEF...", amount: 5_000_000n },
    ];
    const result = await splitExecutor(recipients, { skipCapacityCheck: true });
    expect(result.success).toBe(true);
  });

  it("proceeds when ratios sum to 1.0 within tolerance", async () => {
    const recipients: SplitRecipient[] = [
      { address: "GABC...", amount: 4_000_000n, ratio: 0.4 },
      { address: "GDEF...", amount: 3_000_000n, ratio: 0.3 },
      { address: "GHIJ...", amount: 3_000_000n, ratio: 0.3 },
    ];
    const result = await splitExecutor(recipients, { skipCapacityCheck: true });
    expect(result.success).toBe(true);
  });

  it("throws SplitRatioSumError when ratios sum to less than 1.0", async () => {
    const recipients: SplitRecipient[] = [
      { address: "GABC...", amount: 3_000_000n, ratio: 0.3 },
      { address: "GDEF...", amount: 3_000_000n, ratio: 0.3 },
    ];
    await expect(splitExecutor(recipients, { skipCapacityCheck: true })).rejects.toThrow(
      SplitRatioSumError,
    );
  });

  it("throws SplitRatioSumError when ratios sum to more than 1.0", async () => {
    const recipients: SplitRecipient[] = [
      { address: "GABC...", amount: 6_000_000n, ratio: 0.6 },
      { address: "GDEF...", amount: 5_000_000n, ratio: 0.5 },
    ];
    await expect(splitExecutor(recipients, { skipCapacityCheck: true })).rejects.toThrow(
      SplitRatioSumError,
    );
  });

  it("includes actualSum in the thrown SplitRatioSumError", async () => {
    const recipients: SplitRecipient[] = [
      { address: "GABC...", amount: 3_000_000n, ratio: 0.3 },
      { address: "GDEF...", amount: 3_000_000n, ratio: 0.3 },
    ];
    try {
      await splitExecutor(recipients, { skipCapacityCheck: true });
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(SplitRatioSumError);
      expect((err as SplitRatioSumError).actualSum).toBeCloseTo(0.6, 10);
    }
  });

  it("tolerates floating-point rounding within SPLIT_RATIO_TOLERANCE", async () => {
    const recipients: SplitRecipient[] = [
      { address: "GABC...", amount: 3_333_333n, ratio: 0.3333333333 },
      { address: "GDEF...", amount: 3_333_333n, ratio: 0.3333333333 },
      { address: "GHIJ...", amount: 3_333_334n, ratio: 0.3333333334 },
    ];
    const result = await splitExecutor(recipients, { skipCapacityCheck: true });
    expect(result.success).toBe(true);
  });

  it("rejects when rounding exceeds SPLIT_RATIO_TOLERANCE", async () => {
    const recipients: SplitRecipient[] = [
      { address: "GABC...", amount: 5_000_000n, ratio: 0.5 },
      { address: "GDEF...", amount: 5_000_000n, ratio: 0.500000002 },
    ];
    await expect(splitExecutor(recipients, { skipCapacityCheck: true })).rejects.toThrow(
      SplitRatioSumError,
    );
  });

  it("exports SPLIT_RATIO_TOLERANCE as 1e-9", () => {
    expect(SPLIT_RATIO_TOLERANCE).toBe(1e-9);
  });
});
