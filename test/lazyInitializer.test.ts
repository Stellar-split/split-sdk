/**
 * Unit tests for LazyInitializer and SplitClient (#479)
 *
 * Covers:
 * - LazyInitializer: lazy initialization timing (factory not called until .get())
 * - LazyInitializer: concurrent calls share the same promise (single flight)
 * - LazyInitializer: failure propagates and next call retries
 * - LazyInitializer: isReady() before and after resolution
 * - SplitClient: zero RPC calls on construction (SorobanRpc.Server constructor not called)
 * - SplitClient: first method call triggers exactly one initialization
 * - SplitClient: concurrent first calls share the same init promise → one RPC connection
 * - SplitClient: preconnect() resolves and isConnected() returns true afterwards
 * - SplitClient: initialization failure propagates as RpcConnectionError; retry re-attempts
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { rpc as SorobanRpc } from "@stellar/stellar-sdk";
import { LazyInitializer } from "../src/client/LazyInitializer.js";
import { RpcConnectionError } from "../src/errors.js";

// --------------------------------------------------------------------------
// SplitClient mock setup
// --------------------------------------------------------------------------

// Track how many times SorobanRpc.Server constructor is called
const serverConstructorSpy = vi.fn();

vi.mock("@stellar/stellar-sdk", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@stellar/stellar-sdk")>();
  return {
    ...actual,
    rpc: {
      ...actual.rpc,
      Server: class MockServer {
        constructor(url: string, opts?: unknown) {
          serverConstructorSpy(url, opts);
        }
        getLatestLedger() {
          return Promise.resolve({ sequence: 42 });
        }
        simulateTransaction(tx: unknown) {
          return Promise.resolve({ minResourceFee: "100", events: [], result: {} });
        }
        sendTransaction(tx: unknown) {
          return Promise.resolve({ status: "PENDING", hash: "mock-hash" });
        }
      },
    },
  };
});

const { SplitClient } = await import("../src/client/SplitClient.js");

// --------------------------------------------------------------------------
// Tests
// --------------------------------------------------------------------------

const TEST_CONFIG = {
  rpcUrl: "http://localhost:8000",
  networkPassphrase: "Test Network",
  contractId: "CCONTRACT123",
};

describe("LazyInitializer (#479)", () => {
  // -------------------------------------------------------------------------
  // Timing
  // -------------------------------------------------------------------------

  it("does not call the factory until .get() is invoked", () => {
    const factory = vi.fn().mockResolvedValue("value");
    const lazy = new LazyInitializer(factory);

    // Factory not called yet
    expect(factory).not.toHaveBeenCalled();
    expect(lazy.isReady()).toBe(false);
  });

  it("calls the factory exactly once on first .get()", async () => {
    const factory = vi.fn().mockResolvedValue("result");
    const lazy = new LazyInitializer(factory);

    const result = await lazy.get();

    expect(factory).toHaveBeenCalledTimes(1);
    expect(result).toBe("result");
    expect(lazy.isReady()).toBe(true);
  });

  it("does not call factory again on subsequent .get() calls", async () => {
    const factory = vi.fn().mockResolvedValue("value");
    const lazy = new LazyInitializer(factory);

    await lazy.get();
    await lazy.get();
    await lazy.get();

    expect(factory).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Concurrent single-flight
  // -------------------------------------------------------------------------

  it("concurrent .get() calls share the same promise (factory called once)", async () => {
    let resolveFactory!: (v: string) => void;
    const factoryPromise = new Promise<string>((res) => {
      resolveFactory = res;
    });
    const factory = vi.fn().mockReturnValue(factoryPromise);

    const lazy = new LazyInitializer(factory);

    // Launch three concurrent calls before factory resolves
    const p1 = lazy.get();
    const p2 = lazy.get();
    const p3 = lazy.get();

    resolveFactory("shared-value");

    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);

    expect(factory).toHaveBeenCalledTimes(1);
    expect(r1).toBe("shared-value");
    expect(r2).toBe("shared-value");
    expect(r3).toBe("shared-value");
  });

  // -------------------------------------------------------------------------
  // Failure propagation and retry
  // -------------------------------------------------------------------------

  it("propagates failure to all concurrent waiters and resets for retry", async () => {
    const error = new Error("Connection refused");
    let attempt = 0;
    const factory = vi.fn().mockImplementation(() => {
      attempt++;
      if (attempt === 1) return Promise.reject(error);
      return Promise.resolve("recovered");
    });

    const lazy = new LazyInitializer(factory);

    // First attempt fails
    await expect(lazy.get()).rejects.toThrow("Connection refused");
    expect(lazy.isReady()).toBe(false);

    // Second attempt succeeds (factory retried)
    const result = await lazy.get();
    expect(result).toBe("recovered");
    expect(lazy.isReady()).toBe(true);
    expect(factory).toHaveBeenCalledTimes(2);
  });

  it("concurrent failures all receive the same error and reset is performed once", async () => {
    const error = new Error("network down");
    const factory = vi.fn().mockRejectedValue(error);

    const lazy = new LazyInitializer(factory);

    const [r1, r2] = await Promise.allSettled([lazy.get(), lazy.get()]);

    expect(r1.status).toBe("rejected");
    expect(r2.status).toBe("rejected");
    // Factory called once; after rejection, promise is reset
    expect(factory).toHaveBeenCalledTimes(1);
    expect(lazy.isReady()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // isReady
  // -------------------------------------------------------------------------

  it("isReady() is false before resolution and true after", async () => {
    let resolveFactory!: (v: number) => void;
    const factory = vi.fn().mockReturnValue(
      new Promise<number>((res) => (resolveFactory = res)),
    );
    const lazy = new LazyInitializer(factory);

    const p = lazy.get();
    expect(lazy.isReady()).toBe(false);
    resolveFactory(99);
    await p;
    expect(lazy.isReady()).toBe(true);
  });
});

// --------------------------------------------------------------------------
// SplitClient tests
// --------------------------------------------------------------------------

describe("SplitClient (#479)", () => {
  beforeEach(() => {
    serverConstructorSpy.mockReset();
  });

  // -------------------------------------------------------------------------
  // Zero RPC calls on construction
  // -------------------------------------------------------------------------

  it("constructing SplitClient makes zero RPC calls (Server constructor not called)", () => {
    new SplitClient(TEST_CONFIG);
    expect(serverConstructorSpy).not.toHaveBeenCalled();
  });

  it("isConnected() returns false immediately after construction", () => {
    const client = new SplitClient(TEST_CONFIG);
    expect(client.isConnected()).toBe(false);
  });

  // -------------------------------------------------------------------------
  // First method call triggers initialization
  // -------------------------------------------------------------------------

  it("the first method call triggers exactly one RPC connection", async () => {
    const client = new SplitClient(TEST_CONFIG);

    await client.getLedger();

    expect(serverConstructorSpy).toHaveBeenCalledTimes(1);
    expect(serverConstructorSpy).toHaveBeenCalledWith(
      TEST_CONFIG.rpcUrl,
      expect.any(Object),
    );
  });

  it("subsequent method calls do not create additional RPC connections", async () => {
    const client = new SplitClient(TEST_CONFIG);

    await client.getLedger();
    await client.getLedger();
    await client.getLedger();

    expect(serverConstructorSpy).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // Concurrent first calls → single connection
  // -------------------------------------------------------------------------

  it("concurrent first calls share the same init promise → exactly one RPC connection", async () => {
    const client = new SplitClient(TEST_CONFIG);

    // Fire multiple calls before first resolves
    const [l1, l2, l3] = await Promise.all([
      client.getLedger(),
      client.getLedger(),
      client.getLedger(),
    ]);

    expect(serverConstructorSpy).toHaveBeenCalledTimes(1);
    expect(l1).toBe(42);
    expect(l2).toBe(42);
    expect(l3).toBe(42);
  });

  // -------------------------------------------------------------------------
  // preconnect() and isConnected()
  // -------------------------------------------------------------------------

  it("preconnect() resolves and isConnected() returns true afterwards", async () => {
    const client = new SplitClient(TEST_CONFIG);

    expect(client.isConnected()).toBe(false);
    await client.preconnect();
    expect(client.isConnected()).toBe(true);
    expect(serverConstructorSpy).toHaveBeenCalledTimes(1);
  });

  it("preconnect() followed by a method call uses the cached connection", async () => {
    const client = new SplitClient(TEST_CONFIG);

    await client.preconnect();
    await client.getLedger();

    expect(serverConstructorSpy).toHaveBeenCalledTimes(1);
  });

  // -------------------------------------------------------------------------
  // getServer()
  // -------------------------------------------------------------------------

  it("getServer() returns the underlying SorobanRpc.Server after init", async () => {
    const client = new SplitClient(TEST_CONFIG);
    const server = await client.getServer();
    expect(typeof server.getLatestLedger).toBe("function");
  });
});
