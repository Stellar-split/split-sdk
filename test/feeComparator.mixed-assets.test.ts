import { describe, expect, it } from "vitest";
import { compareFees, DivisionByZeroError } from "../src/feeComparator.js";

describe("compareFees", () => {
  it("orders mixed-asset fees using a mock exchange rate", () => {
    const rateProvider = () => 2;

    expect(
      compareFees(
        { amount: 100, asset: "XLM" },
        { amount: 60, asset: "USDC" },
        rateProvider,
      ),
    ).toBe(-1);
  });

  it("throws when the exchange rate is zero", () => {
    expect(() =>
      compareFees(
        { amount: 100, asset: "XLM" },
        { amount: 60, asset: "USDC" },
        () => 0,
      ),
    ).toThrow(DivisionByZeroError);
  });

  it("returns zero for equal mixed-asset fees after conversion", () => {
    expect(
      compareFees(
        { amount: 100, asset: "XLM" },
        { amount: 50, asset: "USDC" },
        () => 2,
      ),
    ).toBe(0);
  });
});
