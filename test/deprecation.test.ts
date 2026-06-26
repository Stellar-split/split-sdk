import { describe, expect, it, vi, beforeEach } from "vitest";
import { deprecated, resetDeprecationWarnings } from "../src/deprecation.js";

describe("deprecation", () => {
  beforeEach(() => {
    resetDeprecationWarnings();
    vi.restoreAllMocks();
  });

  it("wrapped method still functions identically", () => {
    const original = (a: number, b: number) => a + b;
    const wrapped = deprecated("add", { removedInVersion: "2.0.0", alternative: "sum" }, original);

    vi.spyOn(console, "warn").mockImplementation(() => {});
    expect(wrapped(3, 4)).toBe(7);
  });

  it("warning fires exactly once across multiple calls", () => {
    const fn = vi.fn(() => "result");
    const wrapped = deprecated("oldMethod", { removedInVersion: "3.0.0", alternative: "newMethod" }, fn);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    wrapped();
    wrapped();
    wrapped();

    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("warning message contains the alternative", () => {
    const fn = vi.fn();
    const wrapped = deprecated("legacyPay", { removedInVersion: "2.0.0", alternative: "payV2" }, fn);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    wrapped();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("payV2"),
    );
  });

  it("warning message contains the version", () => {
    const fn = vi.fn();
    const wrapped = deprecated("oldFn", { removedInVersion: "4.0.0", alternative: "newFn" }, fn);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    wrapped();

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining("v4.0.0"),
    );
  });

  it("separate methods each warn independently", () => {
    const fn1 = vi.fn();
    const fn2 = vi.fn();
    const wrapped1 = deprecated("method1", { removedInVersion: "2.0.0", alternative: "alt1" }, fn1);
    const wrapped2 = deprecated("method2", { removedInVersion: "2.0.0", alternative: "alt2" }, fn2);

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});

    wrapped1();
    wrapped2();
    wrapped1();
    wrapped2();

    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it("preserves return value of async functions", async () => {
    const asyncFn = async (x: number) => x * 2;
    const wrapped = deprecated("asyncOld", { removedInVersion: "2.0.0", alternative: "asyncNew" }, asyncFn);

    vi.spyOn(console, "warn").mockImplementation(() => {});
    const result = await wrapped(5);
    expect(result).toBe(10);
  });
});
