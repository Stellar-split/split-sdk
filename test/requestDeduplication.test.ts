import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  Deduplicator,
  generateIdempotencyKey,
  isKnownKey,
  registerKey,
  clearKeys,
} from "../src/dedup.js";

describe("Deduplicator concurrency", () => {
  it("shares one in-flight call among concurrent callers with the same key", async () => {
    const d = new Deduplicator<number>();
    const fn = vi.fn(async () => 42);
    const results = await Promise.all([
      d.dedupe("k", fn),
      d.dedupe("k", fn),
      d.dedupe("k", fn),
    ]);
    expect(results).toEqual([42, 42, 42]);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("runs distinct keys independently", async () => {
    const d = new Deduplicator<string>();
    const fn = vi.fn(async () => "x");
    await Promise.all([d.dedupe("a", fn), d.dedupe("b", fn)]);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("propagates the same rejection to all concurrent callers", async () => {
    const d = new Deduplicator<number>();
    const fn = vi.fn(async () => { throw new Error("fail"); });
    const [a, b] = await Promise.allSettled([d.dedupe("k", fn), d.dedupe("k", fn)]);
    expect(a.status).toBe("rejected");
    expect(b.status).toBe("rejected");
    expect(fn).toHaveBeenCalledTimes(1);
  });
});

describe("Deduplicator expiry", () => {
  it("expires the entry once the call settles so later calls re-execute", async () => {
    const d = new Deduplicator<number>();
    const fn = vi.fn(async () => 1);
    await d.dedupe("k", fn);
    await d.dedupe("k", fn);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("allows retry after a failed call", async () => {
    const d = new Deduplicator<number>();
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("first"))
      .mockResolvedValueOnce(7);
    await expect(d.dedupe("k", fn)).rejects.toThrow("first");
    await expect(d.dedupe("k", fn)).resolves.toBe(7);
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("keeps the entry while pending and drops it after resolve", async () => {
    const d = new Deduplicator<number>();
    let resolve!: (v: number) => void;
    const fn = vi.fn(() => new Promise<number>((r) => { resolve = r; }));
    const p1 = d.dedupe("k", fn);
    const p2 = d.dedupe("k", fn);
    expect(fn).toHaveBeenCalledTimes(1);
    resolve(5);
    await Promise.all([p1, p2]);
    await d.dedupe("k", async () => 6);
    expect(d.getDedupStats().total).toBe(3);
  });
});

describe("Deduplicator tracking", () => {
  it("reports zero hit rate with no calls", () => {
    const d = new Deduplicator<number>();
    expect(d.cacheHitRate).toBe(0);
    expect(d.getDedupStats()).toEqual({ deduped: 0, total: 0 });
  });

  it("counts hits and misses accurately", async () => {
    const d = new Deduplicator<number>();
    const fn = async () => 1;
    await Promise.all([d.dedupe("a", fn), d.dedupe("a", fn), d.dedupe("a", fn), d.dedupe("b", fn)]);
    expect(d.getDedupStats()).toEqual({ deduped: 2, total: 4 });
    expect(d.cacheHitRate).toBe(0.5);
  });
});

describe("idempotency key edge cases", () => {
  beforeEach(() => clearKeys());
  const base = { invoiceId: "inv", payer: "G1", amount: 100n };

  it("is deterministic and hex sha-256 sized", () => {
    const k = generateIdempotencyKey(base);
    expect(k).toBe(generateIdempotencyKey({ ...base }));
    expect(k).toMatch(/^[0-9a-f]{64}$/);
  });

  it("differs by amount, payer, invoice, and nonce", () => {
    const keys = new Set([
      generateIdempotencyKey(base),
      generateIdempotencyKey({ ...base, amount: 101n }),
      generateIdempotencyKey({ ...base, payer: "G2" }),
      generateIdempotencyKey({ ...base, invoiceId: "inv2" }),
      generateIdempotencyKey({ ...base, nonce: "n1" }),
      generateIdempotencyKey({ ...base, nonce: "" }),
    ]);
    expect(keys.size).toBe(6);
  });

  it("tracks registered keys and clears them", () => {
    const k = generateIdempotencyKey(base);
    expect(isKnownKey(k)).toBe(false);
    registerKey(k);
    registerKey(k);
    expect(isKnownKey(k)).toBe(true);
    clearKeys();
    expect(isKnownKey(k)).toBe(false);
  });
});
