import { describe, it, expect } from "vitest";
import type { RoutingHop } from "../src/types/routing.js";

describe("RoutingHop", () => {
  it("accepts a hop without weight", () => {
    const hop: RoutingHop = {
      sourceAsset: "native",
      destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      sourceAmount: 1_000_000n,
      destAmount: 950_000n,
    };
    expect(hop.weight).toBeUndefined();
  });

  it("accepts a hop with weight = 0", () => {
    const hop: RoutingHop = {
      sourceAsset: "native",
      destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      sourceAmount: 1_000_000n,
      destAmount: 950_000n,
      weight: 0,
    };
    expect(hop.weight).toBe(0);
  });

  it("accepts a hop with weight = 1", () => {
    const hop: RoutingHop = {
      sourceAsset: "native",
      destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      sourceAmount: 1_000_000n,
      destAmount: 950_000n,
      weight: 1,
    };
    expect(hop.weight).toBe(1);
  });

  it("accepts a hop with fractional weight", () => {
    const hop: RoutingHop = {
      sourceAsset: "native",
      destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      sourceAmount: 1_000_000n,
      destAmount: 950_000n,
      weight: 0.75,
    };
    expect(hop.weight).toBe(0.75);
  });

  it("preserves existing fields unchanged", () => {
    const hop: RoutingHop = {
      sourceAsset: "native",
      destAsset: "USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN",
      sourceAmount: 500n,
      destAmount: 490n,
      weight: 0.9,
    };
    expect(hop.sourceAsset).toBe("native");
    expect(hop.destAsset).toBe("USDC:GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN");
    expect(hop.sourceAmount).toBe(500n);
    expect(hop.destAmount).toBe(490n);
  });

  it("higher weight indicates more preferred hop", () => {
    const preferred: RoutingHop = {
      sourceAsset: "native",
      destAsset: "USDC",
      sourceAmount: 100n,
      destAmount: 95n,
      weight: 0.9,
    };
    const lessFavored: RoutingHop = {
      sourceAsset: "native",
      destAsset: "USDC",
      sourceAmount: 100n,
      destAmount: 94n,
      weight: 0.3,
    };
    expect(preferred.weight!).toBeGreaterThan(lessFavored.weight!);
  });
});
