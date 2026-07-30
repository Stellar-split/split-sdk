/**
 * OpenTelemetry integration for {@link StellarSplitClient}.
 *
 * This module never imports `@opentelemetry/api` -- not even a type-only
 * import -- so neither `tsc` nor `tsup`'s declaration-file generation ever
 * needs to resolve it. The only touch point is the dynamic `import(...)`
 * inside {@link createOtelHandle}, which is (a) only ever invoked when a
 * consumer explicitly turns telemetry on (`otel: { enabled: true }`), and
 * (b) built from a non-literal specifier so TypeScript treats its result as
 * `any` instead of statically resolving `@opentelemetry/api`'s types --
 * otherwise `import("@opentelemetry/api")` with a literal string specifier
 * would force every build (even with telemetry disabled) to require the
 * package's type declarations to be installed. Consumers who don't opt in
 * never need `@opentelemetry/api` installed, and pay zero runtime cost: no
 * span objects are created, no dynamic import is triggered.
 */

/** Local stand-in for `@opentelemetry/api`'s `Attributes` type, so this file never needs that package's types. */
export type OtelAttributes = Record<string, string | number | boolean>;

/** Configuration accepted by {@link StellarSplitClientConfig.otel}. */
export interface TelemetryOptions {
  /** Turn instrumentation on. Defaults to false (fully disabled, zero overhead). */
  enabled: boolean;
  /** Optional OTLP/HTTP collector URL. When set, spans are also POSTed here directly. */
  exporterUrl?: string;
  /** Reported as the `service.name` resource attribute / OTel tracer & meter name. */
  serviceName?: string;
}

/** A single active span, as seen by SDK instrumentation code. */
export interface OtelSpanHandle {
  setAttribute(key: string, value: string | number | boolean): void;
  /** Records the error on the span and sets its status to ERROR with the error's message. */
  recordError(error: unknown): void;
  end(): void;
}

/** The tracer/meter facade instrumentation code talks to -- real or no-op. */
export interface OtelHandle {
  startSpan(name: string): OtelSpanHandle;
  recordRpcCall(durationMs: number, attributes: OtelAttributes): void;
  recordTxError(attributes: OtelAttributes): void;
}

const noopSpan: OtelSpanHandle = {
  setAttribute() {
    /* no-op */
  },
  recordError() {
    /* no-op */
  },
  end() {
    /* no-op */
  },
};

/**
 * Zero-overhead handle used whenever telemetry is disabled, or while a real
 * handle is still being lazily initialized. Creates no span objects and
 * performs no work.
 */
export const noopOtelHandle: OtelHandle = {
  startSpan: () => noopSpan,
  recordRpcCall() {
    /* no-op */
  },
  recordTxError() {
    /* no-op */
  },
};

interface SpanRecord {
  name: string;
  startTimeMs: number;
  endTimeMs: number;
  attributes: Record<string, string | number | boolean>;
  statusCode: "OK" | "ERROR";
  statusMessage?: string;
}

interface OtlpAttributeValue {
  stringValue?: string;
  boolValue?: boolean;
  intValue?: string;
  doubleValue?: number;
}

/** Shape of the OTLP/HTTP JSON trace export payload produced by {@link OtelExporter}. */
export interface OtlpTracePayload {
  resourceSpans: Array<{
    resource: { attributes: Array<{ key: string; value: OtlpAttributeValue }> };
    scopeSpans: Array<{
      scope: { name: string };
      spans: Array<{
        name: string;
        startTimeUnixNano: string;
        endTimeUnixNano: string;
        attributes: Array<{ key: string; value: OtlpAttributeValue }>;
        status: { code: number; message?: string };
      }>;
    }>;
  }>;
}

function otlpAttributeValue(value: string | number | boolean): OtlpAttributeValue {
  if (typeof value === "string") return { stringValue: value };
  if (typeof value === "boolean") return { boolValue: value };
  if (Number.isInteger(value)) return { intValue: String(value) };
  return { doubleValue: value };
}

/** OTLP span status codes (subset of the `Status.StatusCode` enum). */
const OTLP_STATUS_UNSET = 0;
const OTLP_STATUS_OK = 1;
const OTLP_STATUS_ERROR = 2;

/**
 * Minimal OTLP/HTTP JSON span exporter, hand-rolled instead of depending on
 * `@opentelemetry/exporter-trace-otlp-http` + `@opentelemetry/sdk-trace-base`
 * -- so the only optional package this SDK ever touches, at runtime, is
 * `@opentelemetry/api` (and only when `telemetry.enabled`). POSTs a
 * standard OTLP-shaped JSON payload via `fetch`; exporter failures are
 * swallowed so they can never break the SDK call a span was attached to.
 */
export class OtelExporter {
  constructor(private readonly options: { exporterUrl: string; serviceName?: string }) {}

  /** Builds the OTLP/HTTP JSON payload for a batch of spans (exposed for testing). */
  toOtlpPayload(spans: SpanRecord[]): OtlpTracePayload {
    return {
      resourceSpans: [
        {
          resource: {
            attributes: [
              {
                key: "service.name",
                value: { stringValue: this.options.serviceName ?? "@stellar-split/sdk" },
              },
            ],
          },
          scopeSpans: [
            {
              scope: { name: "@stellar-split/sdk" },
              spans: spans.map((s) => ({
                name: s.name,
                startTimeUnixNano: String(s.startTimeMs * 1_000_000),
                endTimeUnixNano: String(s.endTimeMs * 1_000_000),
                attributes: Object.entries(s.attributes).map(([key, value]) => ({
                  key,
                  value: otlpAttributeValue(value),
                })),
                status: {
                  code:
                    s.statusCode === "ERROR"
                      ? OTLP_STATUS_ERROR
                      : s.statusCode === "OK"
                        ? OTLP_STATUS_OK
                        : OTLP_STATUS_UNSET,
                  message: s.statusMessage,
                },
              })),
            },
          ],
        },
      ],
    };
  }

  async exportSpans(spans: SpanRecord[]): Promise<void> {
    if (spans.length === 0) return;
    try {
      await fetch(this.options.exporterUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(this.toOtlpPayload(spans)),
      });
    } catch {
      // Collector unreachable or fetch unsupported -- never propagate to the caller.
    }
  }
}

/**
 * Lazily creates a real handle backed by `@opentelemetry/api`. Only ever
 * called when `telemetry.enabled` -- never at module load time.
 *
 * If a host application has registered a global TracerProvider/MeterProvider
 * (e.g. via its own OTel Node SDK setup, or `InMemorySpanExporter` +
 * `BasicTracerProvider` in tests), spans and metrics flow through that
 * pipeline via the standard `@opentelemetry/api` global-registration
 * mechanism. Independently, if `exporterUrl` is configured, this SDK's own
 * {@link OtelExporter} also POSTs each finished span directly -- useful for
 * consumers who just want "point me at a collector" without standing up
 * their own OTel SDK.
 */
export async function createOtelHandle(
  telemetry: TelemetryOptions,
  exporter?: OtelExporter,
): Promise<OtelHandle> {
  // Non-literal specifier: TypeScript types a dynamic import() by statically
  // resolving a *literal* string specifier's declaration file, which would
  // force @opentelemetry/api's types to be installed even for consumers who
  // never enable telemetry. Routing the specifier through a variable makes
  // TS (and esbuild's bundler) treat this as opaque/`any`, deferring actual
  // resolution to the runtime module loader -- exactly when we want it.
  const otelApiSpecifier = "@opentelemetry/api";
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const otelApi: any = await import(otelApiSpecifier);
  const serviceName = telemetry.serviceName ?? "@stellar-split/sdk";
  const tracer = otelApi.trace.getTracer(serviceName);
  const meter = otelApi.metrics.getMeter(serviceName);
  const rpcCallCount = meter.createCounter("split_sdk.rpc_call.count", {
    description: "Number of SplitClient method calls (each treated as an RPC call).",
  });
  const rpcCallDuration = meter.createHistogram("split_sdk.rpc_call.duration", {
    description: "Duration of SplitClient method calls, in milliseconds.",
    unit: "ms",
  });
  const txErrorCount = meter.createCounter("split_sdk.tx.error.count", {
    description: "Number of SplitClient method calls that threw.",
  });

  return {
    startSpan(name: string): OtelSpanHandle {
      const span = tracer.startSpan(name);
      const startTimeMs = Date.now();
      const attributes: Record<string, string | number | boolean> = {};
      let statusCode: "OK" | "ERROR" = "OK";
      let statusMessage: string | undefined;

      return {
        setAttribute(key, value) {
          attributes[key] = value;
          span.setAttribute(key, value);
        },
        recordError(error: unknown) {
          const err = error instanceof Error ? error : new Error(String(error));
          statusCode = "ERROR";
          statusMessage = err.message;
          span.recordException(err);
          span.setStatus({ code: otelApi.SpanStatusCode.ERROR, message: err.message });
        },
        end() {
          span.end();
          if (exporter) {
            void exporter.exportSpans([
              {
                name,
                startTimeMs,
                endTimeMs: Date.now(),
                attributes,
                statusCode,
                statusMessage,
              },
            ]);
          }
        },
      };
    },
    recordRpcCall(durationMs, attributes) {
      rpcCallCount.add(1, attributes);
      rpcCallDuration.record(durationMs, attributes);
    },
    recordTxError(attributes) {
      txErrorCount.add(1, attributes);
    },
  };
}
