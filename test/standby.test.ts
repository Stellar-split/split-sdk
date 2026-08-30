/**
 * Tests for StandbyController warm-up period — issue #702.
 *
 * Covers:
 *  - warmUpMs option (default: 0, i.e., no warm-up)
 *  - During warm-up, inactivity does NOT trigger standby
 *  - After warm-up, standby detection resumes normally
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { StandbyController } from "../src/standby.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeController(opts: { warmUpMs?: number; inactivityMs?: number } = {}): StandbyController {
  return new StandbyController({
    inactivityMs: opts.inactivityMs ?? 1_000,
    warmUpMs: opts.warmUpMs,
  });
}

// ---------------------------------------------------------------------------
// Warm-up option acceptance
// ---------------------------------------------------------------------------

describe("StandbyController — warmUpMs option", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("accepts warmUpMs option without error", () => {
    expect(() => new StandbyController({ warmUpMs: 5_000 })).not.toThrow();
  });

  it("defaults warmUpMs to 0 when not provided", () => {
    const ctrl = makeController(); // no warmUpMs
    const listener = vi.fn();
    ctrl.onStandby(listener);
    ctrl.start();

    // With warmUpMs=0, standby should fire after inactivityMs
    vi.advanceTimersByTime(1_000);
    expect(listener).toHaveBeenCalledOnce();

    ctrl.stop();
  });

  it("accepts warmUpMs: 0 explicitly (no warm-up)", () => {
    const ctrl = makeController({ warmUpMs: 0 });
    const listener = vi.fn();
    ctrl.onStandby(listener);
    ctrl.start();

    vi.advanceTimersByTime(1_000);
    expect(listener).toHaveBeenCalledOnce();

    ctrl.stop();
  });
});

// ---------------------------------------------------------------------------
// Inactivity suppression during warm-up
// ---------------------------------------------------------------------------

describe("StandbyController — warm-up suppresses standby", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("does NOT trigger standby when inactivity fires inside the warm-up window", () => {
    // warmUpMs (5 s) > inactivityMs (1 s) — standby should be suppressed
    const ctrl = makeController({ warmUpMs: 5_000, inactivityMs: 1_000 });
    const listener = vi.fn();
    ctrl.onStandby(listener);
    ctrl.start();

    // Advance past inactivityMs but still inside warmUpMs
    vi.advanceTimersByTime(1_500);
    expect(listener).not.toHaveBeenCalled();

    ctrl.stop();
  });

  it("standby is still suppressed at the exact edge of inactivityMs during warm-up", () => {
    const ctrl = makeController({ warmUpMs: 10_000, inactivityMs: 1_000 });
    const listener = vi.fn();
    ctrl.onStandby(listener);
    ctrl.start();

    vi.advanceTimersByTime(1_000); // exactly inactivityMs, still within warmUp
    expect(listener).not.toHaveBeenCalled();

    ctrl.stop();
  });

  it("recordActivity during warm-up does not reset an inactivity timer (there is none yet)", () => {
    const ctrl = makeController({ warmUpMs: 5_000, inactivityMs: 1_000 });
    const listener = vi.fn();
    ctrl.onStandby(listener);
    ctrl.start();

    // Simulate activity during warm-up
    vi.advanceTimersByTime(2_000);
    ctrl.recordActivity();
    vi.advanceTimersByTime(1_500); // inactivityMs after recordActivity, still in warmUp
    expect(listener).not.toHaveBeenCalled();

    ctrl.stop();
  });
});

// ---------------------------------------------------------------------------
// Normal standby detection after warm-up
// ---------------------------------------------------------------------------

describe("StandbyController — standby activates after warm-up", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("triggers standby after warm-up + inactivity have both elapsed", () => {
    const ctrl = makeController({ warmUpMs: 2_000, inactivityMs: 1_000 });
    const listener = vi.fn();
    ctrl.onStandby(listener);
    ctrl.start();

    // Only warm-up elapsed — no standby yet
    vi.advanceTimersByTime(2_000);
    expect(listener).not.toHaveBeenCalled();

    // inactivityMs elapses after warm-up ends
    vi.advanceTimersByTime(1_000);
    expect(listener).toHaveBeenCalledOnce();

    ctrl.stop();
  });

  it("marks controller as standby=true after warm-up + inactivity", () => {
    const ctrl = makeController({ warmUpMs: 2_000, inactivityMs: 1_000 });
    ctrl.start();

    vi.advanceTimersByTime(3_000 + 1); // warmUp + inactivity + 1ms buffer
    expect(ctrl.standby).toBe(true);

    ctrl.stop();
  });

  it("recordActivity after warm-up resets the inactivity timer", () => {
    const ctrl = makeController({ warmUpMs: 1_000, inactivityMs: 2_000 });
    const listener = vi.fn();
    ctrl.onStandby(listener);
    ctrl.start();

    // Let warm-up elapse
    vi.advanceTimersByTime(1_000);

    // Advance 1.5 s into inactivity (not yet triggered)
    vi.advanceTimersByTime(1_500);
    expect(listener).not.toHaveBeenCalled();

    // Record activity — this should restart the inactivity timer
    ctrl.recordActivity();

    // Only 0.5 s elapses after activity — no standby
    vi.advanceTimersByTime(500);
    expect(listener).not.toHaveBeenCalled();

    // Full inactivityMs elapses — standby now fires
    vi.advanceTimersByTime(2_000);
    expect(listener).toHaveBeenCalledOnce();

    ctrl.stop();
  });

  it("standby listener is called exactly once per idle period", () => {
    const ctrl = makeController({ warmUpMs: 500, inactivityMs: 500 });
    const listener = vi.fn();
    ctrl.onStandby(listener);
    ctrl.start();

    vi.advanceTimersByTime(1_500); // warmUp + inactivity + extra

    expect(listener).toHaveBeenCalledOnce();
    ctrl.stop();
  });

  it("standby does not fire after stop() is called", () => {
    const ctrl = makeController({ warmUpMs: 0, inactivityMs: 1_000 });
    const listener = vi.fn();
    ctrl.onStandby(listener);
    ctrl.start();

    vi.advanceTimersByTime(500);
    ctrl.stop();

    // Advance beyond inactivity threshold after stop
    vi.advanceTimersByTime(1_500);
    expect(listener).not.toHaveBeenCalled();
  });

  it("controller is NOT in standby during the warm-up period", () => {
    const ctrl = makeController({ warmUpMs: 5_000, inactivityMs: 1_000 });
    ctrl.start();

    vi.advanceTimersByTime(4_000); // still within warm-up
    expect(ctrl.standby).toBe(false);

    ctrl.stop();
  });
});
