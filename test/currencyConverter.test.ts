import { describe, expect, it, vi, beforeEach } from "vitest";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";

vi.mock("@stellar/stellar-sdk", async () => {
  const actual = await vi.importActual<typeof import("@stellar/stellar-sdk")>("@stellar/stellar-sdk");
  return {
    ...actual,
    Contract: class MockContract {
      constructor(_id: string) {}
      call(..._args: any[]) { return {}; }
    },
    TransactionBuilder: class MockTxBuilder {
      constructor(_source: any, _opts: any) {}
      addOperation(_op: any) { return this; }
      setTimeout(_s: number) { return this; }
      build() { return {}; }
    },
    scValToNative: vi.fn((_val: any) => _val?.value ?? "0"),
    nativeToScVal: vi.fn((...args: any[]) => args[0]),
  };
});

const NETWORK = "Test SDF Network ; September 2015";
const ORACLE = "GORACLE_ADDR";

function mockServer(rate: bigint) {
  return {
    simulateTransaction: vi.fn().mockResolvedValue({
      result: {
        retval: { value: rate.toString() },
      },
    } as unknown as SorobanRpc.Api.SimulateTransactionSuccessResponse),
  } as unknown as SorobanRpc.Server;
}

describe("currencyConverter", () => {
  beforeEach(async () => {
    const mod = await import("../src/currencyConverter.js");
    mod.clearPriceCache();
  });

  it("converts amount using oracle rate", async () => {
    const { convertAmount } = await import("../src/currencyConverter.js");
    const rate = 2_000_000_000_000_000_000n;
    const server = mockServer(rate);

    const result = await convertAmount(
      1000n, "XLM", "USD", ORACLE, server, NETWORK,
    );

    expect(result.original).toBe(1000n);
    expect(result.converted).toBe(2000n);
    expect(result.rate).toBe(rate);
    expect(result.fromToken).toBe("XLM");
    expect(result.toDisplayCurrency).toBe("USD");
  });

  it("caches oracle price lookups within TTL", async () => {
    const { convertAmount } = await import("../src/currencyConverter.js");
    const rate = 1_500_000_000_000_000_000n;
    const server = mockServer(rate);

    await convertAmount(100n, "XLM", "USD", ORACLE, server, NETWORK, 10_000);
    await convertAmount(200n, "XLM", "USD", ORACLE, server, NETWORK, 10_000);

    expect(server.simulateTransaction).toHaveBeenCalledTimes(1);
  });

  it("re-fetches when cache TTL expires", async () => {
    const { convertAmount } = await import("../src/currencyConverter.js");
    const rate = 1_000_000_000_000_000_000n;
    const server = mockServer(rate);

    await convertAmount(100n, "XLM", "USD", ORACLE, server, NETWORK, 0);
    await convertAmount(200n, "XLM", "USD", ORACLE, server, NETWORK, 0);

    expect(server.simulateTransaction).toHaveBeenCalledTimes(2);
  });

  it("handles fractional conversion correctly", async () => {
    const { convertAmount } = await import("../src/currencyConverter.js");
    const rate = 500_000_000_000_000_000n;
    const server = mockServer(rate);

    const result = await convertAmount(1000n, "USDC", "EUR", ORACLE, server, NETWORK);
    expect(result.converted).toBe(500n);
  });

  it("returns bigint zero for zero amount", async () => {
    const { convertAmount } = await import("../src/currencyConverter.js");
    const rate = 2_000_000_000_000_000_000n;
    const server = mockServer(rate);

    const result = await convertAmount(0n, "XLM", "USD", ORACLE, server, NETWORK);
    expect(result.converted).toBe(0n);
  });
});
