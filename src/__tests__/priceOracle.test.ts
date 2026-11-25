import { beforeEach, describe, expect, it, vi } from "vitest";
import { PriceOracle, parseOraclePrice, type OracleProvider } from "../priceOracle.js";

describe("parseOraclePrice", () => {
  it("parses a numeric price and timestamp", () => {
    const result = parseOraclePrice("XLM", { price: 0.42, timestamp: 1700000000000 });
    expect(result).toEqual({ symbol: "XLM", price: 0.42, timestamp: 1700000000000 });
  });
});

describe("PriceOracle multi-provider integration", () => {
  const makeProvider = (
    name: string,
    fetcher: OracleProvider["fetcher"],
  ): OracleProvider => ({ name, fetcher });

  it("aggregates prices across multiple providers", async () => {
    const oracle = new PriceOracle([
      makeProvider("a", async () => ({ price: 2 })),
      makeProvider("b", async () => ({ price: 4 })),
      makeProvider("c", async () => ({ price: 6 })),
    ]);
    const price = await oracle.fetchPrice("XLM");
    expect(price.price).toBe(4);
    expect(price.symbol).toBe("XLM");
  });

  it("falls back to remaining providers when one fails", async () => {
    const oracle = new PriceOracle([
      makeProvider("bad", async () => {
        throw new Error("provider down");
      }),
      makeProvider("good", async () => ({ price: 5 })),
    ]);
    const price = await oracle.fetchPrice("XLM");
    expect(price.price).toBe(5);
  });

  it("rejects invalid prices from a provider and uses valid ones", async () => {
    const oracle = new PriceOracle([
      makeProvider("invalid", async () => ({ price: -1 })),
      makeProvider("valid", async () => ({ price: 3 })),
    ]);
    const price = await oracle.fetchPrice("XLM");
    expect(price.price).toBe(3);
  });

  it("throws when all providers fail", async () => {
    const oracle = new PriceOracle([
      makeProvider("a", async () => {
        throw new Error("down");
      }),
      makeProvider("b", async () => ({ price: 0 })),
    ]);
    await expect(oracle.fetchPrice("XLM")).rejects.toThrow(/Insufficient valid oracle prices/);
  });

  it("serves the cached value when fetches are rate limited", async () => {
    const fetcher = vi.fn(async () => ({ price: 1 }));
    const oracle = new PriceOracle(
      [makeProvider("a", fetcher)],
      { rateLimitMs: 1000 },
    );
    const first = await oracle.fetchPrice("XLM");
    const second = await oracle.fetchPrice("XLM");
    expect(second).toEqual(first);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });

  it("reports provider health for monitoring", async () => {
    const oracle = new PriceOracle([
      makeProvider("ok", async () => ({ price: 2 })),
      makeProvider("bad", async () => {
        throw new Error("down");
      }),
    ]);
    await oracle.fetchPrice("XLM");
    const stats = oracle.getProviderStats();
    expect(stats.find((provider) => provider.name === "ok")?.successes).toBe(1);
    expect(stats.find((provider) => provider.name === "bad")?.failures).toBe(1);
  });
});
