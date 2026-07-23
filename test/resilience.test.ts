import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { CircuitBreaker } from "../src/circuitBreaker.js";
import { ResilientRpcClient } from "../src/resilientRpc.js";
import { StellarSplitClient } from "../src/client.js";
import {
  CircuitOpenError,
  InvoiceNotFoundError,
  UnauthorizedError,
} from "../src/errors.js";

// ---------------------------------------------------------------------------
// CircuitBreaker
// ---------------------------------------------------------------------------

describe("CircuitBreaker", () => {
  let cb: CircuitBreaker;

  beforeEach(() => {
    vi.useFakeTimers();
    cb = new CircuitBreaker({ failureThreshold: 3, resetTimeoutMs: 5000 });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("starts in CLOSED state", () => {
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(0);
  });

  it("stays CLOSED when failures are below threshold", () => {
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(2);
  });

  it("transitions to OPEN after reaching failure threshold", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");
  });

  it("rejects requests when OPEN", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.canExecute()).toBe(false);
  });

  it("transitions to HALF-OPEN after reset timeout", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");

    vi.advanceTimersByTime(5000);
    expect(cb.canExecute()).toBe(true);
    expect(cb.state).toBe("half-open");
  });

  it("returns to CLOSED on success from HALF-OPEN", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(5000);
    expect(cb.canExecute()).toBe(true); // half-open

    cb.recordSuccess();
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(0);
  });

  it("re-opens to OPEN on failure from HALF-OPEN", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(5000);
    expect(cb.canExecute()).toBe(true); // half-open

    cb.recordFailure();
    expect(cb.state).toBe("open");
  });

  it("recordSuccess resets failure counter in CLOSED state", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordSuccess();
    expect(cb.failureCount).toBe(0);
  });

  it("reset forces state back to CLOSED", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");

    cb.reset();
    expect(cb.state).toBe("closed");
    expect(cb.failureCount).toBe(0);
    expect(cb.canExecute()).toBe(true);
  });

  it("emits circuit:open event when transitioning to OPEN", () => {
    const handler = vi.fn();
    cb.on("circuit:open", handler);

    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("emits circuit:half-open event when transitioning to HALF-OPEN", () => {
    const handler = vi.fn();
    cb.on("circuit:half-open", handler);

    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(5000);
    cb.canExecute(); // triggers transition
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("emits circuit:close event when transitioning to CLOSED", () => {
    const handler = vi.fn();
    cb.on("circuit:close", handler);

    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    vi.advanceTimersByTime(5000);
    cb.canExecute(); // half-open
    cb.recordSuccess(); // closed
    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("emits stateChange event with from/to", () => {
    const handler = vi.fn();
    cb.on("stateChange", handler);

    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(handler).toHaveBeenCalledWith({ from: "closed", to: "open" });
  });

  it("does not open if failure threshold is not reached", () => {
    cb.recordFailure();
    cb.recordFailure();
    // 2 failures, threshold is 3
    expect(cb.state).toBe("closed");
    expect(cb.canExecute()).toBe(true);
  });

  it("does not re-open when already OPEN and another failure occurs", () => {
    const handler = vi.fn();
    cb.on("circuit:open", handler);

    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(handler).toHaveBeenCalledTimes(1);

    // Additional failure while OPEN
    cb.recordFailure();
    expect(handler).toHaveBeenCalledTimes(1); // no additional emit
  });

  it("does not clear reset timeout when resetting from OPEN", () => {
    cb.recordFailure();
    cb.recordFailure();
    cb.recordFailure();
    expect(cb.state).toBe("open");

    cb.reset();
    expect(cb.state).toBe("closed");

    // Even after timeout, stays CLOSED
    vi.advanceTimersByTime(10000);
    expect(cb.state).toBe("closed");
  });
});

// ---------------------------------------------------------------------------
// ResilientRpcClient
// ---------------------------------------------------------------------------

describe("ResilientRpcClient", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function createMockRpc() {
    return {
      getAccount: vi.fn().mockResolvedValue({ accountId: () => "GABC" }),
      simulateTransaction: vi.fn().mockResolvedValue({ result: {} }),
      sendTransaction: vi.fn().mockResolvedValue({ hash: "tx1", status: "SUCCESS" }),
      getTransaction: vi.fn().mockResolvedValue({ status: "SUCCESS" }),
      getLatestLedger: vi.fn().mockResolvedValue({ sequence: 100 }),
      getEvents: vi.fn().mockResolvedValue({ events: [] }),
      getFeeStats: vi.fn().mockResolvedValue({}),
    };
  }

  it("delegates calls to the inner RPC client on success", async () => {
    const mock = createMockRpc();
    const resilient = new ResilientRpcClient(mock, { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 100, jitter: false });

    const result = await resilient.getAccount("GABC");
    expect(mock.getAccount).toHaveBeenCalledWith("GABC");
    expect(result).toEqual({ accountId: expect.any(Function) });
  });

  it("retries on transient errors with exponential backoff", async () => {
    const mock = createMockRpc();
    const timeoutErr = new Error("network timeout");
    mock.getAccount
      .mockRejectedValueOnce(timeoutErr)
      .mockRejectedValueOnce(timeoutErr)
      .mockResolvedValue({ accountId: () => "GABC" });

    const resilient = new ResilientRpcClient(mock, {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 10000,
      jitter: false,
    });

    const promise = resilient.getAccount("GABC");
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(mock.getAccount).toHaveBeenCalledTimes(3);
    expect(result).toEqual({ accountId: expect.any(Function) });
  });

  it("opens circuit breaker after repeated failures", async () => {
    const mock = createMockRpc();
    const timeoutErr = new Error("network timeout");
    mock.getAccount.mockRejectedValue(timeoutErr);

    const resilient = new ResilientRpcClient(
      mock,
      { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100, jitter: false },
      { failureThreshold: 2, resetTimeoutMs: 5000 },
    );

    // First call: 2 attempts (maxRetries=2), 1 failure recorded
    await expect(
      Promise.all([
        resilient.getAccount("GABC"),
        vi.runAllTimersAsync(),
      ])
    ).rejects.toThrow("network timeout");

    expect(resilient.circuitBreaker.failureCount).toBe(1);

    // Second call: 2 attempts, 2nd failure reaches threshold -> opens
    await expect(
      Promise.all([
        resilient.getAccount("GABC"),
        vi.runAllTimersAsync(),
      ])
    ).rejects.toThrow("network timeout");

    expect(resilient.circuitBreaker.state).toBe("open");

    // Third call: circuit is open, fails immediately
    await expect(resilient.getAccount("GABC")).rejects.toThrow(CircuitOpenError);
    // 2 calls × 2 retries each = 4 mock calls
    expect(mock.getAccount).toHaveBeenCalledTimes(4);
  });

  it("circuit breaker resets after timeout and allows recovery", async () => {
    const mock = createMockRpc();
    const timeoutErr = new Error("network timeout");
    mock.getAccount.mockRejectedValue(timeoutErr);

    const resilient = new ResilientRpcClient(
      mock,
      { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 100, jitter: false },
      { failureThreshold: 2, resetTimeoutMs: 5000 },
    );

    // Open the circuit
    await expect(
      Promise.all([
        resilient.getAccount("GABC"),
        vi.runAllTimersAsync(),
      ])
    ).rejects.toThrow("network timeout");
    await expect(
      Promise.all([
        resilient.getAccount("GABC"),
        vi.runAllTimersAsync(),
      ])
    ).rejects.toThrow("network timeout");
    expect(resilient.circuitBreaker.state).toBe("open");

    // Wait for reset timeout
    vi.advanceTimersByTime(5000);
    expect(resilient.circuitBreaker.state).toBe("half-open");

    // Recovery: next call succeeds
    mock.getAccount.mockResolvedValue({ accountId: () => "GABC" });
    await resilient.getAccount("GABC");
    expect(resilient.circuitBreaker.state).toBe("closed");
  });

  it("non-retryable InvoiceNotFoundError bypasses retry", async () => {
    const mock = createMockRpc();
    mock.getAccount.mockRejectedValue(new InvoiceNotFoundError("42"));

    const resilient = new ResilientRpcClient(mock, {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 10000,
      jitter: false,
    });

    await expect(resilient.getAccount("GABC")).rejects.toThrow(InvoiceNotFoundError);
    expect(mock.getAccount).toHaveBeenCalledTimes(1); // no retry
  });

  it("non-retryable UnauthorizedError bypasses retry", async () => {
    const mock = createMockRpc();
    mock.getAccount.mockRejectedValue(new UnauthorizedError());

    const resilient = new ResilientRpcClient(mock, {
      maxRetries: 3,
      baseDelayMs: 100,
      maxDelayMs: 10000,
      jitter: false,
    });

    await expect(resilient.getAccount("GABC")).rejects.toThrow(UnauthorizedError);
    expect(mock.getAccount).toHaveBeenCalledTimes(1);
  });

  it("non-retryable errors do not trip the circuit breaker", async () => {
    const mock = createMockRpc();
    mock.getAccount.mockRejectedValue(new InvoiceNotFoundError("42"));

    const resilient = new ResilientRpcClient(
      mock,
      { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 100, jitter: false },
      { failureThreshold: 2, resetTimeoutMs: 5000 },
    );

    await expect(resilient.getAccount("GABC")).rejects.toThrow(InvoiceNotFoundError);
    await expect(resilient.getAccount("GABC")).rejects.toThrow(InvoiceNotFoundError);
    await expect(resilient.getAccount("GABC")).rejects.toThrow(InvoiceNotFoundError);

    // Circuit should still be closed
    expect(resilient.circuitBreaker.state).toBe("closed");
  });

  it("emits circuit:open event when circuit opens", async () => {
    const mock = createMockRpc();
    mock.getAccount.mockRejectedValue(new Error("503 service unavailable"));

    const resilient = new ResilientRpcClient(
      mock,
      { maxRetries: 2, baseDelayMs: 10, maxDelayMs: 100, jitter: false },
      { failureThreshold: 2, resetTimeoutMs: 5000 },
    );

    const handler = vi.fn();
    resilient.on("circuit:open", handler);

    // First call: 2 attempts, 1 failure recorded
    await expect(
      Promise.all([
        resilient.getAccount("GABC"),
        vi.runAllTimersAsync(),
      ])
    ).rejects.toThrow();

    // Second call: 2 attempts, threshold reached -> circuit opens
    await expect(
      Promise.all([
        resilient.getAccount("GABC"),
        vi.runAllTimersAsync(),
      ])
    ).rejects.toThrow();

    expect(handler).toHaveBeenCalledTimes(1);
  });

  it("emits circuit:half-open and circuit:close events", async () => {
    const mock = createMockRpc();
    mock.getAccount.mockRejectedValue(new Error("503"));

    const resilient = new ResilientRpcClient(
      mock,
      { maxRetries: 1, baseDelayMs: 10, maxDelayMs: 100, jitter: false },
      { failureThreshold: 2, resetTimeoutMs: 5000 },
    );

    const halfOpenHandler = vi.fn();
    const closeHandler = vi.fn();
    resilient.on("circuit:half-open", halfOpenHandler);
    resilient.on("circuit:close", closeHandler);

    // Open the circuit
    await expect(
      Promise.all([
        resilient.getAccount("GABC"),
        vi.runAllTimersAsync(),
      ])
    ).rejects.toThrow();
    await expect(
      Promise.all([
        resilient.getAccount("GABC"),
        vi.runAllTimersAsync(),
      ])
    ).rejects.toThrow();
    expect(resilient.circuitBreaker.state).toBe("open");

    // Advance to half-open via canExecute
    vi.advanceTimersByTime(5000);
    resilient.circuitBreaker.canExecute(); // trigger transition
    expect(halfOpenHandler).toHaveBeenCalledTimes(1);

    // Recovery
    mock.getAccount.mockResolvedValue({ accountId: () => "GABC" });
    await resilient.getAccount("GABC");
    expect(closeHandler).toHaveBeenCalledTimes(1);
  });

  it("respects maxDelayMs cap with exponential backoff", async () => {
    const mock = createMockRpc();
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;

    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms: number, ...args: any[]) => {
      if (ms > 0) delays.push(ms);
      return origSetTimeout(fn, 0, ...args);
    });

    const err = new Error("network timeout");
    mock.getAccount
      .mockRejectedValueOnce(err)
      .mockResolvedValue({ accountId: () => "GABC" });

    const resilient = new ResilientRpcClient(mock, {
      maxRetries: 3,
      baseDelayMs: 1000,
      maxDelayMs: 2000,
      jitter: false,
    });

    const promise = resilient.getAccount("GABC");
    await vi.runAllTimersAsync();
    await promise;

    expect(delays.length).toBe(1);
    expect(delays[0]).toBeLessThanOrEqual(2000);
  });

  it("applies jitter when enabled", async () => {
    const mock = createMockRpc();
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;

    vi.spyOn(globalThis, "setTimeout").mockImplementation((fn: any, ms: number, ...args: any[]) => {
      if (ms > 0) delays.push(ms);
      return origSetTimeout(fn, 0, ...args);
    });

    const err = new Error("network timeout");
    mock.getAccount
      .mockRejectedValueOnce(err)
      .mockResolvedValue({ accountId: () => "GABC" });

    const resilient = new ResilientRpcClient(mock, {
      maxRetries: 2,
      baseDelayMs: 100,
      maxDelayMs: 10000,
      jitter: true,
    });

    const promise = resilient.getAccount("GABC");
    await vi.runAllTimersAsync();
    await promise;

    expect(delays.length).toBe(1);
    // With jitter: delay = baseDelayMs * 2^0 + random * baseDelayMs
    // So delay should be >= 100 and <= 200
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[0]).toBeLessThanOrEqual(200);
  });

  it("inner property returns the unwrapped RPC client", () => {
    const mock = createMockRpc();
    const resilient = new ResilientRpcClient(mock);
    expect(resilient.inner).toBe(mock);
  });

  it("circuitBreaker property exposes the circuit breaker instance", () => {
    const mock = createMockRpc();
    const resilient = new ResilientRpcClient(mock);
    expect(resilient.circuitBreaker).toBeInstanceOf(CircuitBreaker);
  });
});

// ---------------------------------------------------------------------------
// StellarSplitClient — circuit breaker integration
// ---------------------------------------------------------------------------

describe("StellarSplitClient circuit breaker", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  function makeClient(cbConfig?: { breaker?: { failureThreshold?: number; resetTimeoutMs?: number }; retry?: { maxRetries?: number; baseDelayMs?: number } }) {
    return new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
      circuitBreaker: cbConfig,
    });
  }

  it("getCircuitBreakerState returns null when no circuit breaker configured", () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });
    expect(client.getCircuitBreakerState()).toBeNull();
  });

  it("getCircuitBreakerState returns 'closed' when configured", () => {
    const client = makeClient({ breaker: { failureThreshold: 3, resetTimeoutMs: 5000 } });
    expect(client.getCircuitBreakerState()).toBe("closed");
  });

  it("getCircuitBreakerFailureCount returns null when no circuit breaker", () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });
    expect(client.getCircuitBreakerFailureCount()).toBeNull();
  });

  it("getCircuitBreakerFailureCount returns 0 initially", () => {
    const client = makeClient({ breaker: { failureThreshold: 5, resetTimeoutMs: 30000 } });
    expect(client.getCircuitBreakerFailureCount()).toBe(0);
  });

  it("resetCircuitBreaker is a no-op when no circuit breaker configured", () => {
    const client = new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    });
    // Should not throw
    client.resetCircuitBreaker();
  });

  it("resetCircuitBreaker resets to CLOSED", () => {
    const client = makeClient({ breaker: { failureThreshold: 1, resetTimeoutMs: 5000 } });
    expect(client.getCircuitBreakerState()).toBe("closed");
    const cb = (client as any)._resilientRpc?.circuitBreaker;
    if (cb) {
      cb.recordFailure();
      expect(client.getCircuitBreakerState()).toBe("open");
      client.resetCircuitBreaker();
      expect(client.getCircuitBreakerState()).toBe("closed");
    }
  });

  it("emits circuit:open event on client when circuit opens", () => {
    const client = makeClient({
      breaker: { failureThreshold: 2, resetTimeoutMs: 5000 },
    });

    const handler = vi.fn();
    client.on("circuit:open", handler);

    const cb = (client as any)._resilientRpc?.circuitBreaker;
    if (cb) {
      cb.recordFailure();
      cb.recordFailure();
      expect(handler).toHaveBeenCalledTimes(1);
    }
  });

  it("emits circuit:close event on client when circuit recovers", () => {
    const client = makeClient({
      breaker: { failureThreshold: 1, resetTimeoutMs: 5000 },
    });

    const handler = vi.fn();
    client.on("circuit:close", handler);

    const cb = (client as any)._resilientRpc?.circuitBreaker;
    if (cb) {
      cb.recordFailure();
      expect(client.getCircuitBreakerState()).toBe("open");
      // Transition to half-open first
      vi.advanceTimersByTime(5000);
      cb.canExecute();
      expect(client.getCircuitBreakerState()).toBe("half-open");
      // Now record success to go to closed
      cb.recordSuccess();
      expect(handler).toHaveBeenCalledTimes(1);
      expect(client.getCircuitBreakerState()).toBe("closed");
    }
  });

  it("emits circuit:half-open event on client", () => {
    const client = makeClient({
      breaker: { failureThreshold: 1, resetTimeoutMs: 5000 },
    });

    const handler = vi.fn();
    client.on("circuit:half-open", handler);

    const cb = (client as any)._resilientRpc?.circuitBreaker;
    if (cb) {
      cb.recordFailure();
      vi.advanceTimersByTime(5000);
      cb.canExecute(); // trigger transition
      expect(handler).toHaveBeenCalledTimes(1);
    }
  });
});
