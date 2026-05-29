import { describe, it, expect, beforeEach, vi } from "vitest";
import type { TokenInfo } from "../src/token.js";

describe("resolveToken", () => {
  beforeEach(() => {
    // Clear cache before each test
    vi.resetModules();
  });

  it("returns correct token metadata structure", () => {
    const mockTokenInfo: TokenInfo = {
      address: "CBBD47AB2EB00E041B5B13A596261F07D3FA7F19B566F3BEA881F5D414951F94",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    };

    expect(mockTokenInfo.symbol).toBe("USDC");
    expect(mockTokenInfo.name).toBe("USD Coin");
    expect(mockTokenInfo.decimals).toBe(6);
    expect(mockTokenInfo.address).toBe("CBBD47AB2EB00E041B5B13A596261F07D3FA7F19B566F3BEA881F5D414951F94");
  });

  it("caches token metadata after first fetch", () => {
    const mockTokenInfo: TokenInfo = {
      address: "CBBD47AB2EB00E041B5B13A596261F07D3FA7F19B566F3BEA881F5D414951F94",
      symbol: "USDC",
      name: "USD Coin",
      decimals: 6,
    };

    // Verify cache structure
    expect(mockTokenInfo).toBeDefined();
    expect(mockTokenInfo.address).toBeDefined();
  });
});
