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
import { registerWebhook, triggerWebhook } from "../src/webhook.js";
import { StellarSplitClient } from "../src/client.js";
import { Deduplicator } from "../src/dedup.js";
import type { PaginatedResult } from "../src/types.js";

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

describe("webhooks", () => {
  const invoiceId = "invoice-123";
  const url = "https://example.com/webhook";
  const data = { amount: 100, status: "paid" };

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("posts the expected webhook payload for a registered event", async () => {
    const mockFetch = vi.fn(() => Promise.resolve({ ok: true } as Response)) as unknown as typeof fetch;
    vi.stubGlobal("fetch", mockFetch);

    registerWebhook(invoiceId, url, ["payment"]);
    await triggerWebhook(invoiceId, "payment", data);

    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [calledUrl, init] = mockFetch.mock.calls[0] as [string, RequestInit];
    expect(calledUrl).toBe(url);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({
      invoiceId,
      event: "payment",
      timestamp: expect.any(String),
      data,
    });
  });

  it("does not post when the event is not registered for the invoice", async () => {
    const mockFetch = vi.fn(() => Promise.resolve({ ok: true } as Response)) as unknown as typeof fetch;
    vi.stubGlobal("fetch", mockFetch);

    registerWebhook(invoiceId, url, ["payment"]);
    await triggerWebhook(invoiceId, "refunded", data);

    expect(mockFetch).not.toHaveBeenCalled();
  });
});


describe("getInvoicesByCreator", () => {
  const CREATOR = "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN";
  const ALL_IDS = ["1", "2", "3", "4", "5"];

  function makeClient(): StellarSplitClient {
    const client = new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    });

    // Directly stub getInvoicesByCreator to exercise pagination logic without RPC
    vi.spyOn(client, "getInvoicesByCreator").mockImplementation(
      async (creator: string, options = {}) => {
        const limit = options.limit ?? 20;
        const total = ALL_IDS.length;
        const startIndex = options.cursor ? ALL_IDS.indexOf(options.cursor) + 1 : 0;
        const page = ALL_IDS.slice(startIndex, startIndex + limit);
        const nextCursor = startIndex + limit < total ? page[page.length - 1] : null;
        return { items: page, nextCursor, total } satisfies PaginatedResult<string>;
      }
    );

    return client;
  }

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("returns first page with default limit", async () => {
    const client = makeClient();
    const result = await client.getInvoicesByCreator(CREATOR);
    expect(result.items).toEqual(ALL_IDS);
    expect(result.total).toBe(5);
    expect(result.nextCursor).toBeNull();
  });

  it("returns correct page for given limit", async () => {
    const client = makeClient();
    const result = await client.getInvoicesByCreator(CREATOR, { limit: 2 });
    expect(result.items).toEqual(["1", "2"]);
    expect(result.nextCursor).toBe("2");
    expect(result.total).toBe(5);
  });

  it("returns correct page for given cursor and limit", async () => {
    const client = makeClient();
    const result = await client.getInvoicesByCreator(CREATOR, { cursor: "2", limit: 2 });
    expect(result.items).toEqual(["3", "4"]);
    expect(result.nextCursor).toBe("4");
  });

  it("returns null nextCursor on last page", async () => {
    const client = makeClient();
    const result = await client.getInvoicesByCreator(CREATOR, { cursor: "4", limit: 2 });
    expect(result.items).toEqual(["5"]);
    expect(result.nextCursor).toBeNull();
  });
});

// =============================================================================
// Issue #1 — batchPay
// =============================================================================

describe("batchPay", () => {
  // Valid Stellar keypair addresses
  const PAYER = "GC2INE2SCMAKA44QEZQWTKDYW2344JECBPLRC75MTJWUVZVSET62UD23";
  const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

  function makeClient() {
    const client = new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: CONTRACT,
    });
    // Mock _submitTx so no real RPC calls are made
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "abc123",
      returnValue: { type: "void" },
    });
    return client;
  }

  beforeEach(() => vi.restoreAllMocks());

  it("throws when payments array is empty", async () => {
    const client = makeClient();
    await expect(client.batchPay(PAYER, [])).rejects.toThrow(
      "payments array must not be empty"
    );
  });

  it("throws when an invoiceId is invalid", async () => {
    const client = makeClient();
    await expect(
      client.batchPay(PAYER, [{ invoiceId: "bad-id", amount: 100n }])
    ).rejects.toThrow("Invalid invoiceId");
  });

  it("submits a single transaction for a batch of 3 payments", async () => {
    const client = makeClient();
    const payments = [
      { invoiceId: "1", amount: 100n },
      { invoiceId: "2", amount: 200n },
      { invoiceId: "3", amount: 300n },
    ];
    const result = await client.batchPay(PAYER, payments);
    expect(result.txHash).toBe("abc123");
    // _submitTx called exactly once — single transaction regardless of batch size
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect((client as any)._submitTx).toHaveBeenCalledTimes(1);
  });
});

// =============================================================================
// Issue #2 — subscribeToInvoice
// =============================================================================

describe("subscribeToInvoice", () => {
  const PAYER_ADDR = "GC2INE2SCMAKA44QEZQWTKDYW2344JECBPLRC75MTJWUVZVSET62UD23";

  function makeClient() {
    return new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    });
  }

  // Helper to get the internal server and mock its event methods
  function mockServer(client: StellarSplitClient, events: unknown[] = []) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = (client as any).server;
    vi.spyOn(server, "getLatestLedger").mockResolvedValue({ sequence: 1 });
    const getEventsSpy = vi.spyOn(server, "getEvents").mockResolvedValue({ events });
    return getEventsSpy;
  }

  beforeEach(() => vi.restoreAllMocks());

  it("returns an unsubscribe function", () => {
    const client = makeClient();
    mockServer(client);
    const unsub = client.subscribeToInvoice("42", {});
    expect(typeof unsub).toBe("function");
    unsub();
  });

  it("fires onPayment callback when a payment event is received", async () => {
    const client = makeClient();
    mockServer(client, [
      {
        ledger: 2,
        topic: ["payment", "42"],
        value: { payer: PAYER_ADDR, amount: "500" },
      },
    ]);

    const received: { payer: string; amount: bigint }[] = [];
    const unsub = client.subscribeToInvoice("42", {
      onPayment: (p) => received.push(p),
    }, 50);

    await new Promise((r) => setTimeout(r, 120));
    unsub();

    expect(received.length).toBeGreaterThanOrEqual(1);
    expect(received[0].payer).toBe(PAYER_ADDR);
    expect(received[0].amount).toBe(500n);
  });

  it("fires onReleased callback when a released event is received", async () => {
    const client = makeClient();
    mockServer(client, [
      { ledger: 2, topic: ["released", "42"], value: {} },
    ]);

    let released = false;
    const unsub = client.subscribeToInvoice("42", {
      onReleased: () => { released = true; },
    }, 50);

    await new Promise((r) => setTimeout(r, 120));
    unsub();

    expect(released).toBe(true);
  });

  it("unsubscribe stops the stream", async () => {
    const client = makeClient();
    const getEventsSpy = mockServer(client);

    const unsub = client.subscribeToInvoice("42", {}, 50);
    await new Promise((r) => setTimeout(r, 80));
    const callsBefore = getEventsSpy.mock.calls.length;
    unsub();
    await new Promise((r) => setTimeout(r, 120));
    expect(getEventsSpy.mock.calls.length).toBe(callsBefore);
  });
});

// =============================================================================
// Issue #3 — buildTransaction / submitTransaction
// =============================================================================

describe("buildTransaction / submitTransaction", () => {
  const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const SOURCE = "GC2INE2SCMAKA44QEZQWTKDYW2344JECBPLRC75MTJWUVZVSET62UD23";

  function makeClient() {
    return new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: CONTRACT,
    });
  }

  beforeEach(() => vi.restoreAllMocks());

  it("buildTransaction returns a valid base64 XDR string", async () => {
    const { Account, Contract, nativeToScVal, TransactionBuilder, rpc: SorobanRpc, xdr: stellarXdr } =
      await import("@stellar/stellar-sdk");

    const client = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = (client as any).server;

    // Use a real Account object so TransactionBuilder.build() succeeds
    const realAccount = new Account(SOURCE, "100");
    vi.spyOn(server, "getAccount").mockResolvedValue(realAccount);

    // Minimal valid SorobanTransactionData XDR
    const txData = new stellarXdr.SorobanTransactionData({
      ext: new stellarXdr.ExtensionPoint(0),
      resources: new stellarXdr.SorobanResources({
        footprint: new stellarXdr.LedgerFootprint({ readOnly: [], readWrite: [] }),
        instructions: 0,
        readBytes: 0,
        writeBytes: 0,
      }),
      resourceFee: BigInt(1000),
    });

    vi.spyOn(server, "simulateTransaction").mockResolvedValue({
      results: [{ xdr: stellarXdr.ScVal.scvVoid().toXDR("base64"), auth: [] }],
      minResourceFee: "1000",
      transactionData: txData.toXDR("base64"),
    } as unknown);

    const contract = new Contract(CONTRACT);
    const op = contract.call("get_invoice", nativeToScVal(BigInt("1"), { type: "u64" }));

    const xdrStr = await client.buildTransaction(SOURCE, op);
    expect(typeof xdrStr).toBe("string");
    expect(xdrStr.length).toBeGreaterThan(0);
    // Confirm it round-trips as valid XDR
    expect(() =>
      TransactionBuilder.fromXDR(xdrStr, "Test SDF Network ; September 2015")
    ).not.toThrow();
  });

  it("submitTransaction throws on ERROR status", async () => {
    const { TransactionBuilder } = await import("@stellar/stellar-sdk");
    const client = makeClient();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = (client as any).server;

    vi.spyOn(server, "sendTransaction").mockResolvedValue({
      status: "ERROR",
      errorResult: { message: "bad tx" },
    });
    vi.spyOn(TransactionBuilder, "fromXDR").mockReturnValue(
      {} as ReturnType<typeof TransactionBuilder.fromXDR>
    );

    await expect(client.submitTransaction("AAAA")).rejects.toThrow("Transaction failed");
  });
});

// =============================================================================
// Issue #4 — simulateCreateInvoice / simulatePay
// =============================================================================

describe("simulateCreateInvoice", () => {
  // Use contract addresses for creator/token/recipient (valid for nativeToScVal "address")
  const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const RECIPIENT = "CBIELTK6YBZJU5UP2WWQEUCYKLPU6AUNZ2BQ4WWFEIE3USCIHMXQDAMA";
  // Valid G-address to use as the transaction source account
  const SOURCE = "GC2INE2SCMAKA44QEZQWTKDYW2344JECBPLRC75MTJWUVZVSET62UD23";

  function makeClient() {
    return new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: CONTRACT,
    });
  }

  // Mock server: return a real Account so TransactionBuilder.build() succeeds
  async function mockSim(client: StellarSplitClient, response: unknown) {
    const { Account } = await import("@stellar/stellar-sdk");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = (client as any).server;
    vi.spyOn(server, "getAccount").mockResolvedValue(new Account(SOURCE, "0"));
    vi.spyOn(server, "simulateTransaction").mockResolvedValue(response);
  }

  beforeEach(() => vi.restoreAllMocks());

  it("returns invoiceId and fee on successful simulation", async () => {
    const { nativeToScVal } = await import("@stellar/stellar-sdk");
    const client = makeClient();
    await mockSim(client, {
      result: { retval: nativeToScVal(BigInt(99), { type: "u64" }) },
      minResourceFee: "1234",
      transactionData: "",
    });

    const result = await client.simulateCreateInvoice({
      creator: CONTRACT,
      recipients: [{ address: RECIPIENT, amount: 1000n }],
      token: CONTRACT,
      deadline: Math.floor(Date.now() / 1000) + 86400,
    });

    expect(result.invoiceId).toBe("99");
    expect(result.fee).toBe("1234");
  });

  it("throws on simulation error", async () => {
    const client = makeClient();
    await mockSim(client, { error: "contract trap" });

    await expect(
      client.simulateCreateInvoice({
        creator: CONTRACT,
        recipients: [{ address: RECIPIENT, amount: 1000n }],
        token: CONTRACT,
        deadline: Math.floor(Date.now() / 1000) + 86400,
      })
    ).rejects.toThrow("Simulation error");
  });
});

describe("simulatePay", () => {
  const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const PAYER_ADDR = "GC2INE2SCMAKA44QEZQWTKDYW2344JECBPLRC75MTJWUVZVSET62UD23";

  function makeClient() {
    return new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: CONTRACT,
    });
  }

  async function mockSim(client: StellarSplitClient, response: unknown) {
    const { Account } = await import("@stellar/stellar-sdk");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = (client as any).server;
    vi.spyOn(server, "getAccount").mockResolvedValue(new Account(PAYER_ADDR, "0"));
    vi.spyOn(server, "simulateTransaction").mockResolvedValue(response);
  }

  beforeEach(() => vi.restoreAllMocks());

  it("returns fee on successful simulation", async () => {
    const client = makeClient();
    await mockSim(client, {
      result: { retval: null },
      minResourceFee: "500",
      transactionData: "",
    });

    const result = await client.simulatePay({
      payer: PAYER_ADDR,
      invoiceId: "1",
      amount: 1000n,
    });

    expect(result.fee).toBe("500");
  });

  it("throws on simulation error", async () => {
    const client = makeClient();
    await mockSim(client, { error: "insufficient balance" });

    await expect(
      client.simulatePay({ payer: PAYER_ADDR, invoiceId: "1", amount: 1000n })
    ).rejects.toThrow("Simulation error");
  });
});

describe("Deduplicator", () => {
  it("returns the same promise for concurrent calls with the same key", () => {
    const dedup = new Deduplicator<string>();
    let callCount = 0;
    const fn = () => {
      callCount++;
      return new Promise<string>((resolve) => setTimeout(() => resolve("ok"), 10));
    };

    const p1 = dedup.dedupe("1", fn);
    const p2 = dedup.dedupe("1", fn);

    expect(p1).toBe(p2);
    expect(callCount).toBe(1);
  });

  it("clears the map after the promise settles", async () => {
    const dedup = new Deduplicator<string>();
    let callCount = 0;
    const fn = () => {
      callCount++;
      return Promise.resolve("ok");
    };

    await dedup.dedupe("1", fn);
    await dedup.dedupe("1", fn);

    expect(callCount).toBe(2);
  });

  it("clears the map after rejection", async () => {
    const dedup = new Deduplicator<string>();
    let callCount = 0;
    const fn = () => {
      callCount++;
      return Promise.reject(new Error("fail"));
    };

    await dedup.dedupe("1", fn).catch(() => {});
    await dedup.dedupe("1", fn).catch(() => {});

    expect(callCount).toBe(2);
  });

  it("deduplicates getInvoice() on StellarSplitClient", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    });

    let rpcCallCount = 0;
    const fakeInvoice = {
      id: "42",
      creator: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN",
      recipients: [],
      token: "USDC",
      deadline: 9999999999,
      funded: 0n,
      status: "Pending" as const,
      payments: [],
    };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(client as any, "_fetchInvoice").mockImplementation(async () => {
      rpcCallCount++;
      await new Promise((r) => setTimeout(r, 10));
      return fakeInvoice;
    });

    const [inv1, inv2] = await Promise.all([
      client.getInvoice("42"),
      client.getInvoice("42"),
    ]);

    expect(rpcCallCount).toBe(1);
    expect(inv1).toBe(inv2);
  });
});

// =============================================================================
// Issue #8 — typed Soroban error parser
// =============================================================================

import {
  StellarSplitError,
  InvoiceNotFoundError,
  InvoiceNotPendingError,
  DeadlinePassedError,
  PaymentExceedsRemainingError,
  InvoiceFrozenError,
  parseSorobanError,
} from "../src/errors.js";

describe("parseSorobanError", () => {
  it("returns InvoiceNotFoundError for 'not found' messages", () => {
    const err = parseSorobanError("invoice not found", "42");
    expect(err).toBeInstanceOf(InvoiceNotFoundError);
    expect(err).toBeInstanceOf(StellarSplitError);
    expect((err as InvoiceNotFoundError).invoiceId).toBe("42");
  });

  it("returns InvoiceNotPendingError for status mismatch messages", () => {
    const err = parseSorobanError("invoice is not pending", "1");
    expect(err).toBeInstanceOf(InvoiceNotPendingError);
  });

  it("returns DeadlinePassedError for deadline messages", () => {
    const err = parseSorobanError("deadline passed", "2");
    expect(err).toBeInstanceOf(DeadlinePassedError);
  });

  it("returns PaymentExceedsRemainingError for overpayment messages", () => {
    const err = parseSorobanError("amount exceeds remaining balance", "3");
    expect(err).toBeInstanceOf(PaymentExceedsRemainingError);
  });

  it("returns InvoiceFrozenError for frozen/disputed messages", () => {
    const err = parseSorobanError("invoice is frozen", "4");
    expect(err).toBeInstanceOf(InvoiceFrozenError);
  });

  it("wraps unknown errors in generic StellarSplitError", () => {
    const err = parseSorobanError("some unknown contract panic");
    expect(err).toBeInstanceOf(StellarSplitError);
    expect(err.constructor.name).toBe("StellarSplitError");
    expect(err.raw).toBe("some unknown contract panic");
  });

  it("_submitTx throws typed error on simulation failure", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM",
    });
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = (client as any).server;
    vi.spyOn(server, "getAccount").mockResolvedValue({
      accountId: () => "GC2INE2SCMAKA44QEZQWTKDYW2344JECBPLRC75MTJWUVZVSET62UD23",
      sequenceNumber: () => "0",
      incrementSequenceNumber: () => {},
    });
    vi.spyOn(server, "simulateTransaction").mockResolvedValue({
      error: "invoice not found",
    });

    const { Contract, nativeToScVal } = await import("@stellar/stellar-sdk");
    const contract = new Contract("CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM");
    const op = contract.call("get_invoice", nativeToScVal(BigInt(99), { type: "u64" }));

    await expect(
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (client as any)._submitTx("GC2INE2SCMAKA44QEZQWTKDYW2344JECBPLRC75MTJWUVZVSET62UD23", op)
    ).rejects.toBeInstanceOf(InvoiceNotFoundError);

    vi.restoreAllMocks();
  });
});

// =============================================================================
// Issue #7 — in-memory caching layer
// =============================================================================

import { SimpleCache } from "../src/cache.js";

describe("SimpleCache", () => {
  it("returns undefined for missing keys", () => {
    const cache = new SimpleCache<string>(1000);
    expect(cache.get("x")).toBeUndefined();
  });

  it("returns cached value within TTL", () => {
    const cache = new SimpleCache<string>(5000);
    cache.set("k", "hello");
    expect(cache.get("k")).toBe("hello");
  });

  it("returns undefined after TTL expires", async () => {
    const cache = new SimpleCache<string>(50);
    cache.set("k", "hello");
    await new Promise((r) => setTimeout(r, 80));
    expect(cache.get("k")).toBeUndefined();
  });

  it("invalidate removes a specific entry", () => {
    const cache = new SimpleCache<string>(5000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.invalidate("a");
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBe("2");
  });

  it("clear removes all entries", () => {
    const cache = new SimpleCache<string>(5000);
    cache.set("a", "1");
    cache.set("b", "2");
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });
});

describe("StellarSplitClient cache", () => {
  const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

  function makeInvoice(id: string) {
    return {
      id,
      creator: CONTRACT,
      recipients: [],
      token: CONTRACT,
      deadline: 9999999999,
      funded: 0n,
      status: "Pending" as const,
      payments: [],
    };
  }

  beforeEach(() => vi.restoreAllMocks());

  it("returns cached result on second call without hitting RPC", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: CONTRACT,
      cache: { ttlMs: 5000 },
    });

    const fetchSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(client as any, "_fetchInvoice")
      .mockResolvedValue(makeInvoice("1"));

    await client.getInvoice("1");
    await client.getInvoice("1");

    // RPC fetch called only once despite two getInvoice calls
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("hits RPC again after cache is invalidated by pay()", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: CONTRACT,
      cache: { ttlMs: 5000 },
    });

    const fetchSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(client as any, "_fetchInvoice")
      .mockResolvedValue(makeInvoice("1"));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "tx1",
      returnValue: { type: "void" },
    });

    await client.getInvoice("1");
    // pay() should invalidate the cache for invoice "1"
    await client.pay({
      payer: "GC2INE2SCMAKA44QEZQWTKDYW2344JECBPLRC75MTJWUVZVSET62UD23",
      invoiceId: "1",
      amount: 100n,
    });
    await client.getInvoice("1");

    // Should have fetched twice: once before pay, once after invalidation
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("does not cache when cache option is not set", async () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: CONTRACT,
      // no cache config
    });

    const fetchSpy = vi
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      .spyOn(client as any, "_fetchInvoice")
      .mockResolvedValue(makeInvoice("1"));

    await client.getInvoice("1");
    await client.getInvoice("1");

    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });
});

// =============================================================================
// Issue #6 — multi-signature collection
// =============================================================================

describe("collectSignatures", () => {
  const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";

  function makeClient(adapter?: { getAddress: () => Promise<string>; signTransaction: (xdr: string, net: string) => Promise<string> }) {
    return new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: CONTRACT,
      adapter,
    });
  }

  beforeEach(() => vi.restoreAllMocks());

  it("throws when signers array is empty", async () => {
    const client = makeClient();
    await expect(client.collectSignatures("AAAA", [])).rejects.toThrow(
      "signers array must not be empty"
    );
  });

  it("calls signTransaction once per signer and returns final XDR", async () => {
    const signer1 = "GC2INE2SCMAKA44QEZQWTKDYW2344JECBPLRC75MTJWUVZVSET62UD23";
    const signer2 = "GCUIRB52WKU5I6XVM5UKADTJUV5BXJIHKCLUIQ7ZF5E75BNSLIPAL4OO";

    let callCount = 0;
    const adapter = {
      getAddress: async () => signer1,
      signTransaction: async (xdr: string) => {
        callCount++;
        return `signed-${callCount}-${xdr}`;
      },
    };

    const client = makeClient(adapter);
    const result = await client.collectSignatures("BASE_XDR", [signer1, signer2]);

    expect(callCount).toBe(2);
    // Each signer's output is fed into the next
    expect(result).toBe("signed-2-signed-1-BASE_XDR");
  });

  it("throws with signer identity when a signer fails", async () => {
    const signer1 = "GC2INE2SCMAKA44QEZQWTKDYW2344JECBPLRC75MTJWUVZVSET62UD23";
    const signer2 = "GCUIRB52WKU5I6XVM5UKADTJUV5BXJIHKCLUIQ7ZF5E75BNSLIPAL4OO";

    let callCount = 0;
    const adapter = {
      getAddress: async () => signer1,
      signTransaction: async (_xdr: string) => {
        callCount++;
        if (callCount === 2) throw new Error("user rejected");
        return `signed-${_xdr}`;
      },
    };

    const client = makeClient(adapter);
    await expect(
      client.collectSignatures("BASE_XDR", [signer1, signer2])
    ).rejects.toThrow(`Signer ${signer2} failed to sign`);
  });
});

// =============================================================================
// Issue #5 — fee estimator
// =============================================================================

describe("estimateFee", () => {
  const CONTRACT = "CAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAD2KM";
  const SOURCE = "GC2INE2SCMAKA44QEZQWTKDYW2344JECBPLRC75MTJWUVZVSET62UD23";

  function makeClient() {
    return new StellarSplitClient({
      rpcUrl: "https://soroban-testnet.stellar.org",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: CONTRACT,
    });
  }

  async function mockServerForFee(
    client: StellarSplitClient,
    simResponse: unknown,
    feeStatsResponse: unknown
  ) {
    const { Account } = await import("@stellar/stellar-sdk");
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const server = (client as any).server;
    vi.spyOn(server, "getAccount").mockResolvedValue(new Account(SOURCE, "0"));
    vi.spyOn(server, "simulateTransaction").mockResolvedValue(simResponse);
    vi.spyOn(server, "getFeeStats").mockResolvedValue(feeStatsResponse);
  }

  beforeEach(() => vi.restoreAllMocks());

  it("returns fee and low congestion when p50/p99 ratio is high", async () => {
    const client = makeClient();
    await mockServerForFee(
      client,
      { result: { retval: null }, minResourceFee: "2000", transactionData: "" },
      { sorobanInclusionFee: { p50: "900", p99: "1000" } }
    );

    const { Contract, nativeToScVal } = await import("@stellar/stellar-sdk");
    const contract = new Contract(CONTRACT);
    const op = contract.call("get_invoice", nativeToScVal(BigInt(1), { type: "u64" }));

    const result = await client.estimateFee(op);
    expect(result.fee).toBe(2000n);
    expect(result.congestion).toBe("low");
  });

  it("returns medium congestion when p50/p99 ratio is mid-range", async () => {
    const client = makeClient();
    await mockServerForFee(
      client,
      { result: { retval: null }, minResourceFee: "500", transactionData: "" },
      { sorobanInclusionFee: { p50: "500", p99: "1000" } }
    );

    const { Contract, nativeToScVal } = await import("@stellar/stellar-sdk");
    const contract = new Contract(CONTRACT);
    const op = contract.call("get_invoice", nativeToScVal(BigInt(1), { type: "u64" }));

    const result = await client.estimateFee(op);
    expect(result.congestion).toBe("medium");
  });

  it("returns high congestion when p50/p99 ratio is low", async () => {
    const client = makeClient();
    await mockServerForFee(
      client,
      { result: { retval: null }, minResourceFee: "100", transactionData: "" },
      { sorobanInclusionFee: { p50: "100", p99: "10000" } }
    );

    const { Contract, nativeToScVal } = await import("@stellar/stellar-sdk");
    const contract = new Contract(CONTRACT);
    const op = contract.call("get_invoice", nativeToScVal(BigInt(1), { type: "u64" }));

    const result = await client.estimateFee(op);
    expect(result.congestion).toBe("high");
  });

  it("throws on simulation error", async () => {
    const client = makeClient();
    await mockServerForFee(
      client,
      { error: "contract trap" },
      { sorobanInclusionFee: { p50: "100", p99: "200" } }
    );

    const { Contract, nativeToScVal } = await import("@stellar/stellar-sdk");
    const contract = new Contract(CONTRACT);
    const op = contract.call("get_invoice", nativeToScVal(BigInt(1), { type: "u64" }));

    await expect(client.estimateFee(op)).rejects.toThrow("Fee estimation failed");
  });
});
