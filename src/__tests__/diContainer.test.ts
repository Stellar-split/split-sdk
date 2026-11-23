import { describe, it, expect, vi } from "vitest";
import { DIContainer } from "../diContainer.js";

describe("DIContainer", () => {
  it("handles singleton and transient lifecycles", () => {
    const c = new DIContainer();
    c.register("s", () => ({}));
    c.register("t", () => ({}), { lifecycle: "transient" });
    expect(c.resolve("s")).toBe(c.resolve("s"));
    expect(c.resolve("t")).not.toBe(c.resolve("t"));
    expect(c.getResolutionCounts()).toEqual({ s: 1, t: 2 });
  });

  it("resolves dependencies and inherits from parent", () => {
    const parent = new DIContainer().registerValue("url", "x");
    const child = parent.createChild().register("api", (c) => `api:${c.resolve<string>("url")}`);
    expect(child.resolve("api")).toBe("api:x");
    expect(() => parent.resolve("api")).toThrow();
  });

  it("detects cycles and disposes", () => {
    const c = new DIContainer();
    c.register("a", (x) => x.resolve("b")).register("b", (x) => x.resolve("a"));
    expect(() => c.resolve("a")).toThrow(/Circular/);
    const d = vi.fn();
    const c2 = new DIContainer().register("z", () => 1, { dispose: d });
    c2.resolve("z");
    c2.dispose();
    expect(d).toHaveBeenCalledWith(1);
  });
});
