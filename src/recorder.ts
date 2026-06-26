/**
 * SDK request/response recorder for debugging.
 *
 * Captures a redacted recording of all RPC requests and responses during a
 * session. The recording can be serialised to JSON and replayed against
 * MockRPCServer to reproduce issues without live network access.
 */

import type { RequestInterceptor, ResponseInterceptor, RPCRequest, RPCResponse } from "./interceptors.js";
import type { MockRPCServer } from "./testing/mockServer.js";

export interface RecordedRequest {
  method: string;
  params: unknown[];
  timestamp: number;
}

export interface RecordedResponse {
  method: string;
  result: unknown;
  durationMs: number;
  timestamp: number;
}

export interface RecordingEntry {
  id: string;
  request: RecordedRequest;
  response: RecordedResponse | null;
  error: string | null;
}

export interface SessionRecording {
  sdkVersion: string;
  startedAt: number;
  endedAt: number | null;
  entries: RecordingEntry[];
  metadata: Record<string, string>;
}

const PII_PATTERNS = [
  /G[A-Z0-9]{55}/g,          // Stellar public keys
  /S[A-Z0-9]{55}/g,          // Stellar secret keys (should never appear, but just in case)
  /0x[a-fA-F0-9]{40,}/g,     // Ethereum-style addresses
  /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g, // emails
];

function redact(value: unknown): unknown {
  if (typeof value === "string") {
    let result = value;
    for (const pattern of PII_PATTERNS) {
      result = result.replace(pattern, (match) => {
        if (match.startsWith("G") && match.length === 56) {
          return match.slice(0, 6) + "…" + match.slice(-4);
        }
        return "[REDACTED]";
      });
    }
    return result;
  }
  if (Array.isArray(value)) {
    return value.map(redact);
  }
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = redact(val);
    }
    return result;
  }
  return value;
}

let entryCounter = 0;

function nextEntryId(): string {
  entryCounter++;
  return `rec_${Date.now()}_${entryCounter}`;
}

/**
 * Records all RPC requests/responses into a replayable session log,
 * with PII automatically redacted.
 *
 * Usage:
 *   const recorder = new Recorder();
 *   recorder.start(); // registers interceptors
 *   // ... use client ...
 *   const session = recorder.stop();
 *   const json = session.serialize();
 *   // Later, replay:
 *   await recorder.replay(json, mockServer);
 */
export class Recorder {
  private recording: SessionRecording;
  private started = false;

  private requestInterceptor: RequestInterceptor;
  private responseInterceptor: ResponseInterceptor;

  constructor(metadata: Record<string, string> = {}) {
    this.recording = {
      sdkVersion: "__VERSION__",
      startedAt: 0,
      endedAt: null,
      entries: [],
      metadata,
    };

    this.requestInterceptor = (req: RPCRequest) => {
      if (!this.started) return req;
      const redactedReq: RecordedRequest = {
        method: req.method,
        params: redact(req.params) as unknown[],
        timestamp: Date.now(),
      };
      this.recording.entries.push({
        id: nextEntryId(),
        request: redactedReq,
        response: null,
        error: null,
      });
      return req;
    };

    this.responseInterceptor = (res: RPCResponse) => {
      if (!this.started) return res;
      const entry = this.recording.entries.find(
        (e) => e.response === null && e.request.method === res.method
      );
      if (entry) {
        entry.response = {
          method: res.method,
          result: redact(res.result),
          durationMs: res.durationMs,
          timestamp: Date.now(),
        };
      }
      return res;
    };
  }

  /**
   * Return the request interceptor for use with addRequestInterceptor.
   */
  getRequestInterceptor(): RequestInterceptor {
    return this.requestInterceptor;
  }

  /**
   * Return the response interceptor for use with addResponseInterceptor.
   */
  getResponseInterceptor(): ResponseInterceptor {
    return this.responseInterceptor;
  }

/**
 * Start recording. Registers the request/response interceptors.
 * Callers should import addRequestInterceptor/addResponseInterceptor
 * from "./interceptors.js" and pass them in, or use the static
 * convenience method `Recorder.startAndAttach`.
 */
start(
  addRequestInterceptor?: (fn: RequestInterceptor) => void,
  addResponseInterceptor?: (fn: ResponseInterceptor) => void
): void {
  if (this.started) return;
  this.started = true;
  this.recording.startedAt = Date.now();
  this.recording.entries = [];
  addRequestInterceptor?.(this.requestInterceptor);
  addResponseInterceptor?.(this.responseInterceptor);
}

/**
 * Create a recorder, start it, and attach it to the global interceptor
 * pipeline in one call.
 *
 * Uses dynamic import so the caller does not need to wire interceptors manually.
 */
static async startAndAttach(
  metadata?: Record<string, string>
): Promise<Recorder> {
  const { addRequestInterceptor, addResponseInterceptor } = await import("./interceptors.js");
  const recorder = new Recorder(metadata);
  recorder.start(addRequestInterceptor, addResponseInterceptor);
  return recorder;
}

  /**
   * Stop recording and return the completed session recording.
   */
  stop(): SessionRecording {
    this.started = false;
    this.recording.endedAt = Date.now();
    return this.recording;
  }

  /**
   * Serialise the current recording to a JSON string.
   */
  serialize(): string {
    return JSON.stringify(this.recording, null, 2);
  }

  /**
   * Load a session recording from a JSON string.
   */
  static deserialize(json: string): SessionRecording {
    return JSON.parse(json) as SessionRecording;
  }

  /**
   * Replay a recorded session against a MockRPCServer.
   *
   * Feeds each recorded request through the mock server's simulateTransaction
   * in sequence, logging any mismatches between recorded and actual responses.
   *
   * @returns An array of replay results with pass/fail per entry.
   */
  static async replay(
    recording: SessionRecording | string,
    mockServer: MockRPCServer
  ): Promise<ReplayResult[]> {
    const session = typeof recording === "string"
      ? Recorder.deserialize(recording)
      : recording;

    const results: ReplayResult[] = [];

    for (const entry of session.entries) {
      try {
        const mockResult = await mockServer.simulateTransaction({
          operations: [
            { contractCall: { function: entry.request.method, args: entry.request.params } },
          ],
        });

        const pass = entry.response
          ? JSON.stringify(mockResult) === JSON.stringify(redact(entry.response.result))
          : false;

        results.push({
          id: entry.id,
          method: entry.request.method,
          pass,
          expected: entry.response?.result ?? null,
          actual: mockResult,
          error: null,
        });
      } catch (err) {
        results.push({
          id: entry.id,
          method: entry.request.method,
          pass: false,
          expected: entry.response?.result ?? null,
          actual: null,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return results;
  }
}

export interface ReplayResult {
  id: string;
  method: string;
  pass: boolean;
  expected: unknown;
  actual: unknown;
  error: string | null;
}

export function createRecorder(metadata?: Record<string, string>): Recorder {
  return new Recorder(metadata);
}
