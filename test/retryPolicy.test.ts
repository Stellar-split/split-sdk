import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { executeWithRetry, isRetryable } from "../src/retryPolicy.js";
import type { RetryOptions } from "../src/retryPolicy.js";
import { StellarSplitClient } from "../src/client.js";
import {
  InvoiceNotFoundError,
  ValidationError,
  WalletNotConnectedError,
  RpcError,
} from "../src/errors.js";

const defaultOptions: RetryOptions = {
  maxAttempts: 3,
  baseDelayMs: 100,
  maxDelayMs: 5000,
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// isRetryable
// ---------------------------------------------------------------------------

describe("isRetryable", () => {
  it("returns false for InvoiceNotFoundError", () => {
    expect(isRetryable(new InvoiceNotFoundError("42"))).toBe(false);
  });

  it("returns false for ValidationError", () => {
    expect(isRetryable(new ValidationError("bad input"))).toBe(false);
  });

  it("returns false for WalletNotConnectedError", () => {
    expect(isRetryable(new WalletNotConnectedError())).toBe(false);
  });

  it("returns true for RpcError with status 429", () => {
    const err = new RpcError("rate limited", 429, "https://rpc.example.com");
    expect(isRetryable(err)).toBe(true);
  });

  it("returns true for RpcError with status 503", () => {
    const err = new RpcError("service unavailable", 503, "https://rpc.example.com");
    expect(isRetryable(err)).toBe(true);
  });

  it("returns false for RpcError with status 404", () => {
    const err = new RpcError("not found", 404, "https://rpc.example.com");
    expect(isRetryable(err)).toBe(false);
  });

  it("returns true for network timeout errors", () => {
    expect(isRetryable(new Error("network timeout"))).toBe(true);
    expect(isRetryable(new Error("timed out waiting for response"))).toBe(true);
    expect(isRetryable(new Error("failed to fetch"))).toBe(true);
    expect(isRetryable(new Error("ECONNRESET"))).toBe(true);
  });

  it("returns true for AbortError", () => {
    const err = new Error("aborted");
    err.name = "AbortError";
    expect(isRetryable(err)).toBe(true);
  });

  it("returns false for non-Error values", () => {
    expect(isRetryable("string error")).toBe(false);
    expect(isRetryable(null)).toBe(false);
    expect(isRetryable(42)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// executeWithRetry — basic behaviour
// ---------------------------------------------------------------------------

describe("executeWithRetry", () => {
  it("returns the result on first-attempt success", async () => {
    const fn = vi.fn().mockResolvedValue("ok");
    const result = await executeWithRetry(fn, defaultOptions);
    expect(result).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("retries on retryable error and returns on subsequent success", async () => {
    const fn = vi.fn()
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValue("recovered");

    const promise = executeWithRetry(fn, defaultOptions);
    await vi.runAllTimersAsync();
    await expect(promise).resolves.toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(2);
  });

  it("does NOT retry InvoiceNotFoundError", async () => {
    const err = new InvoiceNotFoundError("99");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(executeWithRetry(fn, defaultOptions)).rejects.toThrow(InvoiceNotFoundError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry ValidationError", async () => {
    const err = new ValidationError("invalid amount");
    const fn = vi.fn().mockRejectedValue(err);
    await expect(executeWithRetry(fn, defaultOptions)).rejects.toThrow(ValidationError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("does NOT retry WalletNotConnectedError", async () => {
    const err = new WalletNotConnectedError();
    const fn = vi.fn().mockRejectedValue(err);
    await expect(executeWithRetry(fn, defaultOptions)).rejects.toThrow(WalletNotConnectedError);
    expect(fn).toHaveBeenCalledTimes(1);
  });

  it("throws after exhausting maxAttempts with retryable error", async () => {
    const err = new Error("503 service unavailable");
    const fn = vi.fn().mockRejectedValue(err);

    await expect(
      Promise.all([
        executeWithRetry(fn, { ...defaultOptions, maxAttempts: 3 }),
        vi.runAllTimersAsync(),
      ])
    ).rejects.toThrow("503 service unavailable");
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("sets retryExhausted=true on last error when attempts exhausted", async () => {
    const err = new Error("network timeout");
    const fn = vi.fn().mockRejectedValue(err);

    let caught: unknown;
    await Promise.all([
      executeWithRetry(fn, { ...defaultOptions, maxAttempts: 2 }).catch((e) => {
        caught = e;
      }),
      vi.runAllTimersAsync(),
    ]);

    expect((caught as any).retryExhausted).toBe(true);
  });

  it("does NOT set retryExhausted for non-retryable errors", async () => {
    const err = new InvoiceNotFoundError("1");
    const fn = vi.fn().mockRejectedValue(err);

    let caught: unknown;
    try {
      await executeWithRetry(fn, defaultOptions);
    } catch (e) {
      caught = e;
    }

    expect((caught as any).retryExhausted).toBeUndefined();
  });

  it("uses exponential backoff: delay grows as baseDelay * 2^attempt", async () => {
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;

    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (fn: any, ms: number, ...args: any[]) => {
        if (ms > 0) delays.push(ms);
        return origSetTimeout(fn, 0, ...args);
      }
    );

    const transientErr = new Error("network timeout");
    const fnMock = vi.fn()
      .mockRejectedValueOnce(transientErr)
      .mockRejectedValueOnce(transientErr)
      .mockResolvedValue("done");

    const opts: RetryOptions = { maxAttempts: 3, baseDelayMs: 100, maxDelayMs: 10000 };
    const promise = executeWithRetry(fnMock, opts);
    await vi.runAllTimersAsync();
    await promise;

    spy.mockRestore();

    // delay[0] >= baseDelayMs * 2^0 = 100
    // delay[1] >= baseDelayMs * 2^1 = 200
    expect(delays.length).toBe(2);
    expect(delays[0]).toBeGreaterThanOrEqual(100);
    expect(delays[1]).toBeGreaterThanOrEqual(200);
  });

  it("caps delay at maxDelayMs", async () => {
    const delays: number[] = [];
    const origSetTimeout = globalThis.setTimeout;

    const spy = vi.spyOn(globalThis, "setTimeout").mockImplementation(
      (fn: any, ms: number, ...args: any[]) => {
        if (ms > 0) delays.push(ms);
        return origSetTimeout(fn, 0, ...args);
      }
    );

    const err = new Error("network timeout");
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");

    const promise = executeWithRetry(fn, { maxAttempts: 2, baseDelayMs: 10000, maxDelayMs: 1000 });
    await vi.runAllTimersAsync();
    await promise;

    spy.mockRestore();

    expect(delays[0]).toBeLessThanOrEqual(1000);
  });

  it("calls onRetry(attempt, error, delayMs) before each retry", async () => {
    const onRetry = vi.fn();
    const err = new Error("network timeout");
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");

    const opts: RetryOptions = { ...defaultOptions, maxAttempts: 3, onRetry };
    const promise = executeWithRetry(fn, opts);
    await vi.runAllTimersAsync();
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(2);
    expect(onRetry).toHaveBeenNthCalledWith(1, 1, err, expect.any(Number));
    expect(onRetry).toHaveBeenNthCalledWith(2, 2, err, expect.any(Number));
  });

  it("respects per-method maxAttempts override", async () => {
    const err = new Error("network timeout");
    const fn = vi.fn().mockRejectedValue(err);

    let caught: unknown;
    await Promise.all([
      executeWithRetry(fn, { ...defaultOptions, maxAttempts: 1 }, { maxAttempts: 5 }).catch((e) => {
        caught = e;
      }),
      vi.runAllTimersAsync(),
    ]);

    expect(fn).toHaveBeenCalledTimes(5);
    expect((caught as any).retryExhausted).toBe(true);
  });

  it("per-method onRetry override is used instead of global", async () => {
    const globalOnRetry = vi.fn();
    const methodOnRetry = vi.fn();
    const err = new Error("network timeout");
    const fn = vi.fn()
      .mockRejectedValueOnce(err)
      .mockResolvedValue("ok");

    const opts: RetryOptions = { ...defaultOptions, onRetry: globalOnRetry };
    const promise = executeWithRetry(fn, opts, { onRetry: methodOnRetry });
    await vi.runAllTimersAsync();
    await promise;

    expect(globalOnRetry).not.toHaveBeenCalled();
    expect(methodOnRetry).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// StellarSplitClient — retry config wired up
// ---------------------------------------------------------------------------

describe("StellarSplitClient retry config", () => {
  function makeClient(retryOverrides?: Partial<RetryOptions>) {
    return new StellarSplitClient({
      rpcUrl: "https://example.com",
      networkPassphrase: "Test SDF Network ; September 2015",
      contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
      retry: {
        maxAttempts: 3,
        baseDelayMs: 50,
        maxDelayMs: 5000,
        ...retryOverrides,
      },
    });
  }

  it("pay retries on HTTP 503 RpcError and succeeds", async () => {
    const client = makeClient();
    const rpcErr = new RpcError("service unavailable", 503, "https://example.com");

    const submitSpy = vi.spyOn(client as any, "_submitTx")
      .mockRejectedValueOnce(rpcErr)
      .mockResolvedValueOnce({ txHash: "tx-ok", returnValue: {} } as any);

    const payer = Keypair.random().publicKey();
    const promise = client.pay({ payer, invoiceId: "1", amount: 1_000_000n });
    await vi.runAllTimersAsync();
    const result = await promise;
    expect(result.txHash).toBe("tx-ok");
    expect(submitSpy).toHaveBeenCalledTimes(2);
  });

  it("pay does NOT retry RpcError with 404", async () => {
    const client = makeClient();
    const rpcErr = new RpcError("not found", 404, "https://example.com");

    const submitSpy = vi.spyOn(client as any, "_submitTx").mockRejectedValue(rpcErr);

    const payer = Keypair.random().publicKey();
    await expect(client.pay({ payer, invoiceId: "1", amount: 1_000_000n })).rejects.toThrow(
      RpcError
    );
    expect(submitSpy).toHaveBeenCalledTimes(1);
  });

  it("pay marks error as retryExhausted after maxAttempts", async () => {
    const client = makeClient({ maxAttempts: 2 });
    const err = new Error("network timeout");

    vi.spyOn(client as any, "_submitTx").mockRejectedValue(err);

    const payer = Keypair.random().publicKey();
    let caught: unknown;
    await Promise.all([
      client.pay({ payer, invoiceId: "1", amount: 1_000_000n }).catch((e) => {
        caught = e;
      }),
      vi.runAllTimersAsync(),
    ]);

    expect((caught as any).retryExhausted).toBe(true);
  });

  it("pay calls onRetry hook before each retry", async () => {
    const onRetry = vi.fn();
    const client = makeClient({ onRetry });
    const err = new Error("network timeout");

    vi.spyOn(client as any, "_submitTx")
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({ txHash: "ok", returnValue: {} } as any);

    const payer = Keypair.random().publicKey();
    const promise = client.pay({ payer, invoiceId: "1", amount: 1_000_000n });
    await vi.runAllTimersAsync();
    await promise;

    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, err, expect.any(Number));
  });

  it("getInvoice retries on network timeout", async () => {
    const client = makeClient();

    const fetchSpy = vi.spyOn(client as any, "_fetchInvoice")
      .mockRejectedValueOnce(new Error("network timeout"))
      .mockResolvedValueOnce({
        id: "5",
        creator: "G...",
        recipients: [],
        token: "G...",
        deadline: 0,
        funded: 0n,
        status: "Pending" as const,
        payments: [],
      });

    const promise = client.getInvoice("5");
    await vi.runAllTimersAsync();
    const invoice = await promise;
    expect(invoice.id).toBe("5");
    expect(fetchSpy).toHaveBeenCalledTimes(2);
  });

  it("getInvoice does NOT retry InvoiceNotFoundError", async () => {
    const client = makeClient();

    const fetchSpy = vi.spyOn(client as any, "_fetchInvoice").mockRejectedValue(
      new InvoiceNotFoundError("99")
    );

    await expect(client.getInvoice("99")).rejects.toThrow(InvoiceNotFoundError);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it("getInvoice per-method maxAttempts overrides global", async () => {
    const client = makeClient({ maxAttempts: 2 });
    const err = new Error("network timeout");

    const fetchSpy = vi.spyOn(client as any, "_fetchInvoice").mockRejectedValue(err);

    let caught: unknown;
    await Promise.all([
      client.getInvoice("7", { retry: { maxAttempts: 5 } }).catch((e) => {
        caught = e;
      }),
      vi.runAllTimersAsync(),
    ]);

    expect(fetchSpy).toHaveBeenCalledTimes(5);
    expect((caught as any).retryExhausted).toBe(true);
  });

  it("getInvoice per-method onRetry fires for each retry", async () => {
    const perMethodOnRetry = vi.fn();
    const client = makeClient();

    const err = new Error("network timeout");
    vi.spyOn(client as any, "_fetchInvoice")
      .mockRejectedValueOnce(err)
      .mockResolvedValueOnce({
        id: "10",
        creator: "G...",
        recipients: [],
        token: "G...",
        deadline: 0,
        funded: 0n,
        status: "Pending" as const,
        payments: [],
      });

    const promise = client.getInvoice("10", { retry: { onRetry: perMethodOnRetry } });
    await vi.runAllTimersAsync();
    await promise;

    expect(perMethodOnRetry).toHaveBeenCalledTimes(1);
    expect(perMethodOnRetry).toHaveBeenCalledWith(1, err, expect.any(Number));
  });
});
