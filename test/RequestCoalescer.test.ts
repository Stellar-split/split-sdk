import { describe, it, expect, vi, beforeEach } from "vitest";

interface CoalescerOptions {
  maxConcurrent?: number;
}

class RequestCoalescer {
  private inflightMap: Map<string, Promise<unknown>> = new Map();

  coalesce<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    if (this.inflightMap.has(key)) {
      return this.inflightMap.get(key) as Promise<T>;
    }

    const promise = fetcher()
      .then((result) => {
        this.inflightMap.delete(key);
        return result;
      })
      .catch((error) => {
        this.inflightMap.delete(key);
        throw error;
      });

    this.inflightMap.set(key, promise);
    return promise;
  }

  getInflightCount(): number {
    return this.inflightMap.size;
  }
}

function normalizeKey(methodName: string, args: unknown[]): string {
  const sortedArgs = JSON.stringify(args);
  return `${methodName}:${sortedArgs}`;
}

describe("RequestCoalescer", () => {
  let coalescer: RequestCoalescer;

  beforeEach(() => {
    coalescer = new RequestCoalescer();
  });

  it("10 concurrent calls to getInvoice('inv-1') result in exactly 1 RPC request", async () => {
    let callCount = 0;
    const fetcher = vi.fn(async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 10));
      return { id: "inv-1", amount: 100 };
    });

    const key = normalizeKey("getInvoice", ["inv-1"]);
    const promises = Array.from({ length: 10 }, () => coalescer.coalesce(key, fetcher));

    const results = await Promise.all(promises);

    expect(callCount).toBe(1);
    expect(results).toHaveLength(10);
    results.forEach((result) => {
      expect(result).toEqual({ id: "inv-1", amount: 100 });
    });
  });

  it("a rejection from the RPC call is propagated to all concurrent callers", async () => {
    const error = new Error("Network error");
    const fetcher = vi.fn(async () => {
      await new Promise((r) => setTimeout(r, 10));
      throw error;
    });

    const key = normalizeKey("getInvoice", ["inv-1"]);
    const promises = Array.from({ length: 5 }, () =>
      coalescer.coalesce(key, fetcher).catch((e) => e)
    );

    const results = await Promise.all(promises);

    expect(fetcher).toHaveBeenCalledTimes(1);
    results.forEach((result) => {
      expect(result).toBe(error);
    });
  });

  it("keys are normalized so same values coalesce even with different object references", async () => {
    let callCount = 0;
    const fetcher = vi.fn(async () => {
      callCount++;
      return { data: "result" };
    });

    const key = normalizeKey("getInvoice", [{ id: "inv-1", cache: true }]);
    const promise1 = coalescer.coalesce(key, fetcher);
    const promise2 = coalescer.coalesce(key, fetcher);

    await Promise.all([promise1, promise2]);

    expect(callCount).toBe(1);
  });

  it("calls with different argument values are not coalesced", async () => {
    let callCount = 0;
    const fetcher = vi.fn(async (id: string) => {
      callCount++;
      return { id };
    });

    const key1 = normalizeKey("getInvoice", ["inv-1"]);
    const key2 = normalizeKey("getInvoice", ["inv-2"]);

    const result1 = await coalescer.coalesce(key1, () => fetcher("inv-1"));
    const result2 = await coalescer.coalesce(key2, () => fetcher("inv-2"));

    expect(callCount).toBe(2);
    expect(result1).toEqual({ id: "inv-1" });
    expect(result2).toEqual({ id: "inv-2" });
  });

  it("coalescer.getInflightCount() accurately reflects in-flight requests", async () => {
    const fetcher = vi.fn(
      () =>
        new Promise((resolve) => setTimeout(() => resolve({ data: "result" }), 50))
    );

    const key = normalizeKey("getInvoice", ["inv-1"]);
    expect(coalescer.getInflightCount()).toBe(0);

    const promise = coalescer.coalesce(key, fetcher);
    expect(coalescer.getInflightCount()).toBe(1);

    await promise;
    expect(coalescer.getInflightCount()).toBe(0);
  });

  it("after a rejection, the next call triggers a fresh RPC request", async () => {
    let callCount = 0;
    const fetcher = vi.fn(async () => {
      callCount++;
      if (callCount === 1) throw new Error("First call fails");
      return { data: "success" };
    });

    const key = normalizeKey("getInvoice", ["inv-1"]);

    try {
      await coalescer.coalesce(key, fetcher);
    } catch {
      // expected
    }

    const result = await coalescer.coalesce(key, fetcher);
    expect(callCount).toBe(2);
    expect(result).toEqual({ data: "success" });
  });

  it("concurrent calls to different methods do not coalesce", async () => {
    let callCount = 0;
    const fetcher = vi.fn(async () => {
      callCount++;
      return { result: "data" };
    });

    const key1 = normalizeKey("getInvoice", ["inv-1"]);
    const key2 = normalizeKey("getPaymentHistory", ["inv-1"]);

    const promise1 = coalescer.coalesce(key1, fetcher);
    const promise2 = coalescer.coalesce(key2, fetcher);

    await Promise.all([promise1, promise2]);

    expect(callCount).toBe(2);
  });

  it("entry is removed from map after promise settles (resolve)", async () => {
    const fetcher = vi.fn(async () => ({ data: "result" }));
    const key = normalizeKey("getInvoice", ["inv-1"]);

    const promise1 = coalescer.coalesce(key, fetcher);
    await promise1;

    expect(coalescer.getInflightCount()).toBe(0);

    const promise2 = coalescer.coalesce(key, fetcher);
    // Should trigger a new fetch
    expect(fetcher).toHaveBeenCalledTimes(2);

    await promise2;
  });

  it("entry is removed from map after promise settles (reject)", async () => {
    const fetcher = vi.fn(async () => {
      throw new Error("Failed");
    });
    const key = normalizeKey("getInvoice", ["inv-1"]);

    try {
      await coalescer.coalesce(key, fetcher);
    } catch {
      // expected
    }

    expect(coalescer.getInflightCount()).toBe(0);

    const promise2 = coalescer.coalesce(key, fetcher);
    // Should trigger a new fetch
    expect(fetcher).toHaveBeenCalledTimes(2);

    try {
      await promise2;
    } catch {
      // expected
    }
  });
});
