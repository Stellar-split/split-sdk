import { describe, it, expect } from "vitest";
import { estimateSwapOutput, calculatePoolShare } from "../src/ammCalculator.js";
import { InsufficientLiquidityError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Helper: create a mock pool record similar to LiquidityPoolRecord
// ---------------------------------------------------------------------------

function makePool(reserves: { asset: string; amount: string }[], totalShares = "1000000") {
  return {
    reserves,
    totalShares,
  };
}

const ASSET_X = "XLM";
const ASSET_Y = "USDC";

const POOL: ReturnType<typeof makePool> = makePool([
  { asset: ASSET_X, amount: "1000000000000" }, // 1,000,000 XLM in stroops
  { asset: ASSET_Y, amount: "1000000000000" }, // 1,000,000 USDC in stroops
]);

describe("estimateSwapOutput", () => {
  it("returns correct output for a small input (constant-product formula)", () => {
    // k = 1e12 * 1e12 = 1e24
    // Δx = 1000 stroops
    // newReserveIn  = 1e12 + 1000 = 1000000001000
    // newReserveOut = 1e24 / 1000000001000 = 999999999000 (approx)
    // outputAmount  = 1e12 - 999999999000 = 1000 (approx)
    const result = estimateSwapOutput(POOL, "10000000", ASSET_X);

    expect(result.inputAsset).toBe(ASSET_X);
    expect(result.outputAsset).toBe(ASSET_Y);
    expect(BigInt(result.outputAmount)).toBeGreaterThan(0n);
    // Output is slightly less than input due to slippage
    expect(BigInt(result.outputAmount)).toBeLessThan(BigInt("10000000"));

    // Price impact should be very small (less than 0.01% for such a small input)
    // The output is nearly equal to input for tiny swaps in deep pools
    expect(BigInt(result.outputAmount)).toBeGreaterThan(BigInt("9990000"));
    expect(BigInt(result.outputAmount)).toBeLessThan(BigInt("10000000"));

    // Spot price is 1.0 (equal reserves), effective price slightly less
    expect(parseFloat(result.spotPrice)).toBeCloseTo(1.0);
  });

  it("returns zero output and zero price impact for zero input", () => {
    const result = estimateSwapOutput(POOL, "0", ASSET_X);
    expect(result.outputAmount).toBe("0");
    expect(result.priceImpactPercent).toBe("0.00");
    expect(result.effectivePrice).toBe("0");
  });

  it("throws InsufficientLiquidityError when pool has only one reserve", () => {
    const badPool = makePool([{ asset: ASSET_X, amount: "1000" }]);
    expect(() => estimateSwapOutput(badPool, "100", ASSET_X)).toThrow(
      InsufficientLiquidityError
    );
  });

  it("throws InsufficientLiquidityError when input exceeds the default 30% threshold", () => {
    const tinyPool = makePool([
      { asset: ASSET_X, amount: "100" },
      { asset: ASSET_Y, amount: "100" },
    ]);
    expect(() => estimateSwapOutput(tinyPool, "31", ASSET_X)).toThrow(
      InsufficientLiquidityError
    );
    // 30 should be allowed
    expect(() => estimateSwapOutput(tinyPool, "30", ASSET_X)).not.toThrow();
  });

  it("respects a custom maxRatio threshold", () => {
    const tinyPool = makePool([
      { asset: ASSET_X, amount: "100" },
      { asset: ASSET_Y, amount: "100" },
    ]);
    // 20% of 100 = 20, so 21 should throw
    expect(() => estimateSwapOutput(tinyPool, "21", ASSET_X, 0.2)).toThrow(
      InsufficientLiquidityError
    );
    expect(() => estimateSwapOutput(tinyPool, "20", ASSET_X, 0.2)).not.toThrow();
  });

  it("throws when asset is not in pool reserves", () => {
    expect(() => estimateSwapOutput(POOL, "100", "BTC")).toThrow(
      InsufficientLiquidityError
    );
  });

  it("throws when pool has zero reserves", () => {
    const zeroPool = makePool([
      { asset: ASSET_X, amount: "0" },
      { asset: ASSET_Y, amount: "0" },
    ]);
    expect(() => estimateSwapOutput(zeroPool, "100", ASSET_X)).toThrow(
      InsufficientLiquidityError
    );
  });
});

describe("calculatePoolShare", () => {
  it("returns correct proportional reserves for 50% ownership", () => {
    const pool = makePool(
      [
        { asset: ASSET_X, amount: "1000000" },
        { asset: ASSET_Y, amount: "2000000" },
      ],
      "1000000"
    );

    const result = calculatePoolShare(pool, "500000");
    // 50% share
    expect(result.shareOfAssetA).toBe("500000"); // 500k = 50% of 1M
    expect(result.shareOfAssetB).toBe("1000000"); // 1M = 50% of 2M
    expect(result.ownershipPercent).toBe("50.00");
  });

  it("returns zero for zero shares owned", () => {
    const pool = makePool(
      [
        { asset: ASSET_X, amount: "1000000" },
        { asset: ASSET_Y, amount: "2000000" },
      ],
      "1000000"
    );
    const result = calculatePoolShare(pool, "0");
    expect(result.shareOfAssetA).toBe("0");
    expect(result.shareOfAssetB).toBe("0");
    expect(result.sharesOwned).toBe("0");
    expect(result.ownershipPercent).toBe("0.00");
  });

  it("returns correct proportional reserves for 10% ownership", () => {
    const pool = makePool(
      [
        { asset: ASSET_X, amount: "1000000" },
        { asset: ASSET_Y, amount: "500000" },
      ],
      "1000000"
    );
    const result = calculatePoolShare(pool, "100000");
    expect(result.shareOfAssetA).toBe("100000"); // 10% of 1M
    expect(result.shareOfAssetB).toBe("50000"); // 10% of 500k
    expect(result.ownershipPercent).toBe("10.00");
  });

  it("throws for pool with zero total shares", () => {
    const pool = makePool(
      [
        { asset: ASSET_X, amount: "1000" },
        { asset: ASSET_Y, amount: "1000" },
      ],
      "0"
    );
    expect(() => calculatePoolShare(pool, "100")).toThrow(
      InsufficientLiquidityError
    );
  });

  it("throws for pool with fewer than 2 reserves", () => {
    const pool = {
      reserves: [{ asset: ASSET_X, amount: "1000" }],
      totalShares: "1000",
    };
    expect(() => calculatePoolShare(pool, "100")).toThrow(
      InsufficientLiquidityError
    );
  });
});
