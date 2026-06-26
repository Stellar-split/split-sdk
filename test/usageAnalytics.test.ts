import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  UsageAnalyticsCollector,
  wrapWithAnalytics,
} from "../src/usageAnalytics.js";

// Minimal stub that mimics the shape of StellarSplitClient
const makeStub = () => ({
  getInvoice: vi.fn().mockResolvedValue({}),
  pay: vi.fn().mockResolvedValue({}),
  createInvoice: vi.fn().mockResolvedValue({}),
});

beforeEach(() => {
  vi.restoreAllMocks();
});

describe("usageAnalytics – opt-in guard", () => {
  it("records nothing when enabled is false", async () => {
    const stub = makeStub();
    const { proxy, collector } = wrapWithAnalytics(
      stub,
      { usageAnalytics: { enabled: false } }
    );

    await proxy.getInvoice("1");
    await proxy.pay({ payer: "", invoiceId: "1", amount: 0n });

    expect(collector.getCounts()).toEqual({});
  });

  it("returns the original instance unchanged when disabled", () => {
    const stub = makeStub();
    const { proxy } = wrapWithAnalytics(stub, { usageAnalytics: { enabled: false } });
    expect(proxy).toBe(stub);
  });
});

describe("usageAnalytics – mathematical accuracy", () => {
  it("increments counters exactly once per call", async () => {
    const stub = makeStub();
    const { proxy, collector } = wrapWithAnalytics(
      stub,
      { usageAnalytics: { enabled: true } }
    );

    await proxy.getInvoice("1");
    await proxy.getInvoice("2");
    await proxy.getInvoice("3");
    await proxy.pay({ payer: "", invoiceId: "1", amount: 0n });

    const counts = collector.getCounts();
    expect(counts["getInvoice"]).toBe(3);
    expect(counts["pay"]).toBe(1);
  });

  it("counts multiple distinct methods independently", async () => {
    const stub = makeStub();
    const { proxy, collector } = wrapWithAnalytics(
      stub,
      { usageAnalytics: { enabled: true } }
    );

    await proxy.createInvoice({} as never);
    await proxy.createInvoice({} as never);
    await proxy.pay({} as never);

    const counts = collector.getCounts();
    expect(counts["createInvoice"]).toBe(2);
    expect(counts["pay"]).toBe(1);
  });
});

describe("usageAnalytics – flush / state reset", () => {
  it("flush resets all counters to zero", async () => {
    const collector = new UsageAnalyticsCollector({ enabled: true });
    collector.record("getInvoice");
    collector.record("getInvoice");
    collector.record("pay");

    await collector.flush();

    expect(collector.getCounts()).toEqual({});
  });

  it("counters restart from zero after flush", async () => {
    const collector = new UsageAnalyticsCollector({ enabled: true });
    collector.record("pay");
    await collector.flush();

    collector.record("pay");
    expect(collector.getCounts()["pay"]).toBe(1);
  });

  it("flush POSTs snapshot before clearing when endpoint configured", async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", mockFetch);

    const collector = new UsageAnalyticsCollector({
      enabled: true,
      endpoint: "https://analytics.example.com/ingest",
    });
    collector.record("getInvoice");
    await collector.flush();

    expect(mockFetch).toHaveBeenCalledWith(
      "https://analytics.example.com/ingest",
      expect.objectContaining({ method: "POST" })
    );
    expect(collector.getCounts()).toEqual({});
  });

  it("flush is a no-op when disabled", async () => {
    const mockFetch = vi.fn();
    vi.stubGlobal("fetch", mockFetch);

    const collector = new UsageAnalyticsCollector({ enabled: false });
    collector.record("getInvoice"); // should do nothing
    await collector.flush();

    expect(mockFetch).not.toHaveBeenCalled();
    expect(collector.getCounts()).toEqual({});
  });
});
