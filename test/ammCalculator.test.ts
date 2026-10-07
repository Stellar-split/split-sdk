import { describe, it, expect } from "vitest";
import type { Asset } from "../src/types";
import { estimateSwapOutput } from "../src/ammCalculator";

const ASSET_X = { name: "X", decimals: 6 } as Asset;
const ASSET_Y = { name: "Y", decimals: 6 } as Asset;

function makePool(reserves: [string, string]) {
  return {
    assets: [ASSET_X, ASSET_Y] as [Asset, Asset],
    reserves,
  };
}

const POOL = makePool(["1000", "1000"]);

describe("estimateSwapOutput", () => {
  it("computes swap output using constant product formula", () => {
    const result = estimateSwapOutput(POOL, "100", ASSET_X);
    expect(result.outputAmount).toBe("91");
  });

  it("preserves constant product after swap", () => {
    const pool = makePool(["1000", "1000"]);
    const result = estimateSwapOutput(pool, "100", ASSET_X);

    const newReserveIn = 1000n + 100n;
    const newReserveOut = 1000n - BigInt(result.outputAmount);
    const oldProduct = 1000n * 1000n;
    const newProduct = newReserveIn * newReserveOut;

    expect(newProduct).toBeGreaterThan(oldProduct);
  });

  it("returns zero output for zero input", () => {
    const result = estimateSwapOutput(POOL, "0", ASSET_X);
    expect(result.outputAmount).toBe("0");
    expect(result.priceImpactPercent).toBe("0.00");
  });

  it("computes spot price correctly", () => {
    const result = estimateSwapOutput(POOL, "100", ASSET_X);
    expect(result.spotPrice).toBe("1");
  });

  it("computes effective price correctly", () => {
    const result = estimateSwapOutput(POOL, "100", ASSET_X);
    expect(result.effectivePrice).toBe("0.91");
  });

  it("normalizes integer and fractional prices before computing impact", () => {
    const pool = makePool([
      { asset: ASSET_X, amount: "1000" },
      { asset: ASSET_Y, amount: "1000" },
    ]);

    const result = estimateSwapOutput(pool, "100", ASSET_X);

    expect(result.outputAmount).toBe("91");
    expect(result.spotPrice).toBe("1");
    expect(result.effectivePrice).toBe("0.91");
    expect(result.priceImpactPercent).toBe("9.00");
  });

  it("returns zero price impact for equal spot and effective price", () => {
    const pool = makePool(["1000", "1000"]);
    const result = estimateSwapOutput(pool, "1", ASSET_X);
    expect(result.priceImpactPercent).toBe("0.00");
  });

  it("handles different reserve ratios", () => {
    const pool = makePool(["500", "1500"]);
    const result = estimateSwapOutput(pool, "100", ASSET_X);
    expect(result.outputAmount).toBe("225");
    expect(result.spotPrice).toBe("3");
  });

  it("computes price impact for asymmetric pool", () => {
    const pool = makePool(["100", "1000"]);
    const result = estimateSwapOutput(pool, "50", ASSET_X);
    expect(result.priceImpactPercent).not.toBe("0.00");
  });

  it("handles large swap relative to pool size", () => {
    const pool = makePool(["1000", "1000"]);
    const result = estimateSwapOutput(pool, "500", ASSET_X);
    expect(result.outputAmount).toBe("333");
    expect(result.priceImpactPercent).not.toBe("0.00");
  });

  it("preserves asset order in output", () => {
    const pool = makePool(["1000", "1000"]);
    const resultYToX = estimateSwapOutput(pool, "100", ASSET_Y);
    const resultXToY = estimateSwapOutput(pool, "100", ASSET_X);

    expect(resultYToX.outputAmount).toBe(resultXToY.outputAmount);
  });

  it("handles edge case with minimal reserves", () => {
    const pool = makePool(["10", "10"]);
    const result = estimateSwapOutput(pool, "1", ASSET_X);
    expect(result.outputAmount).toBe("0");
  });
});
