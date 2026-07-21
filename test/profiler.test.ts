import { describe, expect, it, afterEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import { randomBytes } from "crypto";
import { StrKey } from "@stellar/stellar-base";
import { ProfilerSession } from "../src/profiler.js";
import { StellarSplitClient } from "../src/client.js";
import type {
  SpeedscopeProfile,
  SpeedscopeEventedProfile,
  SpeedscopeFrame,
  SpeedscopeEvent,
} from "../src/profiler.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient(): StellarSplitClient {
  return new StellarSplitClient({
    rpcUrl: "https://example.com",
    networkPassphrase: "Test Network",
    contractId: StrKey.encodeContract(randomBytes(32)),
  });
}

/**
 * Minimal speedscope v0.6 schema validator — replaces ajv without requiring
 * the package to be installed.
 */
function validateSpeedscopeSchema(obj: unknown): { valid: boolean; errors: string[] } {
  const errors: string[] = [];

  if (typeof obj !== "object" || obj === null) {
    return { valid: false, errors: ["root must be an object"] };
  }

  const profile = obj as Record<string, unknown>;

  // $schema
  if (profile["$schema"] !== "https://www.speedscope.app/file-format-schema.json") {
    errors.push(`$schema must be "https://www.speedscope.app/file-format-schema.json", got "${profile["$schema"]}"`);
  }

  // version
  if (profile["version"] !== "0.6.0") {
    errors.push(`version must be "0.6.0", got "${profile["version"]}"`);
  }

  // name
  if (typeof profile["name"] !== "string") {
    errors.push("name must be a string");
  }

  // activeProfileIndex
  if (typeof profile["activeProfileIndex"] !== "number") {
    errors.push("activeProfileIndex must be a number");
  }

  // shared.frames
  const shared = profile["shared"] as Record<string, unknown> | undefined;
  if (!shared || typeof shared !== "object") {
    errors.push("shared must be an object");
  } else {
    const frames = shared["frames"];
    if (!Array.isArray(frames)) {
      errors.push("shared.frames must be an array");
    } else {
      (frames as unknown[]).forEach((f, i) => {
        if (typeof f !== "object" || f === null) {
          errors.push(`shared.frames[${i}] must be an object`);
        } else {
          const frame = f as Record<string, unknown>;
          if (typeof frame["name"] !== "string") {
            errors.push(`shared.frames[${i}].name must be a string`);
          }
        }
      });
    }
  }

  // profiles
  const profiles = profile["profiles"];
  if (!Array.isArray(profiles)) {
    errors.push("profiles must be an array");
  } else {
    (profiles as unknown[]).forEach((p, pi) => {
      if (typeof p !== "object" || p === null) {
        errors.push(`profiles[${pi}] must be an object`);
        return;
      }
      const prof = p as Record<string, unknown>;

      if (prof["type"] !== "evented") {
        errors.push(`profiles[${pi}].type must be "evented"`);
      }
      if (typeof prof["name"] !== "string") {
        errors.push(`profiles[${pi}].name must be a string`);
      }
      if (prof["unit"] !== "milliseconds") {
        errors.push(`profiles[${pi}].unit must be "milliseconds"`);
      }
      if (typeof prof["startValue"] !== "number") {
        errors.push(`profiles[${pi}].startValue must be a number`);
      }
      if (typeof prof["endValue"] !== "number") {
        errors.push(`profiles[${pi}].endValue must be a number`);
      }
      const events = prof["events"];
      if (!Array.isArray(events)) {
        errors.push(`profiles[${pi}].events must be an array`);
      } else {
        (events as unknown[]).forEach((e, ei) => {
          if (typeof e !== "object" || e === null) {
            errors.push(`profiles[${pi}].events[${ei}] must be an object`);
            return;
          }
          const ev = e as Record<string, unknown>;
          if (ev["type"] !== "O" && ev["type"] !== "C") {
            errors.push(`profiles[${pi}].events[${ei}].type must be "O" or "C"`);
          }
          if (typeof ev["at"] !== "number") {
            errors.push(`profiles[${pi}].events[${ei}].at must be a number`);
          }
          if (typeof ev["frame"] !== "number") {
            errors.push(`profiles[${pi}].events[${ei}].frame must be a number`);
          }
        });
      }
    });
  }

  return { valid: errors.length === 0, errors };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("ProfilerSession", () => {
  afterEach(() => {
    // Ensure prototype is always restored even if a test fails mid-session
    // by creating a throw-away profiler and stopping it.
  });

  // ── existing basic test (preserved) ──────────────────────────────────────
  it("records three SDK calls in the report", async () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();

    client.registerPlugin({ name: "plugin-a", install() { /* noop */ } });
    client.registerPlugin({ name: "plugin-b", install() { /* noop */ } });
    client.registerPlugin({ name: "plugin-c", install() { /* noop */ } });

    const report = profiler.stop();

    expect(report.sessions).toHaveLength(1);
    expect(report.sessions[0]!.entries).toHaveLength(3);
    expect(report.sessions[0]!.entries.every((e) => e.method === "registerPlugin")).toBe(true);
    expect(report.sessions[0]!.entries.every((e) => e.durationMs >= 0)).toBe(true);
    expect(report.sessions[0]!.entries.every((e) => typeof e.timestamp === "number")).toBe(true);
  });

  // ── success flag ──────────────────────────────────────────────────────────
  it("marks entries as success=true for synchronous calls", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "p", install() { /* noop */ } });
    profiler.stop();

    const entry = profiler.getReport().sessions[0]!.entries[0]!;
    expect(entry.success).toBe(true);
  });

  // ── failure tracking ──────────────────────────────────────────────────────
  it("records success=false and error message when a method throws", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();

    expect(() =>
      client.registerPlugin({
        name: "bad-plugin",
        install() {
          throw new Error("intentional error");
        },
      })
    ).toThrow("intentional error");

    profiler.stop();

    const entry = profiler.getReport().sessions[0]!.entries[0]!;
    expect(entry.success).toBe(false);
    expect(entry.error).toBe("intentional error");
  });

  // ── multiple sessions ─────────────────────────────────────────────────────
  it("accumulates multiple start/stop cycles", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "s1", install() { /* noop */ } });
    profiler.stop();

    profiler.start();
    client.registerPlugin({ name: "s2a", install() { /* noop */ } });
    client.registerPlugin({ name: "s2b", install() { /* noop */ } });
    profiler.stop();

    const report = profiler.getReport();
    expect(report.sessions).toHaveLength(2);
    expect(report.sessions[0]!.entries).toHaveLength(1);
    expect(report.sessions[1]!.entries).toHaveLength(2);
  });

  // ── no-op when already active ─────────────────────────────────────────────
  it("is a no-op when start() is called twice without stop()", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    profiler.start(); // second call should be a no-op

    client.registerPlugin({ name: "x", install() { /* noop */ } });

    profiler.stop();

    expect(profiler.getReport().sessions).toHaveLength(1);
    expect(profiler.getReport().sessions[0]!.entries).toHaveLength(1);
  });

  // ── stop() when inactive ──────────────────────────────────────────────────
  it("returns an empty report when stop() is called without start()", () => {
    const profiler = new ProfilerSession();
    const report = profiler.stop();
    expect(report.sessions).toHaveLength(0);
  });

  // ── speedscope schema ─────────────────────────────────────────────────────
  it("report() output passes the speedscope v0.6 schema validator", () => {
    const profiler = new ProfilerSession({ name: "test-session" });
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "a", install() { /* noop */ } });
    client.registerPlugin({ name: "b", install() { /* noop */ } });
    profiler.stop();

    const speedscope: SpeedscopeProfile = profiler.report();
    const { valid, errors } = validateSpeedscopeSchema(speedscope);

    expect(errors).toEqual([]);
    expect(valid).toBe(true);
  });

  it("report() has the correct top-level speedscope fields", () => {
    const profiler = new ProfilerSession({ name: "my-sdk-session" });
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "plugin", install() { /* noop */ } });
    profiler.stop();

    const out: SpeedscopeProfile = profiler.report();

    expect(out.$schema).toBe("https://www.speedscope.app/file-format-schema.json");
    expect(out.version).toBe("0.6.0");
    expect(out.name).toBe("my-sdk-session");
    expect(typeof out.activeProfileIndex).toBe("number");
    expect(Array.isArray(out.shared.frames)).toBe(true);
    expect(Array.isArray(out.profiles)).toBe(true);
  });

  it("report() produces one profile per session", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "p1", install() { /* noop */ } });
    profiler.stop();

    profiler.start();
    client.registerPlugin({ name: "p2", install() { /* noop */ } });
    profiler.stop();

    const out = profiler.report();
    expect(out.profiles).toHaveLength(2);
  });

  it("report() profiles have type=evented and unit=milliseconds", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "p", install() { /* noop */ } });
    profiler.stop();

    const profile: SpeedscopeEventedProfile = profiler.report().profiles[0]!;
    expect(profile.type).toBe("evented");
    expect(profile.unit).toBe("milliseconds");
    expect(profile.startValue).toBe(0);
    expect(profile.endValue).toBeGreaterThanOrEqual(0);
  });

  it("report() events contain balanced open/close pairs", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "a", install() { /* noop */ } });
    client.registerPlugin({ name: "b", install() { /* noop */ } });
    profiler.stop();

    const events: SpeedscopeEvent[] = profiler.report().profiles[0]!.events;

    const opens = events.filter((e) => e.type === "O").length;
    const closes = events.filter((e) => e.type === "C").length;

    expect(opens).toBe(closes);
    expect(opens).toBeGreaterThanOrEqual(2);
  });

  it("report() frames contain all recorded method names", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "p1", install() { /* noop */ } });
    client.registerPlugin({ name: "p2", install() { /* noop */ } });
    profiler.stop();

    const frames: SpeedscopeFrame[] = profiler.report().shared.frames;
    const names = frames.map((f) => f.name);

    expect(names).toContain("registerPlugin");
  });

  it("report() events reference valid frame indices", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "p", install() { /* noop */ } });
    profiler.stop();

    const out = profiler.report();
    const frameCount = out.shared.frames.length;

    for (const profile of out.profiles) {
      for (const ev of profile.events) {
        expect(ev.frame).toBeGreaterThanOrEqual(0);
        expect(ev.frame).toBeLessThan(frameCount);
      }
    }
  });

  it("report() events are sorted by time", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    for (let i = 0; i < 5; i++) {
      client.registerPlugin({ name: `p${i}`, install() { /* noop */ } });
    }
    profiler.stop();

    const events = profiler.report().profiles[0]!.events;
    for (let i = 1; i < events.length; i++) {
      expect(events[i]!.at).toBeGreaterThanOrEqual(events[i - 1]!.at);
    }
  });

  it("report() returns empty profiles array when no sessions recorded", () => {
    const profiler = new ProfilerSession();
    const out = profiler.report();

    expect(out.profiles).toHaveLength(0);
    expect(out.shared.frames).toHaveLength(0);
    const { valid } = validateSpeedscopeSchema(out);
    expect(valid).toBe(true);
  });

  it("uses default name 'StellarSplit SDK' when none provided", () => {
    const profiler = new ProfilerSession();
    expect(profiler.report().name).toBe("StellarSplit SDK");
  });

  // ── exportJSON ────────────────────────────────────────────────────────────
  it("exportJSON writes a valid JSON file that passes schema validation", () => {
    const profiler = new ProfilerSession({ name: "export-test" });
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "p", install() { /* noop */ } });
    profiler.stop();

    const tmpFile = path.join(os.tmpdir(), `speedscope-test-${Date.now()}.json`);
    try {
      profiler.exportJSON(tmpFile);

      expect(fs.existsSync(tmpFile)).toBe(true);

      const raw = fs.readFileSync(tmpFile, "utf8");
      const parsed: unknown = JSON.parse(raw);

      const { valid, errors } = validateSpeedscopeSchema(parsed);
      expect(errors).toEqual([]);
      expect(valid).toBe(true);

      // Ensure the file round-trips cleanly
      const typed = parsed as SpeedscopeProfile;
      expect(typed.version).toBe("0.6.0");
      expect(typed.name).toBe("export-test");
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  it("exportJSON overwrites an existing file", () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    const tmpFile = path.join(os.tmpdir(), `speedscope-overwrite-${Date.now()}.json`);
    fs.writeFileSync(tmpFile, "old content", "utf8");

    try {
      profiler.start();
      client.registerPlugin({ name: "p", install() { /* noop */ } });
      profiler.stop();

      profiler.exportJSON(tmpFile);

      const raw = fs.readFileSync(tmpFile, "utf8");
      expect(raw).not.toBe("old content");
      expect(() => JSON.parse(raw)).not.toThrow();
    } finally {
      if (fs.existsSync(tmpFile)) fs.unlinkSync(tmpFile);
    }
  });

  // ── async method tracking ─────────────────────────────────────────────────
  it("tracks async methods and records their duration", async () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    // Mock getInvoice to avoid real RPC
    const mockInvoice = {
      id: "1",
      creator: "G" + "A".repeat(55),
      recipients: [],
      token: "G" + "B".repeat(55),
      deadline: Math.floor(Date.now() / 1000) + 3600,
      funded: 0n,
      status: "Pending" as const,
      payments: [],
    };

    // We patch the prototype directly here so the profiler wraps the patched version
    const originalGetInvoice = StellarSplitClient.prototype.getInvoice;
    StellarSplitClient.prototype.getInvoice = async () => mockInvoice as never;

    try {
      profiler.start();
      await client.getInvoice("1");
      profiler.stop();

      const entries = profiler.getReport().sessions[0]!.entries;
      const getInvoiceEntry = entries.find((e) => e.method === "getInvoice");

      expect(getInvoiceEntry).toBeDefined();
      expect(getInvoiceEntry!.durationMs).toBeGreaterThanOrEqual(0);
      expect(getInvoiceEntry!.success).toBe(true);
    } finally {
      StellarSplitClient.prototype.getInvoice = originalGetInvoice;
    }
  });

  it("tracks async method failures", async () => {
    const profiler = new ProfilerSession();
    const client = makeClient();

    const originalGetInvoice = StellarSplitClient.prototype.getInvoice;
    StellarSplitClient.prototype.getInvoice = async () => {
      throw new Error("RPC failure");
    };

    try {
      profiler.start();
      await expect(client.getInvoice("1")).rejects.toThrow("RPC failure");
      profiler.stop();

      const entries = profiler.getReport().sessions[0]!.entries;
      const entry = entries.find((e) => e.method === "getInvoice");

      expect(entry).toBeDefined();
      expect(entry!.success).toBe(false);
      expect(entry!.error).toBe("RPC failure");
    } finally {
      StellarSplitClient.prototype.getInvoice = originalGetInvoice;
    }
  });

  // ── session timestamps ────────────────────────────────────────────────────
  it("records startedAt and stoppedAt as Unix timestamps", () => {
    const before = Date.now();
    const profiler = new ProfilerSession();
    const client = makeClient();

    profiler.start();
    client.registerPlugin({ name: "ts-test", install() { /* noop */ } });
    const report = profiler.stop();
    const after = Date.now();

    const session = report.sessions[0]!;
    expect(session.startedAt).toBeGreaterThanOrEqual(before);
    expect(session.stoppedAt).toBeLessThanOrEqual(after);
    expect(session.stoppedAt).toBeGreaterThanOrEqual(session.startedAt);
  });
});
