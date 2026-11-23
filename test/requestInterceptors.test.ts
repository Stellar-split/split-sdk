import { describe, it, expect } from "vitest";
import { InterceptorChain, InterceptorError } from "../src/requestInterceptors.js";

describe("InterceptorChain", () => {
  it("modifies requests in order", async () => {
    const c = new InterceptorChain();
    c.useRequest((r) => ({ ...r, params: [...r.params, "b"] }), { order: 2 });
    c.useRequest((r) => ({ ...r, params: [...r.params, "a"] }), { order: 1 });
    c.useRequest(async (r) => ({ ...r, params: [...r.params, "c"] }), { order: 2 });
    const out = await c.runRequest({ method: "m", params: [] });
    expect(out.params).toEqual(["a", "b", "c"]);
  });

  it("manipulates responses", async () => {
    const c = new InterceptorChain();
    c.useResponse((r) => ({ ...r, result: Number(r.result) + 1 }));
    const out = await c.runResponse({ method: "m", result: 1, durationMs: 5 });
    expect(out.result).toBe(2);
  });

  it("ejects and rejects duplicate ids", async () => {
    const c = new InterceptorChain();
    const id = c.useRequest((r) => ({ ...r, method: "x" }), { id: "one" });
    expect(() => c.useRequest((r) => r, { id: "one" })).toThrow(/already exists/);
    expect(c.eject(id)).toBe(true);
    expect(c.eject(id)).toBe(false);
    expect((await c.runRequest({ method: "m", params: [] })).method).toBe("m");
  });

  it("wraps errors and tracks invocations", async () => {
    const c = new InterceptorChain();
    c.useRequest(() => {
      throw new Error("boom");
    }, { id: "bad" });
    await expect(c.runRequest({ method: "m", params: [] })).rejects.toBeInstanceOf(InterceptorError);
    expect(c.list()).toEqual([
      { id: "bad", kind: "request", order: 0, invocations: 1, failures: 1 },
    ]);
  });
});
