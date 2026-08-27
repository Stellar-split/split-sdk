import { describe, it, expect } from "vitest";
import { estimateSwapOutput } from "../ammCalculator.js";
import { InsufficientLiquidityError } from "../errors.js";

// ---------------------------------------------------------------------------
// Constant-product invariant preservation (issue #683)
// ---------------------------------------------------------------------------

function makePool(reserveIn: string, reserveOut: string) {
  return {
    reserves: [
      { asset: "XLM", amount: reserveIn },
      { asset: "USDC", amount: reserveOut },
    ],
  };
}

describe("constant-product invariant preservation", () => {
  it("preserves k = reserveA * reserveB after a simulated swap", () => {
    const reserveIn = 1_000_000_000_000n;
    const reserveOut = 500_000_000_000n;
    const pool = makePool(reserveIn.toString(), reserveOut.toString());
    const k = reserveIn * reserveOut;

    const inputAmount = 10_000_000n;
    const result = estimateSwapOutput(pool, inputAmount.toString(), "XLM");

    const newReserveIn = reserveIn + inputAmount;
    const newReserveOut = reserveOut - BigInt(result.outputAmount);
    const newK = newReserveIn * newReserveOut;

    // Integer-division rounding means newK can only ever be <= k, and the
    // relative drift must stay within a tight tolerance (no fee/rounding bug
    // can silently break the invariant).
    expect(newK).toBeLessThanOrEqual(k);
    const drift = k - newK;
    const tolerance = k / 1_000_000n; // 0.0001% relative tolerance
    expect(drift).toBeLessThanOrEqual(tolerance);
  });

  it("holds across a range of input sizes", () => {
    const reserveIn = 250_000_000_000n;
    const reserveOut = 250_000_000_000n;
    const pool = makePool(reserveIn.toString(), reserveOut.toString());
    const k = reserveIn * reserveOut;

    for (const inputAmount of [1n, 1_000n, 1_000_000n, 50_000_000_000n]) {
      const result = estimateSwapOutput(pool, inputAmount.toString(), "XLM");
      const newReserveIn = reserveIn + inputAmount;
      const newReserveOut = reserveOut - BigInt(result.outputAmount);
      const newK = newReserveIn * newReserveOut;

      expect(newK).toBeLessThanOrEqual(k);
      const drift = k - newK;
      const tolerance = k / 1_000_000n;
      expect(drift).toBeLessThanOrEqual(tolerance);
    }
  });

  it("throws InsufficientLiquidityError for a swap larger than available reserves", () => {
    const pool = makePool("1000", "1000");
    expect(() => estimateSwapOutput(pool, "1000000", "XLM")).toThrow(
      InsufficientLiquidityError,
    );
  });

  it("returns 0 received and leaves reserves unchanged for a zero-amount swap", () => {
    const reserveIn = 1_000_000n;
    const reserveOut = 2_000_000n;
    const pool = makePool(reserveIn.toString(), reserveOut.toString());

    const result = estimateSwapOutput(pool, "0", "XLM");

    expect(result.outputAmount).toBe("0");
    // Reserves reported back on the pool object itself are untouched — the
    // function is pure and never mutates its input.
    expect(pool.reserves[0]!.amount).toBe(reserveIn.toString());
    expect(pool.reserves[1]!.amount).toBe(reserveOut.toString());
  });
});
