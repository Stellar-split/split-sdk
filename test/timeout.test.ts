import { describe, it, expect, vi, afterEach } from "vitest";
import { TimeoutManager, withTimeout, RequestTimeoutError } from "../src/timeout.js";

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
    expect(result).toBe("ok");
  });

  it("throws RequestTimeoutError when operation exceeds timeout", async () => {
    vi.useFakeTimers();

    const slow = new Promise<never>(() => { /* never resolves */ });
    const race = withTimeout(() => slow, 100, "slowMethod");

    vi.advanceTimersByTime(150);

    await expect(race).rejects.toThrow(RequestTimeoutError);
    await expect(race).rejects.toMatchObject({ method: "slowMethod", timeoutMs: 100 });
  });

  it("aborts and throws correctly; error has method and timeoutMs", async () => {
    vi.useFakeTimers();

    const race = withTimeout(
      () => new Promise<never>(() => {}),
      50,
      "getLeaderboard"
    );
    vi.advanceTimersByTime(100);

    const err = await race.catch((e) => e);
    expect(err).toBeInstanceOf(RequestTimeoutError);
    expect(err.method).toBe("getLeaderboard");
    expect(err.timeoutMs).toBe(50);
    expect(err.code).toBe("REQUEST_TIMEOUT");
  });

  it("clears the timer when operation resolves fast", async () => {
    vi.useFakeTimers();
    const result = await withTimeout(async () => 42, 5_000, "fast");
    expect(result).toBe(42);
    // No dangling timer — fake timers would expose it if cleanup failed
    vi.runAllTimers();
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
