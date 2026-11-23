import { describe, it, expect, vi, beforeEach } from "vitest";
import type { RPCRequest, RPCResponse } from "../src/interceptors.js";
import { PluginRegistry } from "../src/plugin.js";
import type { SdkPlugin } from "../src/plugin.js";

// interceptors.ts keeps module-level chains, so reload it for isolation.
let mod: typeof import("../src/interceptors.js");
beforeEach(async () => {
  vi.resetModules();
  mod = await import("../src/interceptors.js");
});

const req = (): RPCRequest => ({ method: "getLedger", params: [] });
const res = (): RPCResponse => ({ method: "getLedger", result: 1, durationMs: 5 });

describe("interceptor chain (issue #1305)", () => {
  it("returns the request untouched when no interceptors are registered", async () => {
    const r = req();
    expect(await mod.runRequestInterceptors(r)).toBe(r);
  });

  it("runs request interceptors in registration order, piping output to input", async () => {
    const order: string[] = [];
    mod.addRequestInterceptor((r) => { order.push("a"); return { ...r, params: [...r.params, "a"] }; });
    mod.addRequestInterceptor((r) => { order.push("b"); return { ...r, params: [...r.params, "b"] }; });
    const out = await mod.runRequestInterceptors(req());
    expect(order).toEqual(["a", "b"]);
    expect(out.params).toEqual(["a", "b"]);
  });

  it("supports async interceptors mixed with sync ones, preserving order", async () => {
    mod.addRequestInterceptor(async (r) => {
      await new Promise((x) => setTimeout(x, 10));
      return { ...r, headers: { ...r.headers, first: "1" } };
    });
    mod.addRequestInterceptor((r) => ({ ...r, headers: { ...r.headers, second: String(Object.keys(r.headers ?? {}).length) } }));
    const out = await mod.runRequestInterceptors(req());
    expect(out.headers).toEqual({ first: "1", second: "1" });
  });

  it("runs response interceptors in order and composes their changes", async () => {
    mod.addResponseInterceptor((r) => ({ ...r, durationMs: r.durationMs * 2 }));
    mod.addResponseInterceptor(async (r) => ({ ...r, durationMs: r.durationMs + 1 }));
    const out = await mod.runResponseInterceptors(res());
    expect(out.durationMs).toBe(11);
  });

  it("propagates errors and stops later interceptors from running", async () => {
    const later = vi.fn((r: RPCRequest) => r);
    mod.addRequestInterceptor(() => { throw new Error("boom"); });
    mod.addRequestInterceptor(later);
    await expect(mod.runRequestInterceptors(req())).rejects.toThrow("boom");
    expect(later).not.toHaveBeenCalled();
  });

  it("does not mutate the original request when interceptors return copies", async () => {
    mod.addRequestInterceptor((r) => ({ ...r, params: [1] }));
    const original = req();
    await mod.runRequestInterceptors(original);
    expect(original.params).toEqual([]);
  });
});

describe("PluginRegistry middleware composition (issue #1305)", () => {
  const mk = (name: string, log: string[]): SdkPlugin => ({
    name,
    beforeCall: (_m, args) => { log.push(`before:${name}`); return args; },
    afterCall: (_m, result) => { log.push(`after:${name}`); return result; },
    onError: () => { log.push(`error:${name}`); },
  });

  it("runs beforeCall in registration order and afterCall/onError in reverse", () => {
    const log: string[] = [];
    const reg = new PluginRegistry();
    reg.use(mk("one", log));
    reg.use(mk("two", log));
    reg.runBeforeCall("pay", {} as any);
    reg.runAfterCall("pay", { txHash: "h" });
    reg.runOnError("pay", new Error("x"));
    expect(log).toEqual([
      "before:one", "before:two",
      "after:two", "after:one",
      "error:two", "error:one",
    ]);
  });

  it("threads modified args through the chain and keeps args when a plugin returns undefined", () => {
    const reg = new PluginRegistry();
    reg.use({ name: "p1", beforeCall: (_m, a: any) => ({ ...a, p1: true }) });
    reg.use({ name: "p2", beforeCall: () => undefined as any });
    reg.use({ name: "p3", beforeCall: (_m, a: any) => ({ ...a, p3: true }) });
    expect(reg.runBeforeCall("pay", {} as any)).toEqual({ p1: true, p3: true });
  });

  it("rejects duplicate plugin names and supports removal", () => {
    const reg = new PluginRegistry();
    reg.use({ name: "dup" });
    expect(() => reg.use({ name: "dup" })).toThrow();
    reg.removePlugin("dup");
    expect(reg.getPlugins()).toEqual([]);
  });
});
