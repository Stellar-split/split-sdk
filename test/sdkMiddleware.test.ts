import { describe, it, expect } from "vitest";
import { SdkMiddlewareChain } from "../src/sdkMiddleware.js";

describe("SdkMiddlewareChain", () => {
  it("runs middleware in order around the handler", async () => {
    const log: string[] = [];
    const chain = new SdkMiddlewareChain()
      .use("a", async (_c, next) => { log.push("a1"); const r = await next(); log.push("a2"); return r; })
      .plugin({ name: "b", middleware: async (_c, next) => { log.push("b"); return next(); } });
    const r = await chain.run({ operation: "op", params: 1 }, async () => { log.push("h"); return 42; });
    expect(r).toBe(42);
    expect(log).toEqual(["a1", "b", "h", "a2"]);
    expect(chain.stats().a.calls).toBe(1);
  });

  it("supports hooks and tracks errors", async () => {
    const seen: string[] = [];
    const chain = new SdkMiddlewareChain().hooks("h", {
      before: () => { seen.push("before"); },
      after: (c) => { seen.push(`after:${c.result}`); },
    });
    await chain.run({ operation: "x", params: null }, async () => "ok");
    expect(seen).toEqual(["before", "after:ok"]);
    await expect(chain.run({ operation: "x", params: null }, async () => { throw new Error("e"); })).rejects.toThrow("e");
    expect(chain.stats().h.errors).toBe(1);
  });
});
