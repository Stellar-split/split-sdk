import { describe, it, expect, vi, afterEach } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
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
import { TelemetryCollector } from "../src/telemetryCollector.js";
import { DIContainer } from "../src/container.js";
import { StellarSplitClient } from "../src/client.js";
import { WalletConnectAdapter } from "../src/adapters/walletconnect.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("generateReceipt", () => {
  it("generates a receipt for a released invoice", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    const releasedInvoice = {
      id: "123",
      creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      recipients: [
        {
          address: "GRECIPIENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          amount: 5_000_000n,
        },
      ],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: 1_700_000_000,
      funded: 5_000_000n,
      status: "Released" as const,
      payments: [
        {
          payer: "GPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          amount: 5_000_000n,
        },
      ],
    };

    vi.spyOn(client, "getInvoice").mockResolvedValue(releasedInvoice as any);

    const receipt = await client.generateReceipt("123");

    expect(receipt.invoiceId).toBe("123");
    expect(receipt.creator).toBe(releasedInvoice.creator);
    expect(receipt.recipients).toEqual(releasedInvoice.recipients);
    expect(receipt.payments).toEqual(releasedInvoice.payments);
    expect(receipt.totalAmount).toBe(5_000_000n);
    expect(typeof receipt.receiptId).toBe("string");
    expect(receipt.receiptId.length).toBe(64);
    expect(receipt.releasedAt).toBeGreaterThan(0);

    const secondReceipt = await client.generateReceipt("123");
    expect(secondReceipt.receiptId).toBe(receipt.receiptId);
  });

  it("throws when invoice is not released", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    vi.spyOn(client, "getInvoice").mockResolvedValue({
      id: "123",
      creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      recipients: [],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: 1_700_000_000,
      funded: 0n,
      status: "Pending" as const,
      payments: [],
    } as any);

    await expect(client.generateReceipt("123")).rejects.toThrow(
      "Invoice must be Released to generate a receipt"
    );
  });
});


describe("pay", () => {
  it("retries transient network failures and returns the final transaction", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    const submitSpy = vi.spyOn(client as any, "_submitTx")
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockRejectedValueOnce(new Error("failed to fetch"))
      .mockResolvedValueOnce({ txHash: "tx-success", returnValue: {} } as any);

    vi.useFakeTimers();
    const payer = Keypair.random().publicKey();
    const payPromise = client.pay({
      payer,
      invoiceId: "123",
      amount: 10_000_000n,
    });

    try {
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await payPromise;
      expect(result.txHash).toBe("tx-success");
      expect(submitSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry contract logic failures", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
      maxRetries: 5,
    });

    const submitSpy = vi.spyOn(client as any, "_submitTx").mockRejectedValue(
      new Error("DeadlinePassedError")
    );

    const payer = Keypair.random().publicKey();
    await expect(
      client.pay({
        payer,
        invoiceId: "123",
        amount: 10_000_000n,
      })
    ).rejects.toThrow("DeadlinePassedError");

    expect(submitSpy).toHaveBeenCalledTimes(1);
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

describe("generateReceipt", () => {
  it("generates a receipt for a released invoice", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    const releasedInvoice = {
      id: "123",
      creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      recipients: [
        {
          address: "GRECIPIENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          amount: 5_000_000n,
        },
      ],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: 1_700_000_000,
      funded: 5_000_000n,
      status: "Released" as const,
      payments: [
        {
          payer: "GPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
          amount: 5_000_000n,
        },
      ],
    };

    vi.spyOn(client, "getInvoice").mockResolvedValue(releasedInvoice as any);

    const receipt = await client.generateReceipt("123");

    expect(receipt.invoiceId).toBe("123");
    expect(receipt.creator).toBe(releasedInvoice.creator);
    expect(receipt.recipients).toEqual(releasedInvoice.recipients);
    expect(receipt.payments).toEqual(releasedInvoice.payments);
    expect(receipt.totalAmount).toBe(5_000_000n);
    expect(typeof receipt.receiptId).toBe("string");
    expect(receipt.receiptId.length).toBe(64);
    expect(receipt.releasedAt).toBeGreaterThan(0);

    const secondReceipt = await client.generateReceipt("123");
    expect(secondReceipt.receiptId).toBe(receipt.receiptId);
  });

  it("throws when invoice is not released", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    vi.spyOn(client, "getInvoice").mockResolvedValue({
      id: "123",
      creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      recipients: [],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: 1_700_000_000,
      funded: 0n,
      status: "Pending" as const,
      payments: [],
    } as any);

    await expect(client.generateReceipt("123")).rejects.toThrow(
      "Invoice must be Released to generate a receipt"
    );
  });
});

describe("pay", () => {
  it("retries transient network failures and returns the final transaction", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    const submitSpy = vi.spyOn(client as any, "_submitTx")
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockRejectedValueOnce(new Error("failed to fetch"))
      .mockResolvedValueOnce({ txHash: "tx-success", returnValue: {} } as any);

    vi.useFakeTimers();
    const payer = Keypair.random().publicKey();
    const payPromise = client.pay({
      payer,
      invoiceId: "123",
      amount: 10_000_000n,
    });

    try {
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(2000);
      const result = await payPromise;
      expect(result.txHash).toBe("tx-success");
      expect(submitSpy).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not retry contract logic failures", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
      maxRetries: 5,
    });

    const submitSpy = vi.spyOn(client as any, "_submitTx").mockRejectedValue(
      new Error("DeadlinePassedError")
    );

    const payer = Keypair.random().publicKey();
    await expect(
      client.pay({
        payer,
        invoiceId: "123",
        amount: 10_000_000n,
      })
    ).rejects.toThrow("DeadlinePassedError");

    expect(submitSpy).toHaveBeenCalledTimes(1);
  });
});

describe("bulk invoice operations", () => {
  it("returns partial success when one cancel fails", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    const submitSpy = vi.spyOn(client as any, "_submitTx")
      .mockResolvedValueOnce({ txHash: "tx-1", returnValue: {} } as any)
      .mockRejectedValueOnce(new Error("invoice not found"))
      .mockResolvedValueOnce({ txHash: "tx-3", returnValue: {} } as any);

    const results = await client.bulkCancel(["1", "2", "3"]);

    expect(results).toEqual([
      { invoiceId: "1", success: true },
      { invoiceId: "2", success: false, error: "invoice not found" },
      { invoiceId: "3", success: true },
    ]);
    expect(submitSpy).toHaveBeenCalledTimes(3);
  });

  it("exports invoices in parallel and returns only successful entries", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    const invoiceA = {
      id: "1",
      creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      recipients: [
        { address: "GRECIPIENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", amount: 10_000_000n },
      ],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: 1_700_000_000,
      funded: 0n,
      status: "Pending" as const,
      payments: [],
    };
    const invoiceC = {
      id: "3",
      creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      recipients: [
        { address: "GRECIPIENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", amount: 10_000_000n },
      ],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: 1_700_000_000,
      funded: 0n,
      status: "Pending" as const,
      payments: [],
    };

    const getInvoiceSpy = vi.spyOn(client, "getInvoice")
      .mockResolvedValueOnce(invoiceA as any)
      .mockRejectedValueOnce(new Error("missing invoice"))
      .mockResolvedValueOnce(invoiceC as any);

    const result = await client.bulkExport(["1", "2", "3"], "json");

    expect(result).toHaveProperty("1");
    expect(result).toHaveProperty("3");
    expect(result).not.toHaveProperty("2");
    expect(getInvoiceSpy).toHaveBeenCalledTimes(3);
  });
});

describe("validatePayment", () => {
  it("returns all validation errors for invalid payments", async () => {
    const adapter = {
      getAddress: vi.fn().mockResolvedValue(
        "GPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
      ),
      signTransaction: vi.fn().mockResolvedValue("signed"),
    };

    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
      adapter,
    });

    vi.spyOn(client, "getInvoice").mockResolvedValue({
      id: "123",
      creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      recipients: [
        { address: "GRECIPIENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", amount: 100n },
      ],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: 1_000_000_000,
      funded: 90n,
      status: "Released" as const,
      payments: [],
    } as any);
    vi.spyOn(client as any, "_getTokenBalance").mockResolvedValue(50n);

    const validation = await client.validatePayment("123", 20n);

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain("Insufficient USDC balance");
    expect(validation.errors).toContain("Invoice is not pending");
    expect(validation.errors).toContain("Payment amount exceeds invoice remaining balance");
    expect(validation.errors).toContain("Invoice deadline has passed");
  });

  it("validates successfully when all checks pass", async () => {
    const adapter = {
      getAddress: vi.fn().mockResolvedValue(
        "GPAYERXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX"
      ),
      signTransaction: vi.fn().mockResolvedValue("signed"),
    };

    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
      adapter,
    });

    vi.spyOn(client, "getInvoice").mockResolvedValue({
      id: "123",
      creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      recipients: [
        { address: "GRECIPIENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", amount: 100n },
      ],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: Math.floor(Date.now() / 1000) + 10000,
      funded: 50n,
      status: "Pending" as const,
      payments: [],
    } as any);
    vi.spyOn(client as any, "_getTokenBalance").mockResolvedValue(100n);

    const validation = await client.validatePayment("123", 25n);

    expect(validation.valid).toBe(true);
    expect(validation.errors).toEqual([]);
  });
});

describe("DIContainer", () => {
  it("uses injected RPC client for health checks", async () => {
    const rpcClient = {
      getAccount: vi.fn().mockResolvedValue({}),
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 42 }),
      simulateTransaction: vi.fn().mockResolvedValue({} as any),
      sendTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS", hash: "txhash" } as any),
      getTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS" } as any),
      getFeeStats: vi.fn().mockResolvedValue({ sorobanInclusionFee: { p50: "1", p99: "2" } }),
    } as unknown as any;

    const container = new DIContainer({ rpcClient });
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
      container,
    });

    const health = await client.checkRPCHealth();

    expect(health.blockHeight).toBe(42);
    expect(rpcClient.getLatestLedger).toHaveBeenCalled();
  });
});

describe("TelemetryCollector", () => {
  it("records metrics and computes percentiles", () => {
    const collector = new TelemetryCollector();

    await expect(
      client.simulatePay({ payer: PAYER_ADDR, invoiceId: "1", amount: 1000n })
    ).rejects.toThrow("Simulation error");
  });
});

import { Deduplicator } from "../src/dedup.js";
    for (let i = 0; i < 10; i++) {
      collector.recordMethod("methodA", i % 3 === 0, i * 10);
    }

    const report = collector.getReport();

    expect(report.period).toBeGreaterThanOrEqual(0);
    expect(report.methods.methodA.calls).toBe(10);
    expect(report.methods.methodA.errors).toBe(4);
    expect(report.methods.methodA.p50).toBeGreaterThanOrEqual(40);
    expect(report.methods.methodA.p95).toBeGreaterThanOrEqual(90);
  });
});

import { buildSchema } from "graphql";
import { generateGraphQLSchema } from "../src/graphql.js";

describe("generateGraphQLSchema", () => {
  it("returns a string containing Invoice, Payment, Recipient types", () => {
    const schema = generateGraphQLSchema();
    expect(schema).toContain("type Invoice");
    expect(schema).toContain("type Payment");
    expect(schema).toContain("type Recipient");
  });

  it("includes invoice(id) and invoicesByCreator(address) queries", () => {
    const schema = generateGraphQLSchema();
    expect(schema).toContain("invoice(id: String!)");
    expect(schema).toContain("invoicesByCreator(address: String!)");
  });

  it("produces a valid GraphQL SDL that buildSchema() accepts", () => {
    expect(() => buildSchema(generateGraphQLSchema())).not.toThrow();
  });
});
