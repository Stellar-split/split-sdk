import { describe, it, expect, vi } from "vitest";
import { OptimisticCache, type RevalidateErrorEvent } from "../src/cache/OptimisticCache.js";
import { SimpleCache } from "../src/cache.js";

describe("OptimisticCache stale-while-revalidate", () => {
  it("returns value immediately and triggers background revalidation when stale", async () => {
    const base = new SimpleCache<string>({ enabled: true, ttlMs: 100 });
    base.set("inv-1", "old");

    const revalidate = vi.fn().mockResolvedValue("fresh");
    const cache = new OptimisticCache<string>({
      base,
      staleWhileRevalidateMs: 50,
      revalidate,
    });

    // Advance time so the entry is within the stale window
    vi.advanceTimersByTime?.(60);

    const value = cache.get("inv-1");
    expect(value).toBe("old");

    // Wait for the background revalidation
    await new Promise((r) => setTimeout(r, 10));
    expect(revalidate).toHaveBeenCalledWith("inv-1");
    expect(base.get("inv-1")).toBe("fresh");
  });

  it("does not trigger revalidation when entry is not yet stale", async () => {
    const base = new SimpleCache<string>({ enabled: true, ttlMs: 1000 });
    base.set("inv-1", "fresh");

    const revalidate = vi.fn().mockResolvedValue(" newer");
    const cache = new OptimisticCache<string>({
      base,
      staleWhileRevalidateMs: 100,
      revalidate,
    });

    const value = cache.get("inv-1");
    expect(value).toBe("fresh");
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("does not trigger revalidation when staleWhileRevalidateMs is 0", () => {
    const base = new SimpleCache<string>({ enabled: true, ttlMs: 100 });
    base.set("inv-1", "old");

    const revalidate = vi.fn().mockResolvedValue("fresh");
    const cache = new OptimisticCache<string>({ base, revalidate });

    const value = cache.get("inv-1");
    expect(value).toBe("old");
    expect(revalidate).not.toHaveBeenCalled();
  });

  it("does not trigger concurrent revalidations for the same key", async () => {
    const base = new SimpleCache<string>({ enabled: true, ttlMs: 100 });
    base.set("inv-1", "old");

    let callCount = 0;
    const revalidate = vi.fn().mockImplementation(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 50));
      return `fresh-${callCount}`;
    });

    const cache = new OptimisticCache<string>({
      base,
      staleWhileRevalidateMs: 50,
      revalidate,
    });

    // Advance into stale window
    vi.advanceTimersByTime?.(60);

    cache.get("inv-1");
    cache.get("inv-1");
    cache.get("inv-1");

    await new Promise((r) => setTimeout(r, 100));
    expect(revalidate).toHaveBeenCalledTimes(1);
  });

  it("emits revalidateError when background refresh fails", async () => {
    const base = new SimpleCache<string>({ enabled: true, ttlMs: 100 });
    base.set("inv-1", "old");

    const revalidate = vi.fn().mockRejectedValue(new Error("network down"));
    const cache = new OptimisticCache<string>({
      base,
      staleWhileRevalidateMs: 50,
      revalidate,
    });

    const errors: RevalidateErrorEvent[] = [];
    cache.onRevalidateError((e) => errors.push(e));

    vi.advanceTimersByTime?.(60);
    cache.get("inv-1");

    await new Promise((r) => setTimeout(r, 10));
    expect(errors).toHaveLength(1);
    expect(errors[0]!.invoiceId).toBe("inv-1");
    expect(errors[0]!.error).toBeInstanceOf(Error);
  });

  it("serves stale value even after background error", async () => {
    const base = new SimpleCache<string>({ enabled: true, ttlMs: 100 });
    base.set("inv-1", "old");

    const revalidate = vi.fn().mockRejectedValue(new Error("boom"));
    const cache = new OptimisticCache<string>({
      base,
      staleWhileRevalidateMs: 50,
      revalidate,
    });

    vi.advanceTimersByTime?.(60);
    const v1 = cache.get("inv-1");
    await new Promise((r) => setTimeout(r, 10));
    const v2 = cache.get("inv-1");

    expect(v1).toBe("old");
    expect(v2).toBe("old");
  });

  it("does not attempt revalidation when no revalidate callback is provided", () => {
    const base = new SimpleCache<string>({ enabled: true, ttlMs: 100 });
    base.set("inv-1", "old");
    const cache = new OptimisticCache<string>({
      base,
      staleWhileRevalidateMs: 50,
    });

    vi.advanceTimersByTime?.(60);
    expect(cache.get("inv-1")).toBe("old");
  });
});
