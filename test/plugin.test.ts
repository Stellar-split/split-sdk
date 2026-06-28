import { describe, it, expect, vi } from "vitest";
import { PluginRegistry, LoggingPlugin } from "../src/plugin.js";

describe("PluginRegistry", () => {
  it("registers and lists plugins", () => {
    const r = new PluginRegistry();
    r.use({ name: "a" });
    r.use({ name: "b" });
    expect(r.getPlugins()).toEqual(["a", "b"]);
  });

  it("throws on duplicate registration", () => {
    const r = new PluginRegistry();
    r.use({ name: "a" });
    expect(() => r.use({ name: "a" })).toThrow("already registered");
  });

  it("removePlugin deregisters by name", () => {
    const r = new PluginRegistry();
    r.use({ name: "a" });
    r.use({ name: "b" });
    r.removePlugin("a");
    expect(r.getPlugins()).toEqual(["b"]);
  });

  it("removePlugin is a no-op for unknown name", () => {
    const r = new PluginRegistry();
    expect(() => r.removePlugin("nope")).not.toThrow();
  });

  it("getPlugins() returns empty array initially", () => {
    const r = new PluginRegistry();
    expect(r.getPlugins()).toEqual([]);
  });

  it("beforeCall applied in registration order", () => {
    const r = new PluginRegistry();
    const order: string[] = [];
    r.use({ name: "first", beforeCall: (_m, a) => { order.push("first"); return a; } });
    r.use({ name: "second", beforeCall: (_m, a) => { order.push("second"); return a; } });
    r.runBeforeCall("pay", { payer: "G", invoiceId: "1", amount: 100n });
    expect(order).toEqual(["first", "second"]);
  });

  it("afterCall applied in reverse registration order", () => {
    const r = new PluginRegistry();
    const order: string[] = [];
    r.use({ name: "first", afterCall: (_m, res) => { order.push("first"); return res; } });
    r.use({ name: "second", afterCall: (_m, res) => { order.push("second"); return res; } });
    r.runAfterCall("pay", { txHash: "abc" });
    expect(order).toEqual(["second", "first"]);
  });

  it("onError called in reverse order", () => {
    const r = new PluginRegistry();
    const order: string[] = [];
    r.use({ name: "a", onError: () => order.push("a") });
    r.use({ name: "b", onError: () => order.push("b") });
    r.runOnError("pay", new Error("boom"));
    expect(order).toEqual(["b", "a"]);
  });

  it("beforeCall can transform args", () => {
    const r = new PluginRegistry();
    r.use({
      name: "mutate",
      beforeCall: (_m, args) => ({ ...args, payer: "MODIFIED" }),
    });
    const result = r.runBeforeCall("pay", { payer: "original", invoiceId: "1", amount: 1n });
    expect(result.payer).toBe("MODIFIED");
  });

  it("afterCall can transform result", () => {
    const r = new PluginRegistry();
    r.use({
      name: "mutate",
      afterCall: (_m, res) => ({ ...res, txHash: "override" }),
    });
    const result = r.runAfterCall("pay", { txHash: "original" });
    expect(result.txHash).toBe("override");
  });

  it("plugins removed after removePlugin no longer run", () => {
    const r = new PluginRegistry();
    const calls: string[] = [];
    r.use({ name: "tracked", beforeCall: (_m, a) => { calls.push("tracked"); return a; } });
    r.removePlugin("tracked");
    r.runBeforeCall("pay", { payer: "G", invoiceId: "1", amount: 1n });
    expect(calls).toEqual([]);
  });
});

describe("LoggingPlugin", () => {
  it("has name LoggingPlugin", () => {
    expect(LoggingPlugin.name).toBe("LoggingPlugin");
  });

  it("logs on beforeCall", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    LoggingPlugin.beforeCall!("pay", { payer: "G", invoiceId: "1", amount: 1n });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("logs on afterCall", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    LoggingPlugin.afterCall!("pay", { txHash: "abc" });
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("logs on onError", () => {
    const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
    LoggingPlugin.onError!("pay", new Error("oops"));
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });

  it("can be registered in a registry without duplicate error", () => {
    const r = new PluginRegistry();
    expect(() => r.use(LoggingPlugin)).not.toThrow();
    expect(r.getPlugins()).toContain("LoggingPlugin");
  });
});
