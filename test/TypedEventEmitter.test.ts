import { describe, it, expect, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { TypedEventEmitter, AbortError } from "../src/events/TypedEventEmitter.js";

interface TestEvents {
  greeting: { name: string };
  ping: undefined;
}

describe("TypedEventEmitter", () => {
  it("invokes handlers registered via on() with the emitted payload", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const handler = vi.fn();
    emitter.on("greeting", handler);
    emitter.emit("greeting", { name: "Ada" });
    expect(handler).toHaveBeenCalledWith({ name: "Ada" });
  });

  it("invokes multiple handlers for the same event", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const a = vi.fn();
    const b = vi.fn();
    emitter.on("greeting", a);
    emitter.on("greeting", b);
    emitter.emit("greeting", { name: "Grace" });
    expect(a).toHaveBeenCalledTimes(1);
    expect(b).toHaveBeenCalledTimes(1);
  });

  it("stops delivering events after the on() unsubscribe function is called", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const handler = vi.fn();
    const unsubscribe = emitter.on("greeting", handler);
    unsubscribe();
    emitter.emit("greeting", { name: "Ada" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("stops delivering events after off() is called", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    const handler = vi.fn();
    emitter.on("greeting", handler);
    emitter.off("greeting", handler);
    emitter.emit("greeting", { name: "Ada" });
    expect(handler).not.toHaveBeenCalled();
  });

  it("off() on a handler that was never registered is a no-op", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    expect(() => emitter.off("greeting", vi.fn())).not.toThrow();
  });

  it("emit() with no listeners is a no-op", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    expect(() => emitter.emit("ping", undefined)).not.toThrow();
  });

  it("listenerCount() reflects registered/unregistered handlers", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    expect(emitter.listenerCount("greeting")).toBe(0);
    const unsubscribe = emitter.on("greeting", vi.fn());
    expect(emitter.listenerCount("greeting")).toBe(1);
    unsubscribe();
    expect(emitter.listenerCount("greeting")).toBe(0);
  });

  it("removeAllListeners(event) clears only that event's handlers", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    emitter.on("greeting", vi.fn());
    emitter.on("ping", vi.fn());
    emitter.removeAllListeners("greeting");
    expect(emitter.listenerCount("greeting")).toBe(0);
    expect(emitter.listenerCount("ping")).toBe(1);
  });

  it("removeAllListeners() with no argument clears every event", () => {
    const emitter = new TypedEventEmitter<TestEvents>();
    emitter.on("greeting", vi.fn());
    emitter.on("ping", vi.fn());
    emitter.removeAllListeners();
    expect(emitter.listenerCount("greeting")).toBe(0);
    expect(emitter.listenerCount("ping")).toBe(0);
  });

  describe("once()", () => {
    it("resolves with the payload of the next emission", async () => {
      const emitter = new TypedEventEmitter<TestEvents>();
      const promise = emitter.once("greeting");
      emitter.emit("greeting", { name: "Ada" });
      await expect(promise).resolves.toEqual({ name: "Ada" });
    });

    it("only resolves once, ignoring subsequent emissions", async () => {
      const emitter = new TypedEventEmitter<TestEvents>();
      const promise = emitter.once("greeting");
      emitter.emit("greeting", { name: "first" });
      emitter.emit("greeting", { name: "second" });
      await expect(promise).resolves.toEqual({ name: "first" });
      expect(emitter.listenerCount("greeting")).toBe(0);
    });

    it("rejects with an AbortError when the signal fires before emission", async () => {
      const emitter = new TypedEventEmitter<TestEvents>();
      const controller = new AbortController();
      const promise = emitter.once("greeting", controller.signal);
      controller.abort();
      await expect(promise).rejects.toBeInstanceOf(AbortError);
      expect(emitter.listenerCount("greeting")).toBe(0);
    });

    it("rejects immediately when the signal is already aborted", async () => {
      const emitter = new TypedEventEmitter<TestEvents>();
      const controller = new AbortController();
      controller.abort();
      const promise = emitter.once("greeting", controller.signal);
      await expect(promise).rejects.toBeInstanceOf(AbortError);
    });

    it("does not reject if the signal fires after resolution", async () => {
      const emitter = new TypedEventEmitter<TestEvents>();
      const controller = new AbortController();
      const promise = emitter.once("greeting", controller.signal);
      emitter.emit("greeting", { name: "Ada" });
      controller.abort();
      await expect(promise).resolves.toEqual({ name: "Ada" });
    });
  });

  it("works in a browser (jsdom) global context with no Node events dependency", () => {
    expect(typeof window).toBe("object");
    const emitter = new TypedEventEmitter<TestEvents>();
    const handler = vi.fn();
    emitter.on("greeting", handler);
    emitter.emit("greeting", { name: "Browser" });
    expect(handler).toHaveBeenCalledWith({ name: "Browser" });
  });

  it("source does not import Node's events module", () => {
    const path = resolve(process.cwd(), "src/events/TypedEventEmitter.ts");
    const source = readFileSync(path, "utf8");
    expect(source).not.toMatch(/from\s+["']node:events["']/);
    expect(source).not.toMatch(/from\s+["']events["']/);
    expect(source).not.toMatch(/require\(["']events["']\)/);
  });
});
