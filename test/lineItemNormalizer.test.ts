import { describe, it, expect, vi } from "vitest";
import { normalizeLineItems } from "../src/lineItemNormalizer.js";
import { UnsupportedLineItemAssetError } from "../src/errors.js";
import type { InvoiceLineItem } from "../src/types.js";
import type { PriceOracle } from "../src/priceOracle.js";

const RATE_SCALE = 1_000_000_000_000_000_000n;

function mockOracle(rates: Record<string, bigint | undefined>): PriceOracle {
  return {
    getRate: vi.fn(async (fromAsset: string) => rates[fromAsset]),
  };
}

describe("normalizeLineItems", () => {
  it("passes same-asset items through without calling the oracle", async () => {
    const items: InvoiceLineItem[] = [
      { description: "Service fee", quantity: 2, unitPrice: 5_000_000n, asset: "USDC" },
    ];
    const oracle = mockOracle({});

    const result = await normalizeLineItems(items, "USDC", oracle);

    expect(oracle.getRate).not.toHaveBeenCalled();
    expect(result.total).toBe(10_000_000n);
    expect(result.items[0]).toEqual({
      description: "Service fee",
      originalAmount: 10_000_000n,
      originalAsset: "USDC",
      convertedAmount: 10_000_000n,
      conversionRate: RATE_SCALE,
    });
  });

  it("calls the oracle once per unique cross-asset pair", async () => {
    const items: InvoiceLineItem[] = [
      { description: "Network cost", quantity: 1, unitPrice: 10_000_000n, asset: "native" },
      { description: "More network cost", quantity: 1, unitPrice: 5_000_000n, asset: "native" },
      { description: "Platform credit", quantity: 1, unitPrice: 1_000_000n, asset: "CREDIT:GISSUER" },
    ];
    const oracle = mockOracle({
      native: 2n * RATE_SCALE, // 1 native = 2 USDC
      "CREDIT:GISSUER": RATE_SCALE / 2n, // 1 credit = 0.5 USDC
    });

    const result = await normalizeLineItems(items, "USDC", oracle);

    expect(oracle.getRate).toHaveBeenCalledTimes(2);
    expect(oracle.getRate).toHaveBeenCalledWith("native", "USDC");
    expect(oracle.getRate).toHaveBeenCalledWith("CREDIT:GISSUER", "USDC");
    expect(result.items[0]!.convertedAmount).toBe(20_000_000n);
    expect(result.items[1]!.convertedAmount).toBe(10_000_000n);
    expect(result.items[2]!.convertedAmount).toBe(500_000n);
    expect(result.total).toBe(30_500_000n);
  });

  it("passes zero-amount items through without calling the oracle", async () => {
    const items: InvoiceLineItem[] = [
      { description: "Discount", quantity: 1, unitPrice: 0n, asset: "native" },
      { description: "Waiver", quantity: 5, unitPrice: 0n, asset: "CREDIT:GISSUER" },
    ];
    const oracle = mockOracle({});

    const result = await normalizeLineItems(items, "USDC", oracle);

    expect(oracle.getRate).not.toHaveBeenCalled();
    expect(result.total).toBe(0n);
    expect(result.items.every((i) => i.convertedAmount === 0n)).toBe(true);
  });

  it("throws UnsupportedLineItemAssetError when no oracle price is available", async () => {
    const items: InvoiceLineItem[] = [
      { description: "Mystery token", quantity: 1, unitPrice: 1_000_000n, asset: "MYSTERY:GISSUER" },
    ];
    const oracle = mockOracle({ "MYSTERY:GISSUER": undefined });

    await expect(normalizeLineItems(items, "USDC", oracle)).rejects.toThrow(
      UnsupportedLineItemAssetError
    );
  });

  it("uses the total override instead of quantity * unitPrice when provided", async () => {
    const items: InvoiceLineItem[] = [
      {
        description: "Bulk disccount",
        quantity: 10,
        unitPrice: 1_000_000n,
        total: 8_000_000n,
        asset: "USDC",
      },
    ];
    const oracle = mockOracle({});

    const result = await normalizeLineItems(items, "USDC", oracle);

    expect(result.items[0]!.originalAmount).toBe(8_000_000n);
    expect(result.total).toBe(8_000_000n);
  });
});
