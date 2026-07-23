/**
 * Trace ID generation and management for end-to-end observability.
 * Each SDK method call is assigned a unique UUID v4 trace ID that flows
 * through every outgoing RPC request header and telemetry payload.
 */

export type TraceIdGenerator = () => string;

function defaultGenerateTraceId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  // Fallback for environments without crypto.randomUUID
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}

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
