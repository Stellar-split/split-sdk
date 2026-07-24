import * as fs from "fs";
import { StellarSplitClient } from "./client.js";

// ---------------------------------------------------------------------------
// Internal timing record captured during a session
// ---------------------------------------------------------------------------

/** A single timed entry captured during a profiling session. */
export interface ProfileEntry {
  /** SDK method name. */
  method: string;
  /** Wall-clock duration in milliseconds. */
  durationMs: number;
  /** Unix timestamp (ms) when the call started. */
  timestamp: number;
  /** Whether the call completed successfully. */
  success: boolean;
  /** Optional error message when success === false. */
  error?: string;
  /** Nested RPC call timings captured during this SDK method. */
  rpcCalls?: RpcCallTiming[];
}

/** Timing captured for a single underlying RPC call. */
export interface RpcCallTiming {
  /** RPC method / operation name. */
  operation: string;
  /** Duration in milliseconds. */
  durationMs: number;
}

/** An aggregated snapshot of one start/stop recording cycle. */
export interface ProfileSession {
  startedAt: number;
  stoppedAt: number;
  entries: ProfileEntry[];
}

/** Legacy report format (kept for backwards compat). */
export interface ProfileReport {
  sessions: ProfileSession[];
}

// ---------------------------------------------------------------------------
// Speedscope v0.6 type definitions
// ---------------------------------------------------------------------------

/** Speedscope shared frame. */
export interface SpeedscopeFrame {
  name: string;
  file?: string;
  line?: number;
  col?: number;
}

/** A single open/close event in an EventedProfile. */
export interface SpeedscopeEvent {
  /** "O" = open frame, "C" = close frame. */
  type: "O" | "C";
  /** Time of the event (in the unit specified by the profile). */
  at: number;
  /** Index into the shared frames array. */
  frame: number;
}

/** Speedscope EventedProfile (the format we produce). */
export interface SpeedscopeEventedProfile {
  type: "evented";
  name: string;
  unit: "milliseconds";
  startValue: number;
  endValue: number;
  events: SpeedscopeEvent[];
}

/**
 * Top-level speedscope file — v0.6.
 * https://github.com/jlfwong/speedscope/blob/main/src/lib/file-format-spec.ts
 */
export interface SpeedscopeProfile {
  $schema: "https://www.speedscope.app/file-format-schema.json";
  version: "0.6.0";
  name: string;
  activeProfileIndex: number;
  shared: {
    frames: SpeedscopeFrame[];
  };
  profiles: SpeedscopeEventedProfile[];
}

// ---------------------------------------------------------------------------
// ProfilerSession
// ---------------------------------------------------------------------------

/** Options accepted by the ProfilerSession constructor. */
export interface ProfilerSessionOptions {
  /** Human-readable label shown in speedscope (default: "StellarSplit SDK"). */
  name?: string;
}

/**
 * Records timing for every StellarSplitClient method call and produces output
 * compatible with the speedscope flame-graph viewer (JSON format, v0.6).
 *
 * @example
 * ```ts
 * const profiler = new ProfilerSession({ name: "my-session" });
 * profiler.start();
 * await client.createInvoice(…);
 * profiler.stop();
 * const graph = profiler.report();
 * profiler.exportJSON("./profile.json");
 * ```
 */
export class ProfilerSession {
  private readonly sessionName: string;
  private sessions: ProfileSession[] = [];
  private active = false;
  private currentEntries: ProfileEntry[] = [];
  private currentStartedAt = 0;
  private currentStoppedAt = 0;
  private originalMethods = new Map<string, Function>();

  constructor(options: ProfilerSessionOptions = {}) {
    this.sessionName = options.name ?? "StellarSplit SDK";
  }

  // -------------------------------------------------------------------------
  // start() — patch StellarSplitClient prototype
  // -------------------------------------------------------------------------

  /** Begin recording. No-op if already recording. */
  start(): void {
    if (this.active) {
      return;
    }

    const clientPrototype = StellarSplitClient.prototype as unknown as Record<string, unknown>;
    const methodNames = Object.getOwnPropertyNames(clientPrototype).filter(
      (key) => key !== "constructor" && typeof clientPrototype[key] === "function"
    );

    const thisSession = this;
    for (const methodName of methodNames) {
      const original = clientPrototype[methodName] as Function;
      this.originalMethods.set(methodName, original);

      clientPrototype[methodName] = function (this: unknown, ...args: unknown[]) {
        const startTime = performance.now();
        const startTs = Date.now();
        const rpcCalls: RpcCallTiming[] = [];

        const record = (success: boolean, error?: string): void => {
          const durationMs = performance.now() - startTime;
          thisSession.currentEntries.push({
            method: methodName,
            durationMs,
            timestamp: startTs,
            success,
            ...(error !== undefined ? { error } : {}),
            ...(rpcCalls.length > 0 ? { rpcCalls: [...rpcCalls] } : {}),
          });
        };

        let result: unknown;
        try {
          result = original.apply(this, args);
        } catch (err: unknown) {
          record(false, err instanceof Error ? err.message : String(err));
          throw err;
        }

        if (result && typeof (result as Promise<unknown>).then === "function") {
          return (result as Promise<unknown>).then(
            (value: unknown) => {
              record(true);
              return value;
            },
            (err: unknown) => {
              record(false, err instanceof Error ? err.message : String(err));
              return Promise.reject(err);
            }
          );
        }

        record(true);
        return result;
      } as unknown as Function;
    }

    this.currentEntries = [];
    this.currentStartedAt = Date.now();
    this.active = true;
  }

  // -------------------------------------------------------------------------
  // stop() — restore prototype and finalise session
  // -------------------------------------------------------------------------

  /**
   * Stop recording and return the legacy ProfileReport.
   * Recorded data is still accessible via `report()`.
   */
  stop(): ProfileReport {
    if (!this.active) {
      return { sessions: [...this.sessions] };
    }

    const clientPrototype = StellarSplitClient.prototype as unknown as Record<string, unknown>;
    for (const [methodName, original] of this.originalMethods.entries()) {
      clientPrototype[methodName] = original;
    }

    this.currentStoppedAt = Date.now();
    this.sessions.push({
      startedAt: this.currentStartedAt,
      stoppedAt: this.currentStoppedAt,
      entries: [...this.currentEntries],
    });

    this.active = false;
    this.originalMethods.clear();

    return this.getReport();
  }

  /** Return the legacy ProfileReport (all recorded sessions). */
  getReport(): ProfileReport {
    return { sessions: [...this.sessions] };
  }

  // -------------------------------------------------------------------------
  // report() — speedscope v0.6 output
  // -------------------------------------------------------------------------

  /**
   * Build a speedscope v0.6 flame-graph JSON object from all recorded sessions.
   *
   * Each session becomes one EventedProfile. Method calls are represented as
   * open/close event pairs. RPC sub-calls are represented as nested events
   * inside the parent method's time window (synthesised from rpcCalls data).
   */
  report(): SpeedscopeProfile {
    // Collect all unique frame names across every session
    const frameIndex = new Map<string, number>();
    const frames: SpeedscopeFrame[] = [];

    const getFrame = (name: string): number => {
      let idx = frameIndex.get(name);
      if (idx === undefined) {
        idx = frames.length;
        frames.push({ name });
        frameIndex.set(name, idx);
      }
      return idx;
    };

    const profiles: SpeedscopeEventedProfile[] = this.sessions.map((session, si) => {
      const events: SpeedscopeEvent[] = [];
      const sessionStart = session.startedAt;
      let maxTime = 0;

      for (const entry of session.entries) {
        // Relative start time within this session (ms)
        const relStart = entry.timestamp - sessionStart;
        const relEnd = relStart + entry.durationMs;

        if (relEnd > maxTime) maxTime = relEnd;

        const methodFrame = getFrame(entry.method);
        events.push({ type: "O", at: relStart, frame: methodFrame });

        // Emit nested RPC call events (synthesised, evenly distributed within
        // the parent window so the flame graph is always valid)
        if (entry.rpcCalls && entry.rpcCalls.length > 0) {
          let cursor = relStart;
          for (const rpc of entry.rpcCalls) {
            const rpcFrame = getFrame(`rpc:${rpc.operation}`);
            const rpcEnd = Math.min(cursor + rpc.durationMs, relEnd);
            events.push({ type: "O", at: cursor, frame: rpcFrame });
            events.push({ type: "C", at: rpcEnd, frame: rpcFrame });
            cursor = rpcEnd;
          }
        }

        events.push({ type: "C", at: relEnd, frame: methodFrame });
      }

      // Speedscope requires events to be sorted by `at` time.
      // Ties are broken so C comes after O for the same frame at the same time
      // (open before close).
      events.sort((a, b) => {
        if (a.at !== b.at) return a.at - b.at;
        // "O" < "C" so opens come first on ties
        return a.type === "O" && b.type === "C" ? -1 : 1;
      });

      return {
        type: "evented",
        name: `${this.sessionName} — session ${si + 1}`,
        unit: "milliseconds",
        startValue: 0,
        endValue: maxTime,
        events,
      };
    });

    return {
      $schema: "https://www.speedscope.app/file-format-schema.json",
      version: "0.6.0",
      name: this.sessionName,
      activeProfileIndex: 0,
      shared: { frames },
      profiles,
    };
  }

  // -------------------------------------------------------------------------
  // exportJSON() — write report to disk
  // -------------------------------------------------------------------------

  /**
   * Serialise the speedscope report and write it to `path`.
   *
   * @param path - Destination file path (will be created / overwritten).
   */
  exportJSON(path: string): void {
    const json = JSON.stringify(this.report(), null, 2);
    fs.writeFileSync(path, json, "utf8");
  }
}
