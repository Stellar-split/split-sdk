import { describe, expect, it } from "vitest";
import { RateCache } from "../src/rateCache.js";

describe("RateCache", () => {
  it("evicts after inserting maxSize + 1 entries", async () => {
    const cache = new RateCache(async (from, to) => `${from}:${to}`, { maxSize: 2 });

    await cache.getRate("XLM", "USD");
    await cache.getRate("USDC", "USD");
    await cache.getRate("BTC", "USD");

    expect(cache.size).toBe(2);
  });
});
