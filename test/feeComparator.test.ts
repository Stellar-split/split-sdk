import { describe, expect, it, vi } from "vitest";
import { compareFundingPaths, type FeeComparatorConfig, type CostEstimate } from "../src/feeComparator.js";
import type { Invoice } from "../src/types.js";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";

let mockSimulateFn = vi.fn();

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
    rpc: {
      ...actual.rpc,
      Server: class MockServer {
        simulateTransaction(...args: any[]) {
          return mockSimulateFn(...args);
        }
      },
      Api: actual.rpc.Api,
    },
  };
});

function makeInvoice(overrides: Partial<Invoice> = {}): Invoice {
  return {
    id: "1",
    creator: "GCREATOR",
    recipients: [{ address: "GRECIP", amount: 1000n }],
    token: "USDC_TOKEN",
    deadline: 9999999999,
    funded: 0n,
    status: "Pending",
    payments: [],
    ...overrides,
  };
}

const BASE_CONFIG: FeeComparatorConfig = {
  rpcUrl: "http://localhost:8000",
  networkPassphrase: "Test SDF Network ; September 2015",
  contractId: "CONTRACT_ID",
};

describe("feeComparator", () => {
  it("recommends direct when source token matches invoice token", async () => {
    mockSimulateFn = vi.fn().mockResolvedValue({
      minResourceFee: "500",
      result: { retval: { value: "0" } },
    });

    const invoice = makeInvoice();
    const result = await compareFundingPaths(invoice, "USDC_TOKEN", 1000n, BASE_CONFIG);

    expect(result.recommended).toBe("direct");
    expect(result.direct).not.toBe("unsupported");
    expect(result.swap).toBe("unsupported");
  });

  it("recommends swap when source token differs and DEX is configured", async () => {
    let callIdx = 0;
    mockSimulateFn = vi.fn().mockImplementation(() => {
      callIdx++;
      if (callIdx === 1) {
        return Promise.resolve({
          minResourceFee: "600",
          result: { retval: { value: "0" } },
        });
      }
      // DEX quote returns output amount less than input (slippage of 50)
      return Promise.resolve({
        result: { retval: { value: "950" } },
      });
    });

    const invoice = makeInvoice();
    const config = { ...BASE_CONFIG, dexContractId: "DEX_CONTRACT" };
    const result = await compareFundingPaths(invoice, "XLM_TOKEN", 1000n, config);

    expect(result.recommended).toBe("swap");
    expect(result.direct).toBe("unsupported");
    expect(result.swap).not.toBe("unsupported");
    const swapEstimate = result.swap as CostEstimate;
    expect(swapEstimate.swapSlippage).toBe(50n);
  });

  it("picks cheaper path when direct is cheaper", async () => {
    mockSimulateFn = vi.fn().mockResolvedValue({
      minResourceFee: "200",
      result: { retval: { value: "0" } },
    });

    const invoice = makeInvoice();
    // Source matches invoice token => direct is supported, swap is unsupported (no DEX)
    const result = await compareFundingPaths(invoice, "USDC_TOKEN", 1000n, BASE_CONFIG);

    expect(result.recommended).toBe("direct");
    expect(result.direct).not.toBe("unsupported");
  });

  it("marks both paths unsupported when no DEX configured and tokens differ", async () => {
    const invoice = makeInvoice();
    const result = await compareFundingPaths(invoice, "XLM_TOKEN", 1000n, BASE_CONFIG);

    expect(result.direct).toBe("unsupported");
    expect(result.swap).toBe("unsupported");
    expect(result.recommended).toBe("direct");
  });
});
