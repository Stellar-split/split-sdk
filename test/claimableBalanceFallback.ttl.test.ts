/**
 * Unit tests for the TTL / pruneExpired() feature added to
 * ClaimableBalanceLifecycle (src/claimableBalanceFallback.ts).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { ClaimableBalanceLifecycle } from "../src/claimableBalanceFallback.js";
import type { ClaimableBalanceRecord } from "../src/types.js";

// ---------------------------------------------------------------------------
// Minimal Horizon.Server stub (we don't test polling here)
// ---------------------------------------------------------------------------
function makeMockServer() {
  return {
    claimableBalances: vi.fn().mockReturnValue({
      claimant: vi.fn().mockReturnValue({
        call: vi.fn().mockResolvedValue({ records: [] }),
      }),
    }),
    loadAccount: vi.fn(),
    submitTransaction: vi.fn(),
    operations: vi.fn(),
  } as unknown as import("@stellar/stellar-sdk").Horizon.Server;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeRecord(id: string): ClaimableBalanceRecord {
  return {
    balanceId: id,
    claimant: "GCLAIMANT000000000000000000000000000000000000000000000000",
    asset: "native",
    amount: "1.0000000",
    status: "created",
    createdAt: Date.now(),
    claimedAt: null,
  };
}

// ---------------------------------------------------------------------------
// TTL configuration
// ---------------------------------------------------------------------------

describe("ClaimableBalanceLifecycle – TTL configuration", () => {
  it("defaults to 24 h (86_400_000 ms)", () => {
    const lifecycle = new ClaimableBalanceLifecycle(makeMockServer());
    expect(lifecycle.defaultTtlMs).toBe(86_400_000);
  });

  it("accepts a custom ttlMs via constructor options", () => {
    const lifecycle = new ClaimableBalanceLifecycle(makeMockServer(), { ttlMs: 5_000 });
    expect(lifecycle.defaultTtlMs).toBe(5_000);
  });
});

// ---------------------------------------------------------------------------
// Creation timestamp and TTL stored per entry
// ---------------------------------------------------------------------------

describe("ClaimableBalanceLifecycle – track() stores timestamp", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("stores the current time as trackedAt when an entry is inserted", () => {
    vi.setSystemTime(1_000_000);
    const lifecycle = new ClaimableBalanceLifecycle(makeMockServer(), { ttlMs: 60_000 });
    lifecycle.track(makeRecord("bal-1"));

    // The entry is visible in listTracked()
    const tracked = lifecycle.listTracked();
    expect(tracked).toHaveLength(1);
    expect(tracked[0]!.balanceId).toBe("bal-1");
    expect(lifecycle.trackedCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// pruneExpired()
// ---------------------------------------------------------------------------

describe("ClaimableBalanceLifecycle – pruneExpired()", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns 0 when no entries have expired", () => {
    vi.setSystemTime(0);
    const lifecycle = new ClaimableBalanceLifecycle(makeMockServer(), { ttlMs: 10_000 });
    lifecycle.track(makeRecord("a"));
    lifecycle.track(makeRecord("b"));

    vi.advanceTimersByTime(5_000); // halfway through TTL
    expect(lifecycle.pruneExpired()).toBe(0);
    expect(lifecycle.trackedCount).toBe(2);
  });

  it("removes entries that have reached or exceeded their TTL", () => {
    vi.setSystemTime(0);
    const lifecycle = new ClaimableBalanceLifecycle(makeMockServer(), { ttlMs: 10_000 });
    lifecycle.track(makeRecord("a"));
    lifecycle.track(makeRecord("b"));

    vi.advanceTimersByTime(10_000); // exactly at TTL boundary
    const removed = lifecycle.pruneExpired();
    expect(removed).toBe(2);
    expect(lifecycle.trackedCount).toBe(0);
  });

  it("only removes entries past TTL, leaving unexpired entries intact", () => {
    vi.setSystemTime(0);
    const lifecycle = new ClaimableBalanceLifecycle(makeMockServer(), { ttlMs: 30_000 });
    lifecycle.track(makeRecord("old")); // inserted at t=0

    vi.advanceTimersByTime(20_000);    // advance to t=20 s

    lifecycle.track(makeRecord("new")); // inserted at t=20 s, TTL expires at t=50 s

    vi.advanceTimersByTime(15_000);    // advance to t=35 s → "old" is at 35 s (> 30 s), "new" is at 15 s

    const removed = lifecycle.pruneExpired();
    expect(removed).toBe(1);
    expect(lifecycle.trackedCount).toBe(1);
    expect(lifecycle.listTracked()[0]!.balanceId).toBe("new");
  });

  it("returns 0 when the map is empty", () => {
    const lifecycle = new ClaimableBalanceLifecycle(makeMockServer());
    expect(lifecycle.pruneExpired()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Auto-prune on insert
// ---------------------------------------------------------------------------

describe("ClaimableBalanceLifecycle – auto-prune before insert", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("prunes stale entries automatically when track() is called", () => {
    vi.setSystemTime(0);
    const lifecycle = new ClaimableBalanceLifecycle(makeMockServer(), { ttlMs: 5_000 });

    // Insert two entries
    lifecycle.track(makeRecord("stale-1"));
    lifecycle.track(makeRecord("stale-2"));
    expect(lifecycle.trackedCount).toBe(2);

    // Advance past TTL
    vi.advanceTimersByTime(6_000);

    // Inserting a new entry should prune the stale ones first
    lifecycle.track(makeRecord("fresh"));
    expect(lifecycle.trackedCount).toBe(1);
    expect(lifecycle.listTracked()[0]!.balanceId).toBe("fresh");
  });

  it("does not prune entries that are still within their TTL", () => {
    vi.setSystemTime(0);
    const lifecycle = new ClaimableBalanceLifecycle(makeMockServer(), { ttlMs: 60_000 });
    lifecycle.track(makeRecord("alive-1"));
    lifecycle.track(makeRecord("alive-2"));

    vi.advanceTimersByTime(30_000);

    lifecycle.track(makeRecord("alive-3"));
    expect(lifecycle.trackedCount).toBe(3);
  });
});

// ---------------------------------------------------------------------------
// Per-entry TTL override
// ---------------------------------------------------------------------------

describe("ClaimableBalanceLifecycle – per-entry TTL override", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("respects a per-entry TTL that is shorter than the manager default", () => {
    vi.setSystemTime(0);
    const lifecycle = new ClaimableBalanceLifecycle(makeMockServer(), { ttlMs: 60_000 });

    lifecycle.track(makeRecord("short"), 5_000); // expires at t=5 s
    lifecycle.track(makeRecord("long"));         // expires at t=60 s

    vi.advanceTimersByTime(10_000);

    const removed = lifecycle.pruneExpired();
    expect(removed).toBe(1);
    expect(lifecycle.listTracked()[0]!.balanceId).toBe("long");
  });

  it("respects a per-entry TTL that is longer than the manager default", () => {
    vi.setSystemTime(0);
    const lifecycle = new ClaimableBalanceLifecycle(makeMockServer(), { ttlMs: 5_000 });

    lifecycle.track(makeRecord("extended"), 60_000); // custom: 60 s
    lifecycle.track(makeRecord("default"));          // default: 5 s

    vi.advanceTimersByTime(10_000);

    const removed = lifecycle.pruneExpired();
    expect(removed).toBe(1);
    expect(lifecycle.listTracked()[0]!.balanceId).toBe("extended");
  });
});
