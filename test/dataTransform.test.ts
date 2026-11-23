import { describe, it, expect } from "vitest";
import {
  TransformRegistry,
  TransformError,
  builtInTransforms,
  composeTransforms,
} from "../src/dataTransform.js";

describe("dataTransform", () => {
  it("applies built-in transforms", async () => {
    const r = new TransformRegistry();
    expect(await r.apply("trim", "  hi ")).toBe("hi");
    expect(await r.apply("toNumber", "42")).toBe(42);
  });

  it("supports custom transforms and rejects duplicates", async () => {
    const r = new TransformRegistry();
    r.register("double", (n: number) => n * 2);
    expect(await r.apply("double", 4)).toBe(8);
    expect(() => r.register("double", (n: number) => n)).toThrow(/already registered/);
    expect(() => r.apply("missing", 1)).rejects.toThrow(/Unknown transform/);
  });

  it("composes transforms left to right", async () => {
    const r = new TransformRegistry();
    r.register("inc", (n: number) => n + 1);
    const fn = r.compose<number>("trim", "toNumber", "inc", (n: number) => n * 10);
    expect(await fn(" 4 ")).toBe(50);
    expect(await composeTransforms<string>((s: string) => s + "a", (s: string) => s + "b")("x")).toBe("xab");
  });

  it("wraps failures in TransformError and tracks them", async () => {
    const r = new TransformRegistry();
    await expect(r.apply("toNumber", "abc")).rejects.toBeInstanceOf(TransformError);
    await r.apply("trim", " a ");
    const stats = r.getStats();
    expect(stats.toNumber).toEqual({ calls: 1, failures: 1 });
    expect(stats.trim).toEqual({ calls: 1, failures: 0 });
    expect(r.getHistory()[0]!.error).toMatch(/Cannot convert/);
    r.clearHistory();
    expect(r.getHistory()).toEqual([]);
  });

  it("pick and omit", () => {
    expect(builtInTransforms.pick<{ a: number; b: number }, "a">("a")({ a: 1, b: 2 })).toEqual({ a: 1 });
    expect(builtInTransforms.omit<{ a: number; b: number }, "a">("a")({ a: 1, b: 2 })).toEqual({ b: 2 });
  });
});
