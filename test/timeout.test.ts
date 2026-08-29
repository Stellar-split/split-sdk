import { describe, it, expect, vi, afterEach } from "vitest";
import { TimeoutManager, withTimeout, withTimeoutOrThrow, RequestTimeoutError } from "../src/timeout.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("TimeoutManager", () => {
  it("returns default timeout for unlisted methods", () => {
    const tm = new TimeoutManager({ default: 10_000, getLeaderboard: 30_000 });
    expect(tm.resolveTimeout("getInvoice")).toBe(10_000);
  });

  it("returns per-method timeout when explicitly listed", () => {
    const tm = new TimeoutManager({ default: 10_000, getLeaderboard: 30_000, getInvoiceHistory: 20_000 });
    expect(tm.resolveTimeout("getLeaderboard")).toBe(30_000);
    expect(tm.resolveTimeout("getInvoiceHistory")).toBe(20_000);
  });

  it("accepts a plain number as a universal default", () => {
    const tm = new TimeoutManager(5_000);
    expect(tm.resolveTimeout("getInvoice")).toBe(5_000);
    expect(tm.resolveTimeout("getLeaderboard")).toBe(5_000);
  });

  it("falls back to 10 000 ms when no default is set", () => {
    const tm = new TimeoutManager({});
    expect(tm.resolveTimeout("getInvoice")).toBe(10_000);
  });

  it("getTimeoutConfig includes all known methods", () => {
    const tm = new TimeoutManager({ default: 10_000, getLeaderboard: 30_000 });
    const cfg = tm.getTimeoutConfig();
    expect(cfg["getLeaderboard"]).toBe(30_000);
    expect(cfg["getInvoice"]).toBe(10_000);
    expect(cfg["pay"]).toBe(10_000);
  });
});

describe("withTimeout", () => {
  it("resolves when operation completes within timeout", async () => {
    const result = await withTimeout(async () => "ok", 1_000, "test");
    expect(result).toEqual({ ok: true, value: "ok" });
  });

  it("returns a timeout result when operation exceeds timeout", async () => {
    vi.useFakeTimers();

    const slow = new Promise<never>(() => { /* never resolves */ });
    const race = withTimeout(() => slow, 100, "slowMethod");

    vi.advanceTimersByTime(150);

    await expect(race).resolves.toMatchObject({
      ok: false,
      reason: "timeout",
      error: expect.objectContaining({ method: "slowMethod", timeoutMs: 100 }),
    });
  });

  it("surfaces timeout metadata in the result union", async () => {
    vi.useFakeTimers();

    const race = withTimeout(
      () => new Promise<never>(() => {}),
      50,
      "getLeaderboard"
    );
    vi.advanceTimersByTime(100);

    const result = await race;
    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("Expected timeout result");
    }
    expect(result.error).toBeInstanceOf(RequestTimeoutError);
    expect(result.error).toMatchObject({ method: "getLeaderboard", timeoutMs: 50, code: "REQUEST_TIMEOUT" });
  });

  it("clears the timer when operation resolves fast", async () => {
    vi.useFakeTimers();
    const result = await withTimeout(async () => 42, 5_000, "fast");
    expect(result).toEqual({ ok: true, value: 42 });
    // No dangling timer — fake timers would expose it if cleanup failed
    vi.runAllTimers();
  });
});

describe("withTimeoutOrThrow", () => {
  it("preserves the throwing behavior for existing callers", async () => {
    vi.useFakeTimers();

    const slow = new Promise<never>(() => undefined);
    const race = withTimeoutOrThrow(() => slow, 100, "slowMethod");
    vi.advanceTimersByTime(150);

    await expect(race).rejects.toThrow(RequestTimeoutError);
  });
});

describe("RequestTimeoutError", () => {
  it("is an instance of Error", () => {
    const err = new RequestTimeoutError("myMethod", 500);
    expect(err).toBeInstanceOf(Error);
    expect(err.name).toBe("RequestTimeoutError");
  });

  it("carries method and timeoutMs", () => {
    const err = new RequestTimeoutError("getLeaderboard", 30_000);
    expect(err.method).toBe("getLeaderboard");
    expect(err.timeoutMs).toBe(30_000);
  });

  it("has a readable message", () => {
    const err = new RequestTimeoutError("pay", 10_000);
    expect(err.message).toMatch(/10000ms/);
    expect(err.message).toMatch(/pay/);
  });
});
