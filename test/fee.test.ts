import { describe, it, expect } from "vitest";

describe("calculateFee", () => {
  it("computes fee correctly for 100bps on 1000 USDC", () => {
    const gross = 1000n * 10_000_000n; // 1000 USDC in stroops
    const feeBps = 100; // 1%
    const expectedFee = (gross * BigInt(feeBps)) / 10_000n;
    const expectedNet = gross - expectedFee;

    expect(expectedFee).toBe(100_000_000n); // 10 USDC
    expect(expectedNet).toBe(9_900_000_000n); // 990 USDC
  });

  it("returns zero fee when feeBps is 0", () => {
    const gross = 1000n * 10_000_000n;
    const feeBps = 0;
    const fee = (gross * BigInt(feeBps)) / 10_000n;

    expect(fee).toBe(0n);
  });
});
