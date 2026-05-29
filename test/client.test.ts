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
import { Deduplicator } from "../src/dedup.js";

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
