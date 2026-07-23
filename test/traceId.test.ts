import { describe, it, expect, vi } from "vitest";
import { TraceIdManager, globalTraceIdManager } from "../src/traceId.js";

const UUID_V4_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

describe("TraceIdManager", () => {
  it("generates UUID v4 by default", () => {
    const mgr = new TraceIdManager();
    const id = mgr.generate();
    expect(id).toMatch(UUID_V4_RE);
  });

  it("generates unique IDs on each call", () => {
    const mgr = new TraceIdManager();
    const ids = new Set(Array.from({ length: 20 }, () => mgr.generate()));
    expect(ids.size).toBe(20);
  });

  it("uses a custom generator after setGenerator()", () => {
    const mgr = new TraceIdManager();
    mgr.setGenerator(() => "custom-trace-001");
    expect(mgr.generate()).toBe("custom-trace-001");
  });

  it("reverts to the custom generator, not the original", () => {
    const mgr = new TraceIdManager();
    let counter = 0;
    mgr.setGenerator(() => `span-${++counter}`);
    expect(mgr.generate()).toBe("span-1");
    expect(mgr.generate()).toBe("span-2");
  });
});

describe("globalTraceIdManager", () => {
  it("is a shared singleton", () => {
    expect(globalTraceIdManager).toBeInstanceOf(TraceIdManager);
  });

  it("generates valid UUIDs", () => {
    expect(globalTraceIdManager.generate()).toMatch(UUID_V4_RE);
  });
});

describe("StellarSplitClient traceId integration", () => {
  it("telemetry hooks receive traceId on call start and end", async () => {
    // Import lazily to avoid real network in constructor
    const { TelemetryHookManager } = await import("../src/telemetryHooks.js");
    const mgr = new TelemetryHookManager();

    const starts: string[] = [];
    const ends: string[] = [];

    mgr.setHooks({
      onCallStart: (p) => { if (p.traceId) starts.push(p.traceId); },
      onCallEnd: (p) => { if (p.traceId) ends.push(p.traceId); },
    });

    // Fire hooks directly to verify traceId propagation
    const traceId = "test-trace-id-abc";
    mgr.fireOnCallStart({ method: "getInvoice", timestamp: Date.now(), traceId });
    mgr.fireOnCallEnd({ method: "getInvoice", durationMs: 10, success: true, timestamp: Date.now(), traceId });

    expect(starts).toContain(traceId);
    expect(ends).toContain(traceId);
  });

  it("onError hook receives traceId", async () => {
    const { TelemetryHookManager } = await import("../src/telemetryHooks.js");
    const { StellarSplitError } = await import("../src/errors.js");
    const mgr = new TelemetryHookManager();

    const errorTraceIds: string[] = [];
    mgr.setHooks({
      onError: (_err, ctx) => { if (ctx.traceId) errorTraceIds.push(ctx.traceId); },
    });

    const err = new StellarSplitError("test");
    mgr.fireOnError(err, { method: "pay", timestamp: Date.now(), traceId: "err-trace-xyz" });

    expect(errorTraceIds).toContain("err-trace-xyz");
  });
});
