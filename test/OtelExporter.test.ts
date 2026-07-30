import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { StrKey, Keypair } from "@stellar/stellar-sdk";
import { trace, metrics, SpanStatusCode } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { MeterProvider, MetricReader } from "@opentelemetry/sdk-metrics";
import { StellarSplitClient } from "../src/client.js";
import { OtelExporter, noopOtelHandle } from "../src/telemetry/OtelExporter.js";

/** Minimal pull-based reader so tests can synchronously `collect()` recorded metrics. */
class TestMetricReader extends MetricReader {
  protected async onForceFlush(): Promise<void> {}
  protected async onShutdown(): Promise<void> {}
}

function makeClient(otel: { enabled: boolean; exporterUrl?: string; serviceName?: string } | undefined) {
  return new StellarSplitClient({
    rpcUrl: "https://example.com",
    networkPassphrase: "Test Network",
    contractId: StrKey.encodeContract(Keypair.random().rawPublicKey()),
    validatePassphrase: false,
    ...(otel ? { otel } : {}),
  });
}

function findMetric(collection: Awaited<ReturnType<MetricReader["collect"]>>, name: string) {
  for (const scopeMetrics of collection.resourceMetrics.scopeMetrics) {
    for (const metric of scopeMetrics.metrics) {
      if (metric.descriptor.name === name) return metric;
    }
  }
  return undefined;
}

describe("OpenTelemetry instrumentation", () => {
  let memoryExporter: InMemorySpanExporter;
  let tracerProvider: BasicTracerProvider;
  let meterProvider: MeterProvider;
  let metricReader: TestMetricReader;

  beforeEach(() => {
    memoryExporter = new InMemorySpanExporter();
    tracerProvider = new BasicTracerProvider();
    tracerProvider.addSpanProcessor(new SimpleSpanProcessor(memoryExporter));
    tracerProvider.register();

    metricReader = new TestMetricReader();
    meterProvider = new MeterProvider({ readers: [metricReader] });
    metrics.setGlobalMeterProvider(meterProvider);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    memoryExporter.reset();
    await tracerProvider.shutdown();
    await meterProvider.shutdown();
    // Reset global providers so other test files (and other tests in this
    // file) don't see stale providers from a previous test.
    trace.disable();
    metrics.disable();
  });

  describe("disabled by default (zero overhead)", () => {
    it("never wraps prototype methods and stays on the no-op handle", () => {
      const client = makeClient(undefined);
      expect((client as any)._otel).toBe(noopOtelHandle);
      // No instrumentation => getInvoice is still the plain prototype method,
      // not an own-instance wrapper function.
      expect(Object.prototype.hasOwnProperty.call(client, "getInvoice")).toBe(false);
    });

    it("client.ts and OtelExporter.ts never statically import @opentelemetry/api", () => {
      const clientSrc = readFileSync(join(process.cwd(), "src/client.ts"), "utf8");
      const otelSrc = readFileSync(join(process.cwd(), "src/telemetry/OtelExporter.ts"), "utf8");
      const staticImportPattern = /^\s*import\s+(?:type\s+)?(?:[\w*{}\s,]+)\s+from\s+["']@opentelemetry\/api["']/m;
      expect(staticImportPattern.test(clientSrc)).toBe(false);
      expect(staticImportPattern.test(otelSrc)).toBe(false);
    });
  });

  describe("enabled: spans", () => {
    it("wraps public methods (own-instance property) once enabled", () => {
      const client = makeClient({ enabled: true });
      expect(Object.prototype.hasOwnProperty.call(client, "getInvoice")).toBe(true);
    });

    it("produces a span with correct attributes on a happy-path call", async () => {
      const client = makeClient({ enabled: true, serviceName: "test-service" });
      const invoice = {
        id: "invoice-42",
        creator: "GCREATORXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        recipients: [],
        token: "GUSDCXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX",
        deadline: 1_700_000_000,
        funded: 0n,
        status: "Pending" as const,
        payments: [],
      };
      vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue(invoice);

      const result = await client.getInvoice("invoice-42");
      expect(result).toEqual(invoice);

      const spans = memoryExporter.getFinishedSpans();
      const span = spans.find((s) => s.name === "getInvoice");
      expect(span).toBeDefined();
      expect(span!.attributes["stellar.network"]).toBe("Test Network");
      expect(span!.attributes["rpc.url"]).toBe("https://example.com");
      expect(span!.attributes["invoice.id"]).toBe("invoice-42");
      expect(typeof span!.attributes["rpc.duration_ms"]).toBe("number");
      expect(span!.status.code).toBe(SpanStatusCode.UNSET);
    });

    it("sets span status ERROR with the error message when the call throws", async () => {
      const client = makeClient({ enabled: true });
      vi.spyOn(client as any, "_fetchInvoice").mockRejectedValue(new Error("rpc unreachable"));

      await expect(client.getInvoice("bad-id")).rejects.toThrow("rpc unreachable");

      const span = memoryExporter.getFinishedSpans().find((s) => s.name === "getInvoice");
      expect(span).toBeDefined();
      expect(span!.status.code).toBe(SpanStatusCode.ERROR);
      expect(span!.status.message).toBe("rpc unreachable");
    });

    it("captures tx.hash when the resolved value carries one", async () => {
      const client = makeClient({ enabled: true });
      // Simulates any SplitClient method resolving a TxResult-shaped value;
      // getInvoice is used here purely as a convenient instrumented method to
      // drive the generic tx.hash-extraction path.
      vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue({ txHash: "abc123" } as any);

      await client.getInvoice("invoice-1");

      const span = memoryExporter.getFinishedSpans().find((s) => s.name === "getInvoice");
      expect(span!.attributes["tx.hash"]).toBe("abc123");
    });

    it("preserves the return type/signature of synchronous public methods", () => {
      const client = makeClient({ enabled: true });
      const endpoint = client.getSSEEndpoint("/invoices/1");
      expect(typeof endpoint).toBe("string");
    });
  });

  describe("enabled: metrics", () => {
    it("records rpc_call.count and rpc_call.duration on a happy-path call", async () => {
      const client = makeClient({ enabled: true, serviceName: "metrics-test" });
      vi.spyOn(client as any, "_fetchInvoice").mockResolvedValue({
        id: "1",
        recipients: [],
        payments: [],
        status: "Pending",
      } as any);

      await client.getInvoice("1");

      const collection = await metricReader.collect();
      const count = findMetric(collection, "split_sdk.rpc_call.count");
      const duration = findMetric(collection, "split_sdk.rpc_call.duration");
      expect(count).toBeDefined();
      expect(duration).toBeDefined();
      expect(count!.dataPoints.some((dp: any) => dp.value === 1 && dp.attributes.method === "getInvoice")).toBe(
        true,
      );
      expect(duration!.dataPoints.length).toBeGreaterThan(0);
    });

    it("additionally records tx.error.count on an error-path call", async () => {
      const client = makeClient({ enabled: true, serviceName: "metrics-error-test" });
      vi.spyOn(client as any, "_fetchInvoice").mockRejectedValue(new Error("boom"));

      await expect(client.getInvoice("1")).rejects.toThrow("boom");

      const collection = await metricReader.collect();
      const count = findMetric(collection, "split_sdk.rpc_call.count");
      const errorCount = findMetric(collection, "split_sdk.tx.error.count");
      expect(count).toBeDefined();
      expect(errorCount).toBeDefined();
      expect(errorCount!.dataPoints.some((dp: any) => dp.value === 1 && dp.attributes.method === "getInvoice")).toBe(
        true,
      );
    });
  });
});

describe("OtelExporter OTLP/HTTP payload shape", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("POSTs an OTLP-shaped JSON payload to the configured collector URL", async () => {
    const captured: { url: string; body: string; headers: Record<string, string> }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (url: string, init: RequestInit) => {
        captured.push({
          url,
          body: init.body as string,
          headers: init.headers as Record<string, string>,
        });
        return new Response(null, { status: 200 });
      }),
    );

    const exporter = new OtelExporter({ exporterUrl: "http://mock-collector:4318/v1/traces", serviceName: "otlp-test" });
    // toOtlpPayload() is exercised directly for a deterministic shape check.
    const payload = exporter.toOtlpPayload([
      {
        name: "pay",
        startTimeMs: 1_000,
        endTimeMs: 1_050,
        attributes: { "stellar.network": "Test Network", "rpc.duration_ms": 50 },
        statusCode: "OK",
      },
    ] as any);

    expect(payload.resourceSpans).toHaveLength(1);
    const resourceSpan = payload.resourceSpans[0]!;
    expect(resourceSpan.resource.attributes).toEqual([{ key: "service.name", value: { stringValue: "otlp-test" } }]);
    const span = resourceSpan.scopeSpans[0]!.spans[0]!;
    expect(span.name).toBe("pay");
    expect(span.startTimeUnixNano).toBe(String(1_000 * 1_000_000));
    expect(span.endTimeUnixNano).toBe(String(1_050 * 1_000_000));
    expect(span.attributes).toEqual(
      expect.arrayContaining([
        { key: "stellar.network", value: { stringValue: "Test Network" } },
        { key: "rpc.duration_ms", value: { intValue: "50" } },
      ]),
    );
    expect(span.status.code).toBe(1); // OK

    // exportSpans() actually POSTs that same shape via fetch.
    await exporter.exportSpans([
      {
        name: "pay",
        startTimeMs: 1_000,
        endTimeMs: 1_050,
        attributes: {},
        statusCode: "OK",
      },
    ] as any);

    expect(captured).toHaveLength(1);
    expect(captured[0]!.url).toBe("http://mock-collector:4318/v1/traces");
    expect(captured[0]!.headers).toMatchObject({ "content-type": "application/json" });
    const sentPayload = JSON.parse(captured[0]!.body);
    expect(sentPayload.resourceSpans[0].scopeSpans[0].spans[0].name).toBe("pay");
  });

  it("swallows exporter/network failures instead of throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new Error("ECONNREFUSED");
      }),
    );
    const exporter = new OtelExporter({ exporterUrl: "http://unreachable:4318/v1/traces" });
    await expect(
      exporter.exportSpans([{ name: "x", startTimeMs: 0, endTimeMs: 1, attributes: {}, statusCode: "OK" } as any]),
    ).resolves.toBeUndefined();
  });
});
