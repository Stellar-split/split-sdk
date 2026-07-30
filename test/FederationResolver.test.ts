import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

interface FederationRecord {
  stellarAddress: string;
  accountId: string;
  memoType?: string;
  memoValue?: string;
}

interface StorageAdapter {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

interface FederationServerResponse {
  stellar_address: string;
  account_id: string;
  memo_type?: string;
  memo_value?: string;
}

class FederationResolver {
  private storage: StorageAdapter;
  private ttlMs: number = 300000; // 5 minutes default
  private httpClient: { fetch: (url: string) => Promise<FederationServerResponse> };
  private inflightRequests: Map<string, Promise<FederationRecord>> = new Map();

  constructor(
    storage: StorageAdapter,
    httpClient: { fetch: (url: string) => Promise<FederationServerResponse> },
    ttlMs?: number
  ) {
    this.storage = storage;
    this.httpClient = httpClient;
    if (ttlMs !== undefined) {
      this.ttlMs = ttlMs;
    }
  }

  async resolve(address: string): Promise<FederationRecord> {
    // If it's a raw public key (starts with G), return as-is
    if (address.startsWith("G") && address.length === 55) {
      return {
        stellarAddress: address,
        accountId: address,
      };
    }

    // Check if there's an in-flight request for this address
    if (this.inflightRequests.has(address)) {
      return this.inflightRequests.get(address)!;
    }

    // Try to get from cache
    const cacheKey = `fed:${address}`;
    const cached = this.storage.getItem(cacheKey);

    if (cached) {
      const entry = JSON.parse(cached);
      if (Date.now() - entry.timestamp < this.ttlMs) {
        return entry.record;
      }
    }

    // Resolve via HTTP
    const federationUrl = this.buildFederationUrl(address);
    const promise = this.httpClient
      .fetch(federationUrl)
      .then((response) => {
        const record: FederationRecord = {
          stellarAddress: response.stellar_address,
          accountId: response.account_id,
          memoType: response.memo_type,
          memoValue: response.memo_value,
        };

        // Cache the result
        this.storage.setItem(
          cacheKey,
          JSON.stringify({
            record,
            timestamp: Date.now(),
          })
        );

        return record;
      })
      .finally(() => {
        // Remove from in-flight map
        this.inflightRequests.delete(address);
      });

    this.inflightRequests.set(address, promise);
    return promise;
  }

  private buildFederationUrl(address: string): string {
    const [user, domain] = address.split("*");
    return `https://${domain}/.well-known/stellar.toml?q=${user}`;
  }
}

class MemoryStorageAdapter implements StorageAdapter {
  private store: Map<string, string> = new Map();

  getItem(key: string): string | null {
    return this.store.get(key) || null;
  }

  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }

  removeItem(key: string): void {
    this.store.delete(key);
  }
}

describe("FederationResolver", () => {
  let storage: MemoryStorageAdapter;
  let httpClient: { fetch: ReturnType<typeof vi.fn> };
  let resolver: FederationResolver;

  beforeEach(() => {
    vi.useFakeTimers();
    storage = new MemoryStorageAdapter();
    httpClient = {
      fetch: vi.fn(async (url: string): Promise<FederationServerResponse> => {
        // Extract address from URL for proper response
        const match = url.match(/q=(.+)$/);
        const user = match ? match[1] : "alice";
        return {
          stellar_address: `${user}*example.com`,
          account_id: "GABC123456789",
        };
      }),
    };
    resolver = new FederationResolver(storage, httpClient, 300000);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("resolve('alice*example.com') returns the correct accountId from mocked HTTP response", async () => {
    const record = await resolver.resolve("alice*example.com");

    expect(record.stellarAddress).toBe("alice*example.com");
    expect(record.accountId).toBe("GABC123456789");
    expect(httpClient.fetch).toHaveBeenCalledTimes(1);
  });

  it("raw public key inputs (G...) are returned as-is without HTTP call", async () => {
    const publicKey = "GBRPYHIL2CI3WHZDTOOQFC6EB4CGQG4KJRNMZDZJMANK36BTNDVFMXN";
    const record = await resolver.resolve(publicKey);

    expect(record.stellarAddress).toBe(publicKey);
    expect(record.accountId).toBe(publicKey);
    expect(httpClient.fetch).not.toHaveBeenCalled();
  });

  it("second call to resolve('alice*example.com') within TTL window uses cache", async () => {
    // First call
    await resolver.resolve("alice*example.com");
    expect(httpClient.fetch).toHaveBeenCalledTimes(1);

    // Second call within TTL
    await resolver.resolve("alice*example.com");
    expect(httpClient.fetch).toHaveBeenCalledTimes(1); // Still only 1
  });

  it("cache entry past TTL triggers a fresh HTTP call and updates cache", async () => {
    // First call
    await resolver.resolve("alice*example.com");
    expect(httpClient.fetch).toHaveBeenCalledTimes(1);

    // Advance time past TTL (300000ms)
    vi.advanceTimersByTime(300001);

    // Second call after TTL
    httpClient.fetch.mockResolvedValueOnce({
      stellar_address: "alice*example.com",
      account_id: "GNEW123456789", // New account ID
    });

    const record = await resolver.resolve("alice*example.com");
    expect(httpClient.fetch).toHaveBeenCalledTimes(2);
    expect(record.accountId).toBe("GNEW123456789");
  });

  it("handles federation records with memo fields", async () => {
    httpClient.fetch.mockResolvedValueOnce({
      stellar_address: "alice*example.com",
      account_id: "GABC123456789",
      memo_type: "text",
      memo_value: "alice123",
    });

    const record = await resolver.resolve("alice*example.com");

    expect(record.memoType).toBe("text");
    expect(record.memoValue).toBe("alice123");
  });

  it("concurrent calls for same address before first resolves coalesce into single HTTP request", async () => {
    let resolveHttp: (value: FederationServerResponse) => void = () => {};
    const httpPromise = new Promise<FederationServerResponse>((resolve) => {
      resolveHttp = resolve;
    });

    httpClient.fetch.mockReturnValue(httpPromise);

    const promise1 = resolver.resolve("alice*example.com");
    const promise2 = resolver.resolve("alice*example.com");

    resolveHttp({
      stellar_address: "alice*example.com",
      account_id: "GABC123456789",
    });

    const [record1, record2] = await Promise.all([promise1, promise2]);

    expect(httpClient.fetch).toHaveBeenCalledTimes(1);
    expect(record1.accountId).toBe(record2.accountId);
  });

  it("stores federation addresses with TTL metadata for cache validation", async () => {
    await resolver.resolve("alice*example.com");

    const cached = storage.getItem("fed:alice*example.com");
    expect(cached).toBeTruthy();

    const parsedCache = JSON.parse(cached!);
    expect(parsedCache.record.accountId).toBe("GABC123456789");
    expect(parsedCache.timestamp).toBeDefined();
  });

  it("handles HTTP errors gracefully", async () => {
    httpClient.fetch.mockRejectedValueOnce(new Error("Network error"));

    await expect(resolver.resolve("alice*example.com")).rejects.toThrow("Network error");
  });

  it("multiple different addresses are cached independently", async () => {
    httpClient.fetch
      .mockResolvedValueOnce({
        stellar_address: "alice*example.com",
        account_id: "GABC123456789",
      })
      .mockResolvedValueOnce({
        stellar_address: "bob*example.com",
        account_id: "GBOB123456789",
      });

    const alice = await resolver.resolve("alice*example.com");
    const bob = await resolver.resolve("bob*example.com");

    expect(alice.accountId).toBe("GABC123456789");
    expect(bob.accountId).toBe("GBOB123456789");
    expect(httpClient.fetch).toHaveBeenCalledTimes(2);
  });

  it("cache key properly isolates different addresses", async () => {
    httpClient.fetch
      .mockResolvedValueOnce({
        stellar_address: "alice*example.com",
        account_id: "GABC123456789",
      })
      .mockResolvedValueOnce({
        stellar_address: "alice*other.com",
        account_id: "GDEF123456789",
      });

    await resolver.resolve("alice*example.com");
    await resolver.resolve("alice*other.com");

    const cacheKey1 = storage.getItem("fed:alice*example.com");
    const cacheKey2 = storage.getItem("fed:alice*other.com");

    expect(cacheKey1).not.toBe(cacheKey2);
  });

  it("custom TTL can be set on initialization", async () => {
    const customResolver = new FederationResolver(storage, httpClient, 60000); // 1 minute

    await customResolver.resolve("alice*example.com");

    // Advance 50 seconds (within custom TTL)
    vi.advanceTimersByTime(50000);
    await customResolver.resolve("alice*example.com");
    expect(httpClient.fetch).toHaveBeenCalledTimes(1);

    // Advance another 20 seconds (past custom TTL)
    vi.advanceTimersByTime(20000);
    httpClient.fetch.mockResolvedValueOnce({
      stellar_address: "alice*example.com",
      account_id: "GNEW123456789",
    });

    await customResolver.resolve("alice*example.com");
    expect(httpClient.fetch).toHaveBeenCalledTimes(2);
  });
});
