/**
 * Tests for Drips Wave issues:
 *  #873 — releasePartial with basis-point validation
 *  #872 — cancelInvoice with pre-payment guard
 *  #871 — bumpInvoiceTtl and getTtl
 *  #870 — getFundingVelocity, computeTrendingScore, isTrending
 */

import { Keypair, StrKey, xdr } from "@stellar/stellar-sdk";
import { StellarSplitClient } from "../src/client.js";

// `scValToNative` is a non-configurable getter on the real SDK namespace, so
// it can't be `vi.spyOn`-ed directly; override it via a partial module mock.
vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    scValToNative: vi.fn(actual.scValToNative),
  };
});
import {
  InvalidBpsError,
  OverReleaseError,
  CannotCancelFundedInvoiceError,
  InvoiceTerminatedError,
} from "../src/errors.js";
import { computeTrendingScore } from "../src/client.js";
import type { VelocityBucket } from "../src/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(): StellarSplitClient {
  return new StellarSplitClient({
    rpcUrl: "https://soroban-testnet.stellar.org",
    networkPassphrase: "Test SDF Network ; September 2015",
    contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    validatePassphrase: false,
  });
}

function makeInvoice(overrides: Partial<{
  id: string;
  creator: string;
  funded: bigint;
  status: "Pending" | "Released" | "Refunded" | "Cancelled";
  totalReleasedBps: number;
}> = {}) {
  return {
    id: overrides.id ?? "42",
    creator: Keypair.random().publicKey(),
    recipients: [],
    token: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    deadline: Math.floor(Date.now() / 1000) + 86_400,
    funded: overrides.funded ?? 0n,
    status: (overrides.status ?? "Pending") as "Pending" | "Released" | "Refunded" | "Cancelled",
    payments: [],
    totalReleasedBps: overrides.totalReleasedBps ?? 0,
  };
}

function makeFakeScVal(value: unknown): xdr.ScVal {
  // Return a placeholder ScVal — the mock bypasses the real decoder anyway.
  return { toXDR: () => Buffer.alloc(0) } as unknown as xdr.ScVal;
}

afterEach(() => {
  vi.restoreAllMocks();
});

// ===========================================================================
// Issue #873 — releasePartial
// ===========================================================================

describe("releasePartial (#873)", () => {
  it("releases a valid bps amount and returns a PartialReleaseResult", async () => {
    const client = makeClient();
    const invoice = makeInvoice({ id: "1", funded: 1_000_000n, status: "Pending" });

    vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue(invoice);
    vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "tx-hash-123",
      returnValue: makeFakeScVal([500_000n, 500_000n, 5_000]),
    });

    // Manually handle scValToNative by overriding the method
    const nativeToScValModule = await import("@stellar/stellar-sdk");
    vi.spyOn(nativeToScValModule, "scValToNative").mockReturnValue([500_000n, 500_000n, 5000]);

    const result = await client.releasePartial("1", 5_000);

    expect(result.txHash).toBe("tx-hash-123");
    expect(result.bps).toBe(5_000);
    expect(result.amountReleased).toBe(500_000n);
    expect(result.remaining).toBe(500_000n);
    expect(result.totalReleasedBps).toBe(5_000);
  });

  it("throws InvalidBpsError when bps is 0", async () => {
    const client = makeClient();
    await expect(client.releasePartial("1", 0)).rejects.toThrow(InvalidBpsError);
  });

  it("throws InvalidBpsError when bps is 10001", async () => {
    const client = makeClient();
    await expect(client.releasePartial("1", 10_001)).rejects.toThrow(InvalidBpsError);
  });

  it("throws InvalidBpsError when bps is negative", async () => {
    const client = makeClient();
    await expect(client.releasePartial("1", -1)).rejects.toThrow(InvalidBpsError);
  });

  it("throws OverReleaseError when bps would exceed 10000 total", async () => {
    const client = makeClient();
    const invoice = makeInvoice({ id: "2", funded: 1_000_000n, totalReleasedBps: 8_000 });

    vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue(invoice);

    // Requesting 3000 more would push total to 11000 (> 10000)
    await expect(client.releasePartial("2", 3_000)).rejects.toThrow(OverReleaseError);
  });

  it("OverReleaseError carries correct context", async () => {
    const client = makeClient();
    const invoice = makeInvoice({ id: "3", funded: 1_000_000n, totalReleasedBps: 9_500 });
    vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue(invoice);

    let err: OverReleaseError | undefined;
    try {
      await client.releasePartial("3", 1_000);
    } catch (e) {
      err = e as OverReleaseError;
    }

    expect(err).toBeInstanceOf(OverReleaseError);
    expect(err!.invoiceId).toBe("3");
    expect(err!.currentTotalBps).toBe(9_500);
    expect(err!.requestedBps).toBe(1_000);
  });

  it("allows exactly 10000 total bps (100%)", async () => {
    const client = makeClient();
    const invoice = makeInvoice({ id: "4", funded: 1_000_000n, totalReleasedBps: 9_000 });
    vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue(invoice);
    vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "tx-full",
      returnValue: makeFakeScVal([1_000_000n, 0n, 10_000]),
    });

    const nativeToScValModule = await import("@stellar/stellar-sdk");
    vi.spyOn(nativeToScValModule, "scValToNative").mockReturnValue([1_000_000n, 0n, 10_000]);

    const result = await client.releasePartial("4", 1_000);
    expect(result.totalReleasedBps).toBe(10_000);
  });
});

// ===========================================================================
// Issue #872 — cancelInvoice
// ===========================================================================

describe("cancelInvoice (#872)", () => {
  it("cancels a zero-payment invoice successfully", async () => {
    const client = makeClient();
    const invoice = makeInvoice({ id: "10", funded: 0n, status: "Pending" });

    vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue(invoice);
    vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "cancel-tx-hash",
      returnValue: makeFakeScVal(null),
    });

    const result = await client.cancelInvoice("10");
    expect(result.txHash).toBe("cancel-tx-hash");
  });

  it("throws CannotCancelFundedInvoiceError before any RPC write for a funded invoice", async () => {
    const client = makeClient();
    const invoice = makeInvoice({ id: "11", funded: 500_000n, status: "Pending" });

    const fetchSpy = vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue(invoice);
    const submitSpy = vi.spyOn(client as any, "_submitTx");

    await expect(client.cancelInvoice("11")).rejects.toThrow(CannotCancelFundedInvoiceError);

    // submitTx must NOT have been called — no RPC write for funded invoices
    expect(submitSpy).not.toHaveBeenCalled();
  });

  it("CannotCancelFundedInvoiceError carries the paidAmount", async () => {
    const client = makeClient();
    const invoice = makeInvoice({ id: "12", funded: 250_000n });
    vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue(invoice);

    let err: CannotCancelFundedInvoiceError | undefined;
    try {
      await client.cancelInvoice("12");
    } catch (e) {
      err = e as CannotCancelFundedInvoiceError;
    }

    expect(err).toBeInstanceOf(CannotCancelFundedInvoiceError);
    expect(err!.paidAmount).toBe(250_000n);
    expect(err!.invoiceId).toBe("12");
    expect(err!.message).toContain("250000");
  });

  it("emits invoice:cancelled event on successful cancellation", async () => {
    const client = makeClient();
    const invoice = makeInvoice({ id: "13", funded: 0n });
    vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue(invoice);
    vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "cancel-event-tx",
      returnValue: makeFakeScVal(null),
    });

    const eventSpy = vi.fn();
    (client as any).on("invoice:cancelled", eventSpy);

    await client.cancelInvoice("13");

    expect(eventSpy).toHaveBeenCalledOnce();
  });
});

// ===========================================================================
// Issue #871 — bumpInvoiceTtl / getTtl
// ===========================================================================

describe("bumpInvoiceTtl (#871)", () => {
  it("bumps TTL for an active invoice", async () => {
    const client = makeClient();
    const invoice = makeInvoice({ id: "20", status: "Pending" });

    vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue(invoice);
    vi.spyOn(client as any, "_submitTx").mockResolvedValue({
      txHash: "bump-ttl-tx",
      returnValue: makeFakeScVal(null),
    });

    const result = await client.bumpInvoiceTtl("20");
    expect(result.txHash).toBe("bump-ttl-tx");
  });

  it("throws InvoiceTerminatedError for a Released invoice", async () => {
    const client = makeClient();
    const invoice = makeInvoice({ id: "21", status: "Released" });
    vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue(invoice);

    await expect(client.bumpInvoiceTtl("21")).rejects.toThrow(InvoiceTerminatedError);
  });

  it("throws InvoiceTerminatedError for a Refunded invoice", async () => {
    const client = makeClient();
    const invoice = makeInvoice({ id: "22", status: "Refunded" });
    vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue(invoice);

    await expect(client.bumpInvoiceTtl("22")).rejects.toThrow(InvoiceTerminatedError);
  });

  it("throws InvoiceTerminatedError for a Cancelled invoice", async () => {
    const client = makeClient();
    const invoice = makeInvoice({ id: "23", status: "Cancelled" });
    vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue(invoice);

    await expect(client.bumpInvoiceTtl("23")).rejects.toThrow(InvoiceTerminatedError);
  });

  it("InvoiceTerminatedError carries correct status", async () => {
    const client = makeClient();
    const invoice = makeInvoice({ id: "24", status: "Released" });
    vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue(invoice);

    let err: InvoiceTerminatedError | undefined;
    try {
      await client.bumpInvoiceTtl("24");
    } catch (e) {
      err = e as InvoiceTerminatedError;
    }
    expect(err!.invoiceId).toBe("24");
    expect(err!.status).toBe("Released");
  });
});

describe("getTtl (#871)", () => {
  it("returns healthy TtlInfo for a ledger count over 30 days", async () => {
    const client = makeClient();
    const LEDGERS_PER_DAY = Math.round((24 * 60 * 60) / 5); // ~17280
    const ttlLedgers = LEDGERS_PER_DAY * 60; // 60 days

    vi.spyOn(client as any, "_simulateView").mockResolvedValue(ttlLedgers);

    const info = await client.getTtl("30");
    expect(info.ttlLedgers).toBe(ttlLedgers);
    expect(info.approximateDays).toBeCloseTo(60, 0);
    expect(info.health).toBe("healthy");
  });

  it("returns warning TtlInfo for a ledger count between 7 and 30 days", async () => {
    const client = makeClient();
    const LEDGERS_PER_DAY = Math.round((24 * 60 * 60) / 5);
    const ttlLedgers = LEDGERS_PER_DAY * 15; // 15 days

    vi.spyOn(client as any, "_simulateView").mockResolvedValue(ttlLedgers);

    const info = await client.getTtl("31");
    expect(info.health).toBe("warning");
  });

  it("returns critical TtlInfo for a ledger count under 7 days", async () => {
    const client = makeClient();
    const LEDGERS_PER_DAY = Math.round((24 * 60 * 60) / 5);
    const ttlLedgers = LEDGERS_PER_DAY * 3; // 3 days

    vi.spyOn(client as any, "_simulateView").mockResolvedValue(ttlLedgers);

    const info = await client.getTtl("32");
    expect(info.health).toBe("critical");
  });

  it("returns critical TtlInfo when TTL is 0 ledgers", async () => {
    const client = makeClient();
    vi.spyOn(client as any, "_simulateView").mockResolvedValue(0);

    const info = await client.getTtl("33");
    expect(info.ttlLedgers).toBe(0);
    expect(info.approximateDays).toBe(0);
    expect(info.health).toBe("critical");
  });
});

// ===========================================================================
// Issue #870 — getFundingVelocity / computeTrendingScore / isTrending
// ===========================================================================

describe("getFundingVelocity (#870)", () => {
  it("returns a 7-day range of VelocityBuckets by default", async () => {
    const client = makeClient();
    const fakeBuckets = Array.from({ length: 168 }, (_, i) => [i, BigInt(i * 1_000)]);
    vi.spyOn(client as any, "_simulateView").mockResolvedValue(fakeBuckets);

    const result = await client.getFundingVelocity("50");

    expect(result).toHaveLength(168);
    expect(result[0].amount).toBe(0n);
    expect(result[167].amount).toBe(167_000n);
    expect(result[0].timestamp).toBeInstanceOf(Date);
  });

  it("respects custom fromHour/toHour/limit options", async () => {
    const client = makeClient();
    const now = Math.floor(Date.now() / 3_600_000);
    const from = now - 48;
    const to = now;
    const fakeBuckets = Array.from({ length: 10 }, (_, i) => [from + i, BigInt(i * 500)]);
    vi.spyOn(client as any, "_simulateView").mockResolvedValue(fakeBuckets);

    const result = await client.getFundingVelocity("51", {
      fromHour: from,
      toHour: to,
      limit: 10,
    });

    expect(result).toHaveLength(10);
  });

  it("handles empty buckets gracefully", async () => {
    const client = makeClient();
    vi.spyOn(client as any, "_simulateView").mockResolvedValue([]);

    const result = await client.getFundingVelocity("52");
    expect(result).toHaveLength(0);
    expect(Array.isArray(result)).toBe(true);
  });
});

describe("computeTrendingScore (#870)", () => {
  it("returns 0 for empty buckets", () => {
    expect(computeTrendingScore([])).toBe(0);
  });

  it("returns 100 when there is recent volume but no historic volume", () => {
    const buckets: VelocityBucket[] = Array.from({ length: 10 }, (_, i) => ({
      hour: i,
      timestamp: new Date(),
      amount: BigInt(i < 8 ? 0 : 1_000_000), // only last 2 buckets have volume
    }));
    // All buckets fit within recent window (<=24), historic = 0
    const recentBuckets: VelocityBucket[] = [
      { hour: 0, timestamp: new Date(), amount: 1_000_000n },
    ];
    expect(computeTrendingScore(recentBuckets)).toBe(100);
  });

  it("returns 0 when recent volume is zero", () => {
    const buckets: VelocityBucket[] = Array.from({ length: 30 }, (_, i) => ({
      hour: i,
      timestamp: new Date(),
      amount: i < 6 ? 1_000_000n : 0n, // last 24 are zero
    }));
    expect(computeTrendingScore(buckets)).toBe(0);
  });

  it("scores above 70 when recent volume is 2x the historic average", () => {
    // Build 48 buckets: first 24 with avg 1000, last 24 with avg 2000
    const buckets: VelocityBucket[] = [
      ...Array.from({ length: 24 }, (_, i) => ({
        hour: i,
        timestamp: new Date(),
        amount: 1_000n,
      })),
      ...Array.from({ length: 24 }, (_, i) => ({
        hour: i + 24,
        timestamp: new Date(),
        amount: 2_000n,
      })),
    ];
    const score = computeTrendingScore(buckets);
    expect(score).toBeGreaterThan(70);
  });
});

describe("isTrending (#870)", () => {
  it("returns true when trending score is above 70", async () => {
    const client = makeClient();
    // Make getFundingVelocity return buckets that yield a score > 70
    const highActivity: VelocityBucket[] = [
      ...Array.from({ length: 24 }, (_, i) => ({
        hour: i,
        timestamp: new Date(),
        amount: 1_000n,
      })),
      ...Array.from({ length: 24 }, (_, i) => ({
        hour: i + 24,
        timestamp: new Date(),
        amount: 2_000n,
      })),
    ];
    vi.spyOn(client, "getFundingVelocity").mockResolvedValue(highActivity);

    expect(await client.isTrending("60")).toBe(true);
  });

  it("returns false when trending score is 70 or below", async () => {
    const client = makeClient();
    // Same activity across all buckets → score ≈ 50
    const flatActivity: VelocityBucket[] = Array.from({ length: 48 }, (_, i) => ({
      hour: i,
      timestamp: new Date(),
      amount: 1_000n,
    }));
    vi.spyOn(client, "getFundingVelocity").mockResolvedValue(flatActivity);

    expect(await client.isTrending("61")).toBe(false);
  });

  it("returns false for empty buckets", async () => {
    const client = makeClient();
    vi.spyOn(client, "getFundingVelocity").mockResolvedValue([]);
    expect(await client.isTrending("62")).toBe(false);
  });
});
