import { describe, it, expect, vi } from "vitest";
import {
  PluginRegistry,
  MetricsPlugin,
  type SdkPlugin,
  type StellarSplitClientContext,
} from "../src/plugin.js";
import { PluginAlreadyRegisteredError } from "../src/errors.js";

const createParams = { creator: "G1" } as never;
const result = { invoiceId: "inv-1", txHash: "tx-1" };

function makeContext(): StellarSplitClientContext {
  return { on: vi.fn(() => () => {}), off: vi.fn() };
}

describe("plugin loading", () => {
  it("rejects duplicate names with PluginAlreadyRegisteredError", () => {
    const r = new PluginRegistry();
    r.use({ name: "a" });
    expect(() => r.use({ name: "a" })).toThrow(PluginAlreadyRegisteredError);
  });

  it("does not call install before a client context is set", () => {
    const install = vi.fn();
    new PluginRegistry().use({ name: "a", install });
    expect(install).not.toHaveBeenCalled();
  });

  it("installs immediately with context and options once context is set", () => {
    const r = new PluginRegistry();
    const ctx = makeContext();
    r.setClientContext(ctx);
    const install = vi.fn();
    r.use({ name: "a", install }, { level: "debug" });
    expect(install).toHaveBeenCalledWith(ctx, { level: "debug" });
  });
});

describe("plugin lifecycle", () => {
  it("removePlugin unregisters, stops hooks, and allows re-registration", () => {
    const r = new PluginRegistry();
    const beforeCall = vi.fn((_m, a) => a);
    r.use({ name: "a", beforeCall });
    r.removePlugin("a");
    expect(r.getPlugins()).toEqual([]);
    r.runBeforeCall("createInvoice", createParams);
    expect(beforeCall).not.toHaveBeenCalled();
    expect(() => r.use({ name: "a" })).not.toThrow();
  });

  it("removePlugin on unknown name is a no-op", () => {
    const r = new PluginRegistry();
    r.use({ name: "a" });
    r.removePlugin("missing");
    expect(r.getPlugins()).toEqual(["a"]);
  });
});

describe("plugin composition", () => {
  it("runs beforeCall in registration order and afterCall in reverse", () => {
    const r = new PluginRegistry();
    const order: string[] = [];
    for (const name of ["a", "b", "c"]) {
      r.use({
        name,
        beforeCall: (_m, args) => (order.push(`before:${name}`), args),
        afterCall: (_m, res) => (order.push(`after:${name}`), res),
      });
    }
    r.runBeforeCall("createInvoice", createParams);
    r.runAfterCall("createInvoice", result);
    expect(order).toEqual([
      "before:a", "before:b", "before:c",
      "after:c", "after:b", "after:a",
    ]);
  });

  it("pipes each plugin's output into the next", () => {
    const r = new PluginRegistry();
    r.use({ name: "a", afterCall: (_m, res) => ({ ...res, txHash: res.txHash + "-a" }) as never });
    r.use({ name: "b", afterCall: (_m, res) => ({ ...res, txHash: res.txHash + "-b" }) as never });
    // reverse order: b then a
    expect(r.runAfterCall("pay", { txHash: "t" })).toEqual({ txHash: "t-b-a" });
  });

  it("keeps the current value when a hook returns undefined", () => {
    const r = new PluginRegistry();
    r.use({ name: "a", beforeCall: (() => undefined) as never });
    expect(r.runBeforeCall("createInvoice", createParams)).toBe(createParams);
  });

  it("runs onError on all plugins in reverse order, skipping those without it", () => {
    const r = new PluginRegistry();
    const calls: string[] = [];
    r.use({ name: "a", onError: () => void calls.push("a") });
    r.use({ name: "b" });
    r.use({ name: "c", onError: () => void calls.push("c") });
    const err = new Error("boom");
    r.runOnError("pay", err);
    expect(calls).toEqual(["c", "a"]);
  });
});

describe("plugin isolation", () => {
  it("separate registries do not share plugins", () => {
    const r1 = new PluginRegistry();
    const r2 = new PluginRegistry();
    r1.use({ name: "a" });
    expect(r2.getPlugins()).toEqual([]);
    expect(() => r2.use({ name: "a" })).not.toThrow();
  });

  it("separate MetricsPlugin instances keep independent counts", () => {
    const m1 = new MetricsPlugin();
    const m2 = new MetricsPlugin();
    m1.afterCall("pay", { txHash: "t" });
    m1.afterCall("pay", { txHash: "t" });
    m2.afterCall("createInvoice", result);
    expect(m1.getMetrics()).toEqual({ pay: 2 });
    expect(m2.getMetrics()).toEqual({ createInvoice: 1 });
    m1.resetMetrics();
    expect(m1.getMetrics()).toEqual({});
    expect(m2.getMetrics()).toEqual({ createInvoice: 1 });
  });

  it("getPlugins returns a copy that cannot mutate the registry", () => {
    const r = new PluginRegistry();
    r.use({ name: "a" });
    r.getPlugins().push("x");
    expect(r.getPlugins()).toEqual(["a"]);
  });
});

describe("plugin error handling", () => {
  it("propagates errors thrown by a beforeCall hook", () => {
    const r = new PluginRegistry();
    r.use({ name: "bad", beforeCall: () => { throw new Error("nope"); } } as SdkPlugin);
    expect(() => r.runBeforeCall("pay", {} as never)).toThrow("nope");
  });

  it("propagates errors thrown by an install hook", () => {
    const r = new PluginRegistry();
    r.setClientContext(makeContext());
    expect(() =>
      r.use({ name: "bad", install: () => { throw new Error("install failed"); } }),
    ).toThrow("install failed");
  });
});
