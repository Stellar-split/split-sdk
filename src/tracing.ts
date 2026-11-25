import { globalTraceIdManager } from "./traceId.js";
import { telemetry } from "./telemetry.js";

/** Run an async SDK operation within a shared trace and telemetry span. */
export function withTrace<T>(name: string, operation: () => Promise<T>): Promise<T> {
  return globalTraceIdManager.runWithTrace((traceId) =>
    telemetry.runInSpan(`${name}:${traceId}`, operation),
  );
}
