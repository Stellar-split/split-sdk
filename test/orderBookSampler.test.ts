/**
 * Unit tests for #543 — OrderBookSampler
 *
 * Uses mock order-book data; no live Horizon calls.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { Asset } from "@stellar/stellar-sdk";
import {
  OrderBookSampler,
  simulateFill,
} from "../src/orderBookSampler.js";
import type { OrderBookSample } from "../src/orderBookSampler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeLevel(price: string, amount: string) {
  return { price, amount };
}

// ---------------------------------------------------------------------------
// simulateFill — pure fill simulation
// ---------------------------------------------------------------------------

describe("simulateFill", () => {
  it("fully fills when order book has enough liquidity", () => {
    const levels = [
      makeLevel("1.0", "100"),
      makeLevel("1.1", "200"),
      makeLevel("1.2", "300"),
    ];
    const result = simulateFill(150n, levels);

    expect(result.filledFraction).toBe(1);
    expect(result.filledAtLevels).toHaveLength(2);
    // Best price is the first level touched
    expect(result.bestPrice).toBeCloseTo(1.0);
    // Worst price is the second level touched
    expect(result.worstPrice).toBeCloseTo(1.1);
    // Cost: 100 * 1.0 + 50 * 1.1 = 155
    expect(result.estimatedCost).toBeCloseTo(155);
    // Slippage: (1.1 - 1.0) / 1.0 * 100 = 10%
    expect(result.slippagePercent).toBeCloseTo(10);
  });

  it("partially fills when order book cannot satisfy the full amount", () => {
    const levels = [
      makeLevel("1.0", "50"),
      makeLevel("1.1", "30"),
    ];
    // We want 200 but only 80 available
    const result = simulateFill(200n, levels);

    expect(result.filledFraction).toBeLessThan(1);
    expect(result.filledAtLevels).toHaveLength(2);
    expect(result.filledFraction).toBeCloseTo(80 / 200);
  });

  it("returns zero liquidity result for empty order book", () => {
    const result = simulateFill(100n, []);

    expect(result.filledFraction).toBe(0);
    expect(result.estimatedCost).toBe(0);
    expect(result.slippagePercent).toBe(0);
    expect(result.filledAtLevels).toHaveLength(0);
    expect(result.bestPrice).toBe(0);
    expect(result.worstPrice).toBe(0);
  });

  it("returns filled fraction 1 for zero amount request", () => {
    const levels = [makeLevel("1.0", "100")];
    const result = simulateFill(0n, levels);
    expect(result.filledFraction).toBe(1);
  });

  it("computes correct slippage when only one level is touched", () => {
    const levels = [makeLevel("2.5", "1000")];
    const result = simulateFill(100n, levels);
    expect(result.slippagePercent).toBeCloseTo(0);
    expect(result.bestPrice).toBeCloseTo(2.5);
    expect(result.worstPrice).toBeCloseTo(2.5);
  });
});

// ---------------------------------------------------------------------------
// OrderBookSampler — integration with mocked Horizon
// ---------------------------------------------------------------------------

describe("OrderBookSampler", () => {
  const mockOrderbook = {
    asks: [
      { price: "1.0", amount: "500" },
      { price: "1.05", amount: "300" },
    ],
    bids: [
      { price: "0.99", amount: "400" },
      { price: "0.95", amount: "200" },
    ],
  };

  const mockServer = {
    orderbook: vi.fn().mockReturnValue({
      call: vi.fn().mockResolvedValue(mockOrderbook),
    }),
  };

  beforeEach(() => {
    vi.clearAllMocks();
    mockServer.orderbook.mockReturnValue({
      call: vi.fn().mockResolvedValue(mockOrderbook),
    });
  });

  it("samples the asks side for a buy order", async () => {
    const sampler = new OrderBookSampler({ horizonUrl: "https://horizon.stellar.org" });
    // Inject mock server
    (sampler as unknown as { server: typeof mockServer }).server = mockServer;

    const result = await sampler.sample(
      Asset.native(),
      new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
      "buy",
      600n,
    );

    expect(result.bestPrice).toBeCloseTo(1.0);
    expect(result.filledFraction).toBe(1);
    expect(result.filledAtLevels.length).toBeGreaterThan(0);
    expect(result.estimatedCost).toBeGreaterThan(0);
  });

  it("samples the bids side for a sell order", async () => {
    const sampler = new OrderBookSampler({ horizonUrl: "https://horizon.stellar.org" });
    (sampler as unknown as { server: typeof mockServer }).server = mockServer;

    const result = await sampler.sample(
      Asset.native(),
      new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
      "sell",
      500n,
    );

    expect(result.bestPrice).toBeCloseTo(0.99);
    expect(result.filledFraction).toBe(1);
  });

  it("reports partial fill when order book is thin", async () => {
    const thinBook = {
      asks: [{ price: "1.0", amount: "10" }],
      bids: [],
    };
    mockServer.orderbook.mockReturnValue({
      call: vi.fn().mockResolvedValue(thinBook),
    });

    const sampler = new OrderBookSampler({ horizonUrl: "https://horizon.stellar.org" });
    (sampler as unknown as { server: typeof mockServer }).server = mockServer;

    const result = await sampler.sample(
      Asset.native(),
      new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
      "buy",
      1000n,
    );

    expect(result.filledFraction).toBeLessThan(1);
  });

  it("respects slippageTolerancePercent config", () => {
    const sampler = new OrderBookSampler({
      horizonUrl: "https://horizon.stellar.org",
      slippageTolerancePercent: 0.5,
    });
    expect(sampler.slippageTolerancePercent).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// PathRouter highSlippageWarning integration
// ---------------------------------------------------------------------------

describe("PathRouter slippage integration", () => {
  it("calls onHighSlippage when slippage exceeds tolerance", async () => {
    const { PathRouter } = await import("../src/pathRouter.js");

    const warningSpy = vi.fn();
    const router = new PathRouter("https://horizon.stellar.org", {
      slippageTolerancePercent: 0.1,
      onHighSlippage: warningSpy,
    });

    // Mock the sampler to return high slippage
    const highSlippageEstimate: OrderBookSample = {
      estimatedCost: 1000,
      slippagePercent: 5,
      worstPrice: 1.05,
      bestPrice: 1.0,
      filledAtLevels: [{ price: 1.0, amountFilled: 50 }, { price: 1.05, amountFilled: 50 }],
      filledFraction: 1,
    };

    const mockSampler = {
      sample: vi.fn().mockResolvedValue(highSlippageEstimate),
    };

    (router as unknown as { sampler: typeof mockSampler }).sampler = mockSampler;

    // Mock the server to throw PathNotFoundError so we don't need real Horizon
    const mockServer = {
      strictSendPaths: vi.fn().mockReturnValue({
        call: vi.fn().mockResolvedValue({ records: [] }),
      }),
    };
    (router as unknown as { server: typeof mockServer }).server = mockServer;

    // findStrictSendPath will throw PathNotFoundError (empty records), but
    // the warning should already have fired before that
    try {
      await router.findStrictSendPath({
        sourceAsset: Asset.native(),
        sourceAmount: 100n,
        destinationAsset: new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
      });
    } catch {
      // expected PathNotFoundError
    }

    expect(warningSpy).toHaveBeenCalledOnce();
    expect(warningSpy.mock.calls[0][0].slippagePercent).toBe(5);
    expect(warningSpy.mock.calls[0][0].slippageTolerancePercent).toBe(0.1);
  });

  it("does NOT call onHighSlippage when slippage is within tolerance", async () => {
    const { PathRouter } = await import("../src/pathRouter.js");

    const warningSpy = vi.fn();
    const router = new PathRouter("https://horizon.stellar.org", {
      slippageTolerancePercent: 10,
      onHighSlippage: warningSpy,
    });

    const lowSlippageEstimate: OrderBookSample = {
      estimatedCost: 100,
      slippagePercent: 0.5,
      worstPrice: 1.005,
      bestPrice: 1.0,
      filledAtLevels: [{ price: 1.0, amountFilled: 100 }],
      filledFraction: 1,
    };

    const mockSampler = { sample: vi.fn().mockResolvedValue(lowSlippageEstimate) };
    (router as unknown as { sampler: typeof mockSampler }).sampler = mockSampler;

    const mockServer = {
      strictSendPaths: vi.fn().mockReturnValue({
        call: vi.fn().mockResolvedValue({ records: [] }),
      }),
    };
    (router as unknown as { server: typeof mockServer }).server = mockServer;

    try {
      await router.findStrictSendPath({
        sourceAsset: Asset.native(),
        sourceAmount: 100n,
        destinationAsset: new Asset("USDC", "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5"),
      });
    } catch {
      // expected
    }

    expect(warningSpy).not.toHaveBeenCalled();
  });
});
