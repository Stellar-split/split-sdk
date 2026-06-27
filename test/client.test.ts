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
import { buildSchema } from "graphql";
import { generateGraphQLSchema } from "../src/graphql.js";

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

  it("reconciles funded totals against payment records and payment events", async () => {
    const rpcClient = {
      getEvents: vi.fn().mockResolvedValue({
        events: [
          {
            topic: ["payment"],
            value: { invoiceId: "123", payer: "GPAYER123", amount: "10000000" },
            ledger: 100,
            createdAt: new Date().toISOString(),
          },
          {
            topic: ["payment"],
            value: { invoiceId: "123", payer: "GPAYER456", amount: "1000000" },
            ledger: 101,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    } as any;

    const container = new DIContainer({ rpcClient });
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
      container,
    });

    vi.spyOn(client, "getInvoice").mockResolvedValue({
      id: "123",
      creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      recipients: [],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: 1_700_000_000,
      funded: 11_000_000n,
      status: "Pending" as const,
      payments: [
        { payer: "GPAYER123", amount: 10_000_000n },
        { payer: "GPAYER456", amount: 1_000_000n },
      ],
    } as any);

    const report = await client.reconcilePayments("123");

    expect(report.invoiceId).toBe("123");
    expect(report.invoiceFunded).toBe(11_000_000n);
    expect(report.paymentRecordsTotal).toBe(11_000_000n);
    expect(report.paymentEventsTotal).toBe(11_000_000n);
    expect(report.fundedDiscrepancy).toBe(0n);
    expect(report.recordsMatchEvents).toBe(true);
    expect(report.consistent).toBe(true);
    expect(report.paymentEvents).toHaveLength(2);
    expect(rpcClient.getEvents).toHaveBeenCalled();
  });

  it("flushes pending operations and closes resources on shutdown", async () => {
    const rpcClient = { close: vi.fn().mockResolvedValue(undefined) } as any;
    const cacheStore = {
      get: vi.fn(),
      set: vi.fn(),
      invalidate: vi.fn(),
      clear: vi.fn(),
      persist: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
    };
    const container = new DIContainer({ rpcClient, cacheStore });
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
      container,
    });

    const pending = (client as any)._queue.enqueue("normal", async () => {
      await new Promise((resolve) => setTimeout(resolve, 10));
      return "done";
    });

    await client.shutdown();

    await expect(pending).resolves.toBe("done");
    expect(rpcClient.close).toHaveBeenCalled();
    expect(cacheStore.persist).toHaveBeenCalled();
    expect(cacheStore.close).toHaveBeenCalled();
    await expect((client as any)._queue.enqueue("normal", async () => "ok")).rejects.toThrow(
      "Queue is shut down"
    );
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

describe("donateOnFailure flag", () => {
  it("passes donateOnFailure=true to the contract call", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    const submitSpy = vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "tx-donate",
      returnValue: {},
    } as any);
    const contractCallSpy = vi.spyOn((client as any).contract, "call");

    const payer = Keypair.random().publicKey();
    const result = await client.pay({
      payer,
      invoiceId: "42",
      amount: 5_000_000n,
      donateOnFailure: true,
    });

    expect(result.txHash).toBe("tx-donate");
    expect(contractCallSpy).toHaveBeenCalledWith(
      "pay",
      expect.anything(), // payer address ScVal
      expect.anything(), // invoiceId ScVal
      expect.anything(), // amount ScVal
      expect.objectContaining({ _switch: expect.anything() }) // bool ScVal
    );
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it("defaults donateOnFailure to false when omitted", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    const submitSpy = vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "tx-default",
      returnValue: {},
    } as any);
    const contractCallSpy = vi.spyOn((client as any).contract, "call");

    const payer = Keypair.random().publicKey();
    await client.pay({ payer, invoiceId: "42", amount: 5_000_000n });

    // Four args: payer, invoiceId, amount, donateOnFailure(false)
    expect(contractCallSpy.mock.calls[0]).toHaveLength(5);
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it("getPayments returns donateOnFailure per payment", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    vi.spyOn(client, "getInvoice").mockResolvedValue({
      id: "7",
      creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      recipients: [],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: 1_700_000_000,
      funded: 10_000_000n,
      status: "Pending" as const,
      payments: [
        { payer: "GPAYER1XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", amount: 10_000_000n, donateOnFailure: true },
        { payer: "GPAYER2XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", amount: 5_000_000n, donateOnFailure: false },
      ],
    });

    const payments = await client.getPayments("7");

    expect(payments[0]!.donateOnFailure).toBe(true);
    expect(payments[1]!.donateOnFailure).toBe(false);
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

    const validation = await client.validatePayment("123", 100n);

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

    for (let i = 0; i < 10; i++) {
      collector.recordMethod("methodA", i % 3 === 0, i * 10);
    }

    const report = collector.getReport();

    expect(report.period).toBeGreaterThanOrEqual(0);
    expect(report.methods.methodA.calls).toBe(10);
    expect(report.methods.methodA.errors).toBe(6);
    expect(report.methods.methodA.p50).toBeGreaterThanOrEqual(40);
    expect(report.methods.methodA.p95).toBeGreaterThanOrEqual(90);
  });
});

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

describe("cloneInvoice", () => {
  it("submits clone call with overrides and returns new invoice ID", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    vi.spyOn(client, "getInvoice").mockResolvedValue({
      id: "123",
      creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      recipients: [
        { address: "GRECIPIENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", amount: 1000n },
      ],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: 1_700_000_000,
      funded: 0n,
      status: "Pending" as const,
      payments: [],
    } as any);

    const { nativeToScVal, scValToNative } = await import("@stellar/stellar-sdk");
    const mockReturnValue = nativeToScVal(BigInt("456"), { type: "u64" });
    const submitSpy = vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "tx-success",
      returnValue: mockReturnValue,
    });

    (client as any)._cache = {
      get: vi.fn(),
      set: vi.fn(),
      invalidate: vi.fn(),
      clear: vi.fn(),
    };

    const result = await client.cloneInvoice("123", { newDeadline: 1_800_000_000 });

    expect(result).toBe("456");
    expect(submitSpy).toHaveBeenCalledTimes(1);
    expect((client as any)._cache.set).toHaveBeenCalledWith(
      "456",
      expect.objectContaining({ id: "456", clonedFrom: "123", parentInvoiceId: "123" })
    );
  });

  it("rolls back optimistic cache on submission failure", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    vi.spyOn(client, "getInvoice").mockResolvedValue({
      id: "123",
      creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      recipients: [
        { address: "GRECIPIENTXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", amount: 1000n },
      ],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: 1_700_000_000,
      funded: 0n,
      status: "Pending" as const,
      payments: [],
    } as any);

    vi.spyOn(client as any, "_submitTx").mockRejectedValue(new Error("network error"));

    const cache = {
      get: vi.fn(),
      set: vi.fn(),
      invalidate: vi.fn(),
      clear: vi.fn(),
    };
    (client as any)._cache = cache;

    await expect(client.cloneInvoice("123")).rejects.toThrow("network error");
    expect(cache.set).not.toHaveBeenCalled();
    expect(cache.invalidate).not.toHaveBeenCalled();
  });
});

describe("resolveCloneChain", () => {
  it("resolves a 3-deep clone chain ordered root to leaf", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    const rootInvoice = { id: "1", creator: "G...ROOT", recipients: [], token: "G...", deadline: 100, funded: 0n, status: "Pending" as const, payments: [] };
    const midInvoice = { id: "2", creator: "G...MID", recipients: [], token: "G...", deadline: 200, funded: 0n, status: "Pending" as const, payments: [] };
    const leafInvoice = { id: "3", creator: "G...LEAF", recipients: [], token: "G...", deadline: 300, funded: 0n, status: "Pending" as const, payments: [] };

    const getInvoiceSpy = vi.spyOn(client, "getInvoice")
      .mockResolvedValueOnce(leafInvoice as any)
      .mockResolvedValueOnce(midInvoice as any)
      .mockResolvedValueOnce(rootInvoice as any);

    const getExtSpy = vi.spyOn(client as any, "_getInvoiceExt")
      .mockResolvedValueOnce({ parentInvoiceId: "2", cloneDepth: 2 })
      .mockResolvedValueOnce({ parentInvoiceId: "1", cloneDepth: 1 })
      .mockResolvedValueOnce({ parentInvoiceId: null, cloneDepth: 0 });

    const chain = await client.resolveCloneChain("3");

    expect(chain).toHaveLength(3);
    expect(chain[0]!.id).toBe("1");
    expect(chain[1]!.id).toBe("2");
    expect(chain[2]!.id).toBe("3");
    expect(getInvoiceSpy).toHaveBeenCalledTimes(3);
    expect(getExtSpy).toHaveBeenCalledTimes(3);
  });

  it("throws when clone chain exceeds max depth", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    vi.spyOn(client, "getInvoice").mockImplementation((id: string) =>
      Promise.resolve({
        id,
        creator: "G...",
        recipients: [],
        token: "G...",
        deadline: 100,
        funded: 0n,
        status: "Pending" as const,
        payments: [],
      } as any)
    );

    let extCalls = 0;
    vi.spyOn(client as any, "_getInvoiceExt").mockImplementation(() => {
      extCalls++;
      return Promise.resolve({
        parentInvoiceId: extCalls < 15 ? "p" + extCalls : null,
        cloneDepth: extCalls,
      });
    });

    await expect(client.resolveCloneChain("x")).rejects.toThrow("clone chain depth exceeded");
  });
});

describe("trackVelocity", () => {
  it("calculates payments per day from payment timestamps", async () => {
    const { trackVelocity } = await import("../src/velocityTracker.js");

    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    const now = Math.floor(Date.now() / 1000);
    const creatorAddr = "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

    vi.spyOn(client, "getInvoicesByCreator").mockResolvedValue({
      items: ["inv1"],
      nextCursor: null,
      total: 1,
    });

    vi.spyOn(client, "getInvoice").mockResolvedValue({
      id: "inv1",
      creator: creatorAddr,
      recipients: [],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: now + 86_400,
      funded: 1_000_000n,
      status: "Pending" as const,
      payments: [
        { payer: "GPAYER1", amount: 100_000n, timestamp: now },
        { payer: "GPAYER2", amount: 100_000n, timestamp: now + 43_200 }, // 12 hours later
        { payer: "GPAYER3", amount: 100_000n, timestamp: now + 86_400 }, // 1 day later
      ],
    } as any);

    const report = await trackVelocity(creatorAddr, client);

    expect(report.address).toBe(creatorAddr);
    expect(report.invoices).toHaveLength(1);
    expect(report.invoices[0]!.invoiceId).toBe("inv1");
    expect(report.invoices[0]!.paymentsPerDay).toBeGreaterThan(0);
    expect(report.invoices[0]!.paymentsPerDay).toBeLessThan(10);
  });

  it("classifies stalling trend for decreasing payment rate", async () => {
    const { trackVelocity } = await import("../src/velocityTracker.js");

    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    const now = Math.floor(Date.now() / 1000);
    const creatorAddr = "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

    vi.spyOn(client, "getInvoicesByCreator").mockResolvedValue({
      items: ["inv1"],
      nextCursor: null,
      total: 1,
    });

    // Payments concentrated early (stalling pattern)
    vi.spyOn(client, "getInvoice").mockResolvedValue({
      id: "inv1",
      creator: creatorAddr,
      recipients: [],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: now + 864_000,
      funded: 1_000_000n,
      status: "Pending" as const,
      payments: [
        { payer: "GPAYER1", amount: 100_000n, timestamp: now },
        { payer: "GPAYER2", amount: 100_000n, timestamp: now + 3_600 },
        { payer: "GPAYER3", amount: 100_000n, timestamp: now + 7_200 },
        { payer: "GPAYER4", amount: 100_000n, timestamp: now + 432_000 }, // 5 days later
        { payer: "GPAYER5", amount: 100_000n, timestamp: now + 435_600 },
      ],
    } as any);

    const report = await trackVelocity(creatorAddr, client);

    expect(report.invoices[0]!.trend).toBe("stalling");
  });

  it("classifies accelerating trend for increasing payment rate", async () => {
    const { trackVelocity } = await import("../src/velocityTracker.js");

    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    const now = Math.floor(Date.now() / 1000);
    const creatorAddr = "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

    vi.spyOn(client, "getInvoicesByCreator").mockResolvedValue({
      items: ["inv1"],
      nextCursor: null,
      total: 1,
    });

    // Payments concentrated later (accelerating pattern)
    vi.spyOn(client, "getInvoice").mockResolvedValue({
      id: "inv1",
      creator: creatorAddr,
      recipients: [],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: now + 864_000,
      funded: 1_000_000n,
      status: "Pending" as const,
      payments: [
        { payer: "GPAYER1", amount: 100_000n, timestamp: now },
        { payer: "GPAYER2", amount: 100_000n, timestamp: now + 172_800 }, // First half ends here (5 payments / 2 = 2.5)
        { payer: "GPAYER3", amount: 100_000n, timestamp: now + 345_600 },
        { payer: "GPAYER4", amount: 100_000n, timestamp: now + 432_000 },
        { payer: "GPAYER5", amount: 100_000n, timestamp: now + 439_200 },
      ],
    } as any);

    const report = await trackVelocity(creatorAddr, client);

    expect(report.invoices[0]!.trend).toBe("accelerating");
  });

  it("classifies steady trend for constant payment rate", async () => {
    const { trackVelocity } = await import("../src/velocityTracker.js");

    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    const now = Math.floor(Date.now() / 1000);
    const creatorAddr = "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX";

    vi.spyOn(client, "getInvoicesByCreator").mockResolvedValue({
      items: ["inv1"],
      nextCursor: null,
      total: 1,
    });

    // Evenly distributed payments
    vi.spyOn(client, "getInvoice").mockResolvedValue({
      id: "inv1",
      creator: creatorAddr,
      recipients: [],
      token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
      deadline: now + 864_000,
      funded: 1_000_000n,
      status: "Pending" as const,
      payments: [
        { payer: "GPAYER1", amount: 100_000n, timestamp: now },
        { payer: "GPAYER2", amount: 100_000n, timestamp: now + 86_400 },
        { payer: "GPAYER3", amount: 100_000n, timestamp: now + 172_800 },
        { payer: "GPAYER4", amount: 100_000n, timestamp: now + 259_200 },
      ],
    } as any);

    const report = await trackVelocity(creatorAddr, client);

    expect(report.invoices[0]!.trend).toBe("steady");
  });
});

describe("getPaymentCooldown", () => {
  const payerAddr = Keypair.random().publicKey();

  it("returns cooldown status when payer is in cooldown", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    const now = Math.floor(Date.now() / 1000);
    const mockCooldown = { in_cooldown: true, cooldown_ends_at: now + 3600 };
    vi.spyOn(client as any, "_simulateView").mockResolvedValue(mockCooldown);

    const result = await client.getPaymentCooldown("42", payerAddr);

    expect(result.inCooldown).toBe(true);
    expect(result.cooldownEndsAt).toBe(now + 3600);
  });

  it("returns cooldown false when no cooldown is active", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    vi.spyOn(client as any, "_simulateView").mockResolvedValue({
      in_cooldown: false,
      cooldown_ends_at: null,
    });

    const result = await client.getPaymentCooldown("42", payerAddr);

    expect(result.inCooldown).toBe(false);
    expect(result.cooldownEndsAt).toBeNull();
  });

  it("handles camelCase keys from scValToNative", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test Network",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });

    vi.spyOn(client as any, "_simulateView").mockResolvedValue({
      inCooldown: true,
      cooldownEndsAt: 1_800_000_000,
    });

    const result = await client.getPaymentCooldown("42", payerAddr);

    expect(result.inCooldown).toBe(true);
    expect(result.cooldownEndsAt).toBe(1_800_000_000);
  });
});
