/**
 * Trace ID generation and management for end-to-end observability.
 * Each SDK method call is assigned a unique UUID v4 trace ID that flows
 * through every outgoing RPC request header and telemetry payload.
 */

export type TraceIdGenerator = () => string;

// === UUID v4 fallback ===

/** RFC 4122 v4 UUID built from Math.random(); used only when Web Crypto is absent. */
function uuidV4FromMathRandom(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

// === Trace ID generation ===

/**
 * Generate a UUID v4 trace ID.
 *
 * Prefers `crypto.randomUUID()` from the Web Crypto API, which is
 * collision-resistant and suitable for high-throughput usage. Falls back to a
 * `Math.random()`-based UUID v4 in runtimes where `crypto.randomUUID` is
 * unavailable (e.g. Node.js < 19). The returned value always conforms to the
 * UUID v4 format `xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx`.
 */
export function generateTraceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return uuidV4FromMathRandom();
}

const defaultGenerateTraceId: TraceIdGenerator = generateTraceId;

export class TraceIdManager {
  private _generator: TraceIdGenerator = defaultGenerateTraceId;

  setGenerator(generator: TraceIdGenerator): void {
    this._generator = generator;
  }

  generate(): string {
    return this._generator();
  }
}

export const globalTraceIdManager = new TraceIdManager();
