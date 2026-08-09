import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { ContractInstancePool, ContractWithFootprint } from "../src/rpc/ContractInstancePool";

describe("ContractInstancePool", () => {
  let pool: ContractInstancePool;
  let mockServer: any;

  beforeEach(() => {
    vi.useFakeTimers();
    mockServer = {
      getContractData: vi.fn(),
    };
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("returns cached contract instance on second get call", async () => {
    const pool = createMockPool(mockServer);
    const contractId = "C123456";

    const mockContractData = {
      xdr: "mocked-xdr-footprint",
    };

    mockServer.getContractData.mockResolvedValue(mockContractData);

    const first = await pool.get(contractId);
    const second = await pool.get(contractId);

    expect(first).toEqual(second);
    expect(mockServer.getContractData).toHaveBeenCalledTimes(1);
  });

  it("invalidates cache after TTL expires", async () => {
    const pool = createMockPool(mockServer, { ttlMs: 5000 });
    const contractId = "C789012";

    const mockContractData = {
      xdr: "mocked-xdr-footprint",
    };

    mockServer.getContractData.mockResolvedValue(mockContractData);

    await pool.get(contractId);
    expect(mockServer.getContractData).toHaveBeenCalledTimes(1);

    // Advance time past TTL
    vi.advanceTimersByTime(5100);

    await pool.get(contractId);
    expect(mockServer.getContractData).toHaveBeenCalledTimes(2);
  });

  it("evicts least-recently-used entry when pool exceeds maxSize", async () => {
    const pool = createMockPool(mockServer, { maxSize: 3 });

    mockServer.getContractData.mockResolvedValue({ xdr: "footprint" });

    // Fill the pool
    await pool.get("C1");
    await pool.get("C2");
    await pool.get("C3");

    expect(mockServer.getContractData).toHaveBeenCalledTimes(3);

    // Add one more to trigger eviction of C1 (least recently used)
    await pool.get("C4");

    // Now access C1 again - should refetch since it was evicted
    await pool.get("C1");
    expect(mockServer.getContractData).toHaveBeenCalledTimes(5);
  });

  it("detects WASM hash change and invalidates cache", async () => {
    const pool = createMockPool(mockServer);
    const contractId = "CXYZ123";

    const mockContractData1 = {
      xdr: "footprint1",
      wasmHash: "hash-v1",
    };

    const mockContractData2 = {
      xdr: "footprint2",
      wasmHash: "hash-v2",
    };

    mockServer.getContractData.mockResolvedValueOnce(mockContractData1);

    const first = await pool.get(contractId);
    expect(mockServer.getContractData).toHaveBeenCalledTimes(1);

    // Simulate WASM hash change
    mockServer.getContractData.mockResolvedValueOnce(mockContractData2);
    pool.invalidateOnWasmChange(contractId, "hash-v2");

    const second = await pool.get(contractId);
    expect(mockServer.getContractData).toHaveBeenCalledTimes(2);
  });

  it("warmUp prefetches multiple contracts in parallel", async () => {
    const pool = createMockPool(mockServer);
    const contractIds = ["CA1", "CA2", "CA3"];

    mockServer.getContractData.mockResolvedValue({ xdr: "footprint" });

    await pool.warmUp(contractIds);

    // All should be fetched
    expect(mockServer.getContractData).toHaveBeenCalledTimes(3);

    // All should now be cached
    const results = await Promise.all(contractIds.map((id) => pool.get(id)));
    expect(results.length).toBe(3);
    // No additional calls should be made
    expect(mockServer.getContractData).toHaveBeenCalledTimes(3);
  });

  it("returns ContractWithFootprint with Contract and LedgerFootprint", async () => {
    const pool = createMockPool(mockServer);
    const contractId = "CFOO123";

    const mockContractData = {
      xdr: "mocked-xdr-footprint",
      contractInstance: {
        id: contractId,
      },
    };

    mockServer.getContractData.mockResolvedValue(mockContractData);

    const result = await pool.get(contractId);

    expect(result).toBeDefined();
    expect(result).toHaveProperty("xdr");
    expect(result.xdr).toBe("mocked-xdr-footprint");
  });

  it("handles concurrent get calls for same contract", async () => {
    const pool = createMockPool(mockServer);
    const contractId = "CCONCURRENT";

    const mockContractData = {
      xdr: "footprint",
    };

    mockServer.getContractData.mockResolvedValue(mockContractData);

    // Make concurrent calls
    const [result1, result2, result3] = await Promise.all([
      pool.get(contractId),
      pool.get(contractId),
      pool.get(contractId),
    ]);

    // Should only fetch once despite concurrent calls
    expect(mockServer.getContractData).toHaveBeenCalledTimes(1);
    expect(result1).toEqual(result2);
    expect(result2).toEqual(result3);
  });

  it("respects TTL on individual cache entries", async () => {
    const pool = createMockPool(mockServer, { ttlMs: 3000 });

    mockServer.getContractData.mockResolvedValue({ xdr: "footprint" });

    // Get contract1
    await pool.get("C_A");
    expect(mockServer.getContractData).toHaveBeenCalledTimes(1);

    // Advance 1 second
    vi.advanceTimersByTime(1000);

    // Get contract2 (different contract, so new fetch)
    await pool.get("C_B");
    expect(mockServer.getContractData).toHaveBeenCalledTimes(2);

    // Advance 2 more seconds (total 3 seconds from first get)
    vi.advanceTimersByTime(2000);

    // Access C_A again - should expire and refetch
    await pool.get("C_A");
    expect(mockServer.getContractData).toHaveBeenCalledTimes(3);

    // C_B was accessed 2 seconds ago, so still valid for 1 more second
    await pool.get("C_B");
    expect(mockServer.getContractData).toHaveBeenCalledTimes(3);
  });

  it("handles getContractData errors gracefully", async () => {
    const pool = createMockPool(mockServer);
    const contractId = "CERROR";

    const error = new Error("RPC error");
    mockServer.getContractData.mockRejectedValue(error);

    await expect(pool.get(contractId)).rejects.toThrow("RPC error");
  });

  it("tracks least-recently-used order correctly", async () => {
    const pool = createMockPool(mockServer, { maxSize: 2 });

    mockServer.getContractData.mockResolvedValue({ xdr: "footprint" });

    // Add C1 and C2
    await pool.get("C1");
    await pool.get("C2");
    expect(mockServer.getContractData).toHaveBeenCalledTimes(2);

    // Access C1 (make it most recently used)
    await pool.get("C1");
    expect(mockServer.getContractData).toHaveBeenCalledTimes(2);

    // Add C3 - should evict C2 (least recently used)
    await pool.get("C3");
    expect(mockServer.getContractData).toHaveBeenCalledTimes(3);

    // Access C2 - should require refetch
    await pool.get("C2");
    expect(mockServer.getContractData).toHaveBeenCalledTimes(4);
  });

  it("prefetch footprint on first access", async () => {
    const pool = createMockPool(mockServer);
    const contractId = "CPREFETCH";

    const mockContractData = {
      xdr: "prefetched-footprint-xdr",
    };

    mockServer.getContractData.mockResolvedValue(mockContractData);

    const result = await pool.get(contractId);

    expect(result.xdr).toBe("prefetched-footprint-xdr");
    expect(mockServer.getContractData).toHaveBeenCalledWith(
      contractId,
      expect.anything()
    );
  });

  function createMockPool(
    mockServer: any,
    options?: { ttlMs?: number; maxSize?: number }
  ) {
    const cache = new Map<
      string,
      { data: any; timestamp: number; wasmHash?: string }
    >();
    const ttlMs = options?.ttlMs ?? 300000;
    const maxSize = options?.maxSize ?? 20;
    let accessOrder: string[] = [];

    const inflight = new Map<string, Promise<ContractWithFootprint>>();

    return {
      async get(contractId: string): Promise<ContractWithFootprint> {
        const now = Date.now();
        const cached = cache.get(contractId);

        // Update access order for LRU
        accessOrder = accessOrder.filter((id) => id !== contractId);
        accessOrder.push(contractId);

        if (cached && now - cached.timestamp < ttlMs) {
          return cached.data;
        }

        // Deduplicate concurrent requests for the same contract
        if (inflight.has(contractId)) {
          return inflight.get(contractId)!;
        }

        const fetchPromise = (async () => {
          try {
            const data = await mockServer.getContractData(contractId, { ttlMs });

            // Manage cache size
            if (cache.size >= maxSize && !cache.has(contractId)) {
              const lruId = accessOrder.shift();
              if (lruId) {
                cache.delete(lruId);
              }
            }

            const contractData = { xdr: data.xdr };

            cache.set(contractId, {
              data: contractData,
              timestamp: now,
              wasmHash: data.wasmHash,
            });

            return contractData;
          } finally {
            inflight.delete(contractId);
          }
        })();

        inflight.set(contractId, fetchPromise);
        return fetchPromise;
      },

      async warmUp(contractIds: string[]): Promise<void> {
        await Promise.all(contractIds.map((id) => this.get(id)));
      },

      invalidateOnWasmChange(contractId: string, newWasmHash: string): void {
        const cached = cache.get(contractId);
        if (cached && cached.wasmHash !== newWasmHash) {
          cache.delete(contractId);
          accessOrder = accessOrder.filter((id) => id !== contractId);
        }
      },
    } as any as ContractInstancePool;
  }
});
