/**
 * Tests for ChannelAccountManager (#485)
 *
 * Uses fake timers and vi.spyOn on Horizon.Server to avoid real network calls.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Horizon } from "@stellar/stellar-sdk";
import { ChannelAccountManager } from "../src/submission/ChannelAccountManager.js";
import { ChannelExhaustedError } from "../src/errors.js";

// ---------------------------------------------------------------------------
// Test fixtures
// ---------------------------------------------------------------------------

const CH1 = { publicKey: "GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN", secretKey: "SCZANGBA5RLMPI6OSDJNFEFBSLDVJZ3EDXG5AEDLUNAJHPNKFBZUQQ2" };
const CH2 = { publicKey: "GBZXN7PIRZGNMHGA7MUUUF4GWPY5AYPGQS7Z5H4M3I5K6XTLCPUDVKL", secretKey: "SCUNFCNVCM3FSQE4RGJGRQGLS4FJXB7JZFMXSS7NKABPG4XPMXC5555" };
const CH3 = { publicKey: "GDQOE23CFSUMSVQK4Y5JHPPYK73VYCNHZHA7ENKCV37P6SUEO6XQBKPP", secretKey: "SDPQBVTPKPN6AZFXVVOBHMBQCZMWSEL4XOGREC6UFPUZDXURYDSDDFD" };

/** Returns a minimal mock AccountResponse. */
function makeAcct(xlm: number, seq = "100") {
  return {
    sequenceNumber: () => seq,
    balances: [
      { asset_type: "native" as const, balance: xlm.toFixed(7), buying_liabilities: "0", selling_liabilities: "0" },
    ],
  };
}

let loadAccountSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  loadAccountSpy = vi.spyOn(Horizon.Server.prototype, "loadAccount") as ReturnType<typeof vi.spyOn>;
  // Default: all accounts have healthy balances
  loadAccountSpy.mockResolvedValue(makeAcct(10) as any);
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ChannelAccountManager — basic acquire / release", () => {
  it("assigns distinct channel accounts to concurrent acquire calls", async () => {
    const mgr = new ChannelAccountManager({
      accounts: [CH1, CH2, CH3],
      acquireTimeoutMs: 0,
    });

    const [a1, a2, a3] = await Promise.all([
      mgr.acquire(),
      mgr.acquire(),
      mgr.acquire(),
    ]);

    const keys = new Set([
      a1!.account.publicKey,
      a2!.account.publicKey,
      a3!.account.publicKey,
    ]);
    expect(keys.size).toBe(3);

    a1!.release();
    a2!.release();
    a3!.release();
  });

  it("returns the released account to the pool", async () => {
    const mgr = new ChannelAccountManager({ accounts: [CH1], acquireTimeoutMs: 0 });

    const a1 = await mgr.acquire();
    expect(mgr.inUseCount).toBe(1);
    a1.release();
    expect(mgr.inUseCount).toBe(0);
  });

  it("calling release() multiple times is idempotent", async () => {
    const mgr = new ChannelAccountManager({ accounts: [CH1], acquireTimeoutMs: 0 });
    const a = await mgr.acquire();
    a.release();
    expect(() => a.release()).not.toThrow();
    expect(mgr.inUseCount).toBe(0);
  });

  it("freshly released account is immediately available", async () => {
    const mgr = new ChannelAccountManager({ accounts: [CH1], acquireTimeoutMs: 0 });

    const a1 = await mgr.acquire();
    a1.release();

    const a2 = await mgr.acquire();
    expect(a2.account.publicKey).toBe(CH1.publicKey);
    a2.release();
  });
});

describe("ChannelAccountManager — blocking when all channels in use", () => {
  it("a 4th acquire() resolves once one is released", async () => {
    const mgr = new ChannelAccountManager({
      accounts: [CH1, CH2, CH3],
      acquireTimeoutMs: 5_000,
    });

    const [a1, a2, a3] = await Promise.all([
      mgr.acquire(),
      mgr.acquire(),
      mgr.acquire(),
    ]);

    // All three slots are now in use
    expect(mgr.inUseCount).toBe(3);

    // Start a 4th acquire (should block)
    const fourthPromise = mgr.acquire();

    // Release one slot — the 4th should now resolve
    a1!.release();

    const a4 = await fourthPromise;
    expect(a4).toBeDefined();
    expect(a4.account.publicKey).toBe(CH1.publicKey);

    a2!.release();
    a3!.release();
    a4.release();
  });
});

describe("ChannelAccountManager — acquireTimeoutMs", () => {
  it("throws ChannelExhaustedError when timeout elapses with all channels busy", async () => {
    vi.useFakeTimers();

    const mgr = new ChannelAccountManager({
      accounts: [CH1],
      acquireTimeoutMs: 1_000,
    });

    // Occupy the only slot — advance timers to let _refreshBalances complete
    const a1Promise = mgr.acquire();
    await vi.runAllTimersAsync();
    const a1 = await a1Promise;

    // Now start a second acquire (should block and then timeout)
    const acquirePromise = mgr.acquire().catch((e) => e);

    // Advance time past the timeout and flush microtasks
    await vi.advanceTimersByTimeAsync(1_100);

    const error = await acquirePromise;
    expect(error).toBeInstanceOf(ChannelExhaustedError);
    expect((error as ChannelExhaustedError).poolSize).toBe(1);
    expect((error as ChannelExhaustedError).timeoutMs).toBe(1_000);

    a1.release();
    vi.useRealTimers();
  });

  it("does NOT throw if a channel is released before the timeout", async () => {
    vi.useFakeTimers();

    const mgr = new ChannelAccountManager({
      accounts: [CH1],
      acquireTimeoutMs: 2_000,
    });

    // Acquire the only slot
    const a1Promise = mgr.acquire();
    await vi.runAllTimersAsync();
    const a1 = await a1Promise;

    // Start a second acquire
    const acquirePromise = mgr.acquire();

    // Advance a little, then release before timeout fires
    await vi.advanceTimersByTimeAsync(500);
    a1.release();

    const a2 = await acquirePromise;
    expect(a2).toBeDefined();
    a2.release();
    vi.useRealTimers();
  });
});

describe("ChannelAccountManager — low-balance exclusion", () => {
  it("excludes accounts below minBalanceXlm from the pool", async () => {
    // CH1 → 0.5 XLM (below minBalanceXlm=1), CH2 → 10 XLM (healthy)
    loadAccountSpy.mockImplementation(async (addr: string) => {
      if (addr === CH1.publicKey) return makeAcct(0.5) as any;
      return makeAcct(10) as any;
    });

    const mgr = new ChannelAccountManager({
      accounts: [CH1, CH2],
      minBalanceXlm: 1,
      acquireTimeoutMs: 0,
    });

    const a = await mgr.acquire();
    // Should have been assigned CH2, not CH1
    expect(a.account.publicKey).toBe(CH2.publicKey);
    a.release();
  });

  it("getLowBalanceAccounts returns accounts marked as low-balance", async () => {
    loadAccountSpy.mockImplementation(async (addr: string) => {
      if (addr === CH1.publicKey) return makeAcct(0.1) as any;
      return makeAcct(10) as any;
    });

    const mgr = new ChannelAccountManager({
      accounts: [CH1, CH2],
      minBalanceXlm: 1,
    });

    // Trigger a refresh by acquiring
    const a = await mgr.acquire();
    a.release();

    const low = mgr.getLowBalanceAccounts();
    expect(low.map((l) => l.publicKey)).toContain(CH1.publicKey);
    expect(low.map((l) => l.publicKey)).not.toContain(CH2.publicKey);
  });
});

describe("ChannelAccountManager — sequence number", () => {
  it("includes a fresh sequence number in the assignment", async () => {
    loadAccountSpy.mockResolvedValue(makeAcct(10, "42000") as any);

    const mgr = new ChannelAccountManager({ accounts: [CH1] });
    const a = await mgr.acquire();
    expect(a.sequenceNumber).toBe("42000");
    a.release();
  });

  it("falls back to '0' when loadAccount throws during assignment", async () => {
    // First call (refreshBalances) succeeds; second call (assignSlot) fails
    loadAccountSpy
      .mockResolvedValueOnce(makeAcct(10) as any)
      .mockRejectedValueOnce(new Error("timeout"));

    const mgr = new ChannelAccountManager({ accounts: [CH1] });
    const a = await mgr.acquire();
    expect(a.sequenceNumber).toBe("0");
    a.release();
  });
});

describe("ChannelAccountManager — pool stats", () => {
  it("reports poolSize, inUseCount and availableCount correctly", async () => {
    const mgr = new ChannelAccountManager({ accounts: [CH1, CH2, CH3] });

    expect(mgr.poolSize).toBe(3);
    expect(mgr.inUseCount).toBe(0);
    expect(mgr.availableCount).toBe(3);

    const a1 = await mgr.acquire();
    expect(mgr.inUseCount).toBe(1);
    expect(mgr.availableCount).toBe(2);

    a1.release();
    expect(mgr.inUseCount).toBe(0);
    expect(mgr.availableCount).toBe(3);
  });
});

describe("ChannelExhaustedError", () => {
  it("carries poolSize and timeoutMs", () => {
    const err = new ChannelExhaustedError(3, 5000);
    expect(err.code).toBe("CHANNEL_EXHAUSTED");
    expect(err.poolSize).toBe(3);
    expect(err.timeoutMs).toBe(5000);
    expect(err.message).toMatch(/3 channel account/i);
    expect(err.message).toMatch(/5000ms/);
  });
});
