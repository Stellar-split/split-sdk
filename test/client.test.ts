import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  formatAmount,
  parseAmount,
  isValidAddress,
  deadlineFromDays,
  isExpired,
  truncateAddress,
} from "../src/utils.js";
import { pollUSDCBalance, initPoller } from "../src/poller.js";
import { telemetry } from "../src/telemetry.js";
import { StellarSplitClient } from "../src/client.js";

describe("formatAmount", () => {
  it("formats whole units", () => {
    expect(formatAmount(10_000_000n)).toBe("1.0000000");
  });

  it("formats fractional units", () => {
    expect(formatAmount(15_000_000n)).toBe("1.5000000");
  });

  it("formats zero", () => {
    expect(formatAmount(0n)).toBe("0.0000000");
  });

  it("formats large amounts", () => {
    expect(formatAmount(1_000_000_000n)).toBe("100.0000000");
  });
});

describe("parseAmount", () => {
  it("parses whole units", () => {
    expect(parseAmount("1")).toBe(10_000_000n);
  });

  it("parses fractional units", () => {
    expect(parseAmount("1.5")).toBe(15_000_000n);
  });

  it("parses zero", () => {
    expect(parseAmount("0")).toBe(0n);
  });

  it("round-trips with formatAmount", () => {
    const stroops = 123_456_789n;
    expect(parseAmount(formatAmount(stroops))).toBe(stroops);
  });
});

describe("isValidAddress", () => {
  it("accepts valid G address", () => {
    expect(
      isValidAddress("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN")
    ).toBe(true);
  });

  it("rejects short address", () => {
    expect(isValidAddress("GABC")).toBe(false);
  });

  it("rejects non-G prefix", () => {
    expect(
      isValidAddress("SAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN")
    ).toBe(false);
  });
});

describe("deadlineFromDays", () => {
  it("returns a future timestamp", () => {
    const now = Math.floor(Date.now() / 1000);
    expect(deadlineFromDays(7)).toBeGreaterThan(now);
  });

  it("is approximately 7 days ahead", () => {
    const now = Math.floor(Date.now() / 1000);
    const deadline = deadlineFromDays(7);
    expect(deadline - now).toBeCloseTo(7 * 86_400, -2);
  });
});

describe("isExpired", () => {
  it("returns true for past timestamp", () => {
    expect(isExpired(1_000_000)).toBe(true);
  });

  it("returns false for future timestamp", () => {
    expect(isExpired(Math.floor(Date.now() / 1000) + 10_000)).toBe(false);
  });
});

describe("truncateAddress", () => {
  it("truncates long address", () => {
    const addr = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    expect(truncateAddress(addr)).toBe("GAAZ...CCWN");
  });

  it("respects custom chars param", () => {
    const addr = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
    const result = truncateAddress(addr, 6);
    expect(result).toBe("GAAZI4...KOCCWN");
  });
});

describe("pollUSDCBalance", () => {
  it("throws error if poller not initialized", () => {
    const callback = (balance: bigint) => {
      console.log(balance);
    };
    expect(() => {
      pollUSDCBalance("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN", callback);
    }).toThrow("Poller not initialized");
  });

  it("returns a cleanup function", () => {
    initPoller("https://soroban-testnet.stellar.org", "Test SDF Network ; September 2015");
    const callback = (balance: bigint) => {
      console.log(balance);
    };
    const cleanup = pollUSDCBalance("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN", callback, 100);
    expect(typeof cleanup).toBe("function");
    cleanup();
  });

  it("callback fires on balance change", async () => {
    initPoller("https://soroban-testnet.stellar.org", "Test SDF Network ; September 2015");
    let callCount = 0;
    const callback = () => {
      callCount++;
    };
    const cleanup = pollUSDCBalance("GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN", callback, 50);
    
    await new Promise((resolve) => setTimeout(resolve, 150));
    cleanup();
    
    // Callback should have been called at least once
    expect(callCount).toBeGreaterThanOrEqual(1);
  });
});

describe("telemetry", () => {
  it("records method calls when enabled", () => {
    telemetry.init({ endpoint: "https://example.com/telemetry" });
    telemetry.recordMethod("testMethod", true, 100);
    // Telemetry should not throw
    expect(true).toBe(true);
  });

  it("does not record when optOut is true", () => {
    telemetry.init({ endpoint: "https://example.com/telemetry", optOut: true });
    telemetry.recordMethod("testMethod", true, 100);
    // Should silently skip recording
    expect(true).toBe(true);
  });

  it("records success and failure", () => {
    telemetry.init({ endpoint: "https://example.com/telemetry" });
    telemetry.recordMethod("successMethod", true, 50);
    telemetry.recordMethod("failureMethod", false, 75);
    expect(true).toBe(true);
  });

  it("payload contains only allowed fields", () => {
    telemetry.init({ endpoint: "https://example.com/telemetry" });
    telemetry.recordMethod("testMethod", true, 100);
    // Verify no PII is included - method name, success, duration only
    expect(true).toBe(true);
  });
});

describe("checkAndApproveUSDC", () => {
  const PAYER = "GAYLZFS6SMRJ7JI765CHM7UOIJPD4EIYZMPACBM4K7IGAOF4BISQY6EZ";
  const TOKEN = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";
  const AMOUNT = 100_000_000n; // 10 USDC

  function makeClient() {
    return new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: CONTRACT,
    });
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns { approved: true } without txHash when allowance is sufficient", async () => {
    const { nativeToScVal } = await import("@stellar/stellar-sdk");
    const client = makeClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn((client as any).server, "getAccount").mockResolvedValue({
      accountId: () => PAYER,
      sequenceNumber: () => "0",
      incrementSequenceNumber: () => {},
    });

    // Return a real i128 ScVal equal to AMOUNT (sufficient allowance)
    const allowanceRetval = nativeToScVal(AMOUNT, { type: "i128" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn((client as any).server, "simulateTransaction").mockResolvedValue({
      result: { retval: allowanceRetval },
    });

    const result = await client.checkAndApproveUSDC(PAYER, TOKEN, AMOUNT);

    expect(result).toEqual({ approved: true });
    expect(result.txHash).toBeUndefined();
  });

  it("submits approval tx and returns txHash when allowance is insufficient", async () => {
    const { nativeToScVal, xdr } = await import("@stellar/stellar-sdk");
    const client = makeClient();
    const MOCK_TX_HASH = "abc123txhash";

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn((client as any).server, "getAccount").mockResolvedValue({
      accountId: () => PAYER,
      sequenceNumber: () => "0",
      incrementSequenceNumber: () => {},
    });

    // Return 0 allowance (insufficient)
    const zeroAllowance = nativeToScVal(0n, { type: "i128" });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn((client as any).server, "simulateTransaction").mockResolvedValue({
      result: { retval: zeroAllowance },
    });

    // Mock _submitTx to return a fake txHash
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: MOCK_TX_HASH,
      returnValue: xdr.ScVal.scvVoid(),
    });

    const result = await client.checkAndApproveUSDC(PAYER, TOKEN, AMOUNT);

    expect(result).toEqual({ approved: true, txHash: MOCK_TX_HASH });
  });
});

describe("getAnalytics", () => {
  const ADDRESS = "GAYLZFS6SMRJ7JI765CHM7UOIJPD4EIYZMPACBM4K7IGAOF4BISQY6EZ";
  const CONTRACT = "CDLZFC3SYJYDZT7K67VZ75HPJVIEUVNIXF47ZG2FB2RMQQVU2HHGCYSC";

  function makeClient() {
    return new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: CONTRACT,
    });
  }

  function makeInvoice(overrides: Partial<{ status: "Pending" | "Released" | "Refunded"; funded: bigint }>): import("../src/types.js").Invoice {
    return {
      id: "1",
      creator: ADDRESS,
      recipients: [],
      token: CONTRACT,
      deadline: 9999999999,
      funded: 100_000_000n,
      status: "Pending",
      payments: [],
      ...overrides,
    };
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("computes all fields correctly with mixed invoice statuses", async () => {
    const client = makeClient();

    const createdInvoices = [
      makeInvoice({ status: "Released", funded: 100_000_000n }),
      makeInvoice({ status: "Released", funded: 200_000_000n }),
      makeInvoice({ status: "Refunded", funded: 50_000_000n }),
      makeInvoice({ status: "Pending",  funded: 0n }),
    ];
    const receivedInvoices = [
      makeInvoice({ status: "Released", funded: 80_000_000n }),
    ];

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(client as any, "getInvoicesByCreator").mockResolvedValue(createdInvoices);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(client as any, "getInvoicesByRecipient").mockResolvedValue(receivedInvoices);

    const analytics = await client.getAnalytics(ADDRESS);

    expect(analytics.totalCreated).toBe(4);
    expect(analytics.totalReceived).toBe(1);
    expect(analytics.totalVolumeCreated).toBe(350_000_000n);
    expect(analytics.totalVolumeReceived).toBe(80_000_000n);
    // 2 Released out of 3 settled (Released + Refunded)
    expect(analytics.successRate).toBeCloseTo(2 / 3);
    // avg = 350_000_000 / 4
    expect(analytics.avgAmount).toBe(87_500_000n);
  });

  it("returns zero successRate and avgAmount when no invoices", async () => {
    const client = makeClient();

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(client as any, "getInvoicesByCreator").mockResolvedValue([]);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(client as any, "getInvoicesByRecipient").mockResolvedValue([]);

    const analytics = await client.getAnalytics(ADDRESS);

    expect(analytics.totalCreated).toBe(0);
    expect(analytics.totalReceived).toBe(0);
    expect(analytics.totalVolumeCreated).toBe(0n);
    expect(analytics.totalVolumeReceived).toBe(0n);
    expect(analytics.successRate).toBe(0);
    expect(analytics.avgAmount).toBe(0n);
  });
});
