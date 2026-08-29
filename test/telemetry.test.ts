import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { telemetry } from "../src/telemetry.js";
import type { TelemetryEvent } from "../src/telemetry.js";

// === Test access to the singleton's internal buffer ===

interface TelemetryInternals {
  events: TelemetryEvent[];
  spanStack: string[];
}

function internals(): TelemetryInternals {
  return telemetry as unknown as TelemetryInternals;
}

function recorded(): TelemetryEvent[] {
  return internals().events;
}

describe("Telemetry parent span context", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(null, { status: 204 }));
    telemetry.init({ endpoint: "https://telemetry.example.org", optOut: false });
    internals().events = [];
    internals().spanStack = [];
  });

  afterEach(() => {
    telemetry.destroy();
    vi.restoreAllMocks();
  });

  it("stamps parentSpanId: undefined for events emitted outside any span", () => {
    telemetry.recordMethod("getInvoice", true, 12);
    expect(recorded()).toHaveLength(1);
    expect(recorded()[0].parentSpanId).toBeUndefined();
  });

  it("inherits the active span ID for events emitted inside runInSpan", () => {
    telemetry.runInSpan("span-abc", () => {
      telemetry.recordMethod("pay", true, 30);
    });
    expect(recorded()[0].parentSpanId).toBe("span-abc");
  });

  it("inherits the innermost span ID when spans are nested", () => {
    telemetry.runInSpan("outer", () => {
      telemetry.recordMethod("a", true, 1);
      telemetry.runInSpan("inner", () => {
        telemetry.recordMethod("b", true, 1);
      });
      telemetry.recordMethod("c", true, 1);
    });
    const byMethod = Object.fromEntries(recorded().map((e) => [e.method, e.parentSpanId]));
    expect(byMethod).toEqual({ a: "outer", b: "inner", c: "outer" });
  });

  it("restores the previous span even when the callback throws", () => {
    expect(() =>
      telemetry.runInSpan("boom", () => {
        throw new Error("kaboom");
      }),
    ).toThrow("kaboom");
    telemetry.recordMethod("after", true, 1);
    expect(recorded()[0].parentSpanId).toBeUndefined();
  });

  it("ends an async span only after the promise settles", async () => {
    let resolveInner: () => void = () => {};
    const gate = new Promise<void>((r) => {
      resolveInner = r;
    });

    const pending = telemetry.runInSpan("async-span", async () => {
      await gate;
      telemetry.recordMethod("late", true, 5);
    });

    resolveInner();
    await pending;

    expect(recorded()[0].parentSpanId).toBe("async-span");
    expect(internals().spanStack).toHaveLength(0);
  });

  it("startSpan/endSpan explicitly bracket a span", () => {
    telemetry.startSpan("manual");
    telemetry.recordMethod("during", true, 2);
    telemetry.endSpan("manual");
    telemetry.recordMethod("outside", true, 2);

    expect(recorded()[0].parentSpanId).toBe("manual");
    expect(recorded()[1].parentSpanId).toBeUndefined();
  });

  it("does not record at all when opted out", () => {
    telemetry.destroy();
    telemetry.init({ endpoint: "https://telemetry.example.org", optOut: true });
    telemetry.runInSpan("span-x", () => {
      telemetry.recordMethod("pay", true, 30);
    });
    expect(recorded()).toHaveLength(0);
  });
});
