import { describe, it, expect, vi } from "vitest";
import { JobScheduler } from "../src/scheduler.js";

describe("JobScheduler", () => {
  it("once() runs fn exactly once after delayMs and removes the job from the list", () => {
    vi.useFakeTimers();
    try {
      const scheduler = new JobScheduler();
      const fn = vi.fn();

      scheduler.once(100, fn);
      expect(scheduler.jobCount).toBe(1);

      vi.advanceTimersByTime(100);
      expect(fn).toHaveBeenCalledTimes(1);
      expect(scheduler.jobCount).toBe(0);

      // Further time passing must not trigger it again.
      vi.advanceTimersByTime(1000);
      expect(fn).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("cancel() on the handle before the delay expires prevents fn from running", () => {
    vi.useFakeTimers();
    try {
      const scheduler = new JobScheduler();
      const fn = vi.fn();

      const handle = scheduler.once(100, fn);
      vi.advanceTimersByTime(50);
      handle.cancel();
      vi.advanceTimersByTime(100);

      expect(fn).not.toHaveBeenCalled();
      expect(scheduler.jobCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("once() coexists with recurring schedule() jobs", () => {
    vi.useFakeTimers();
    try {
      const scheduler = new JobScheduler();
      const recurringFn = vi.fn();
      const oneShotFn = vi.fn();

      scheduler.schedule(50, recurringFn);
      scheduler.once(120, oneShotFn);
      expect(scheduler.jobCount).toBe(2);

      vi.advanceTimersByTime(150);

      expect(recurringFn.mock.calls.length).toBeGreaterThanOrEqual(2);
      expect(oneShotFn).toHaveBeenCalledTimes(1);
      // The recurring job stays scheduled; only the one-shot job is removed.
      expect(scheduler.jobCount).toBe(1);

      scheduler.clear();
      expect(scheduler.jobCount).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });

  it("schedule() cancel handle stops future recurring runs", () => {
    vi.useFakeTimers();
    try {
      const scheduler = new JobScheduler();
      const fn = vi.fn();

      const handle = scheduler.schedule(50, fn);
      vi.advanceTimersByTime(120);
      expect(fn.mock.calls.length).toBeGreaterThanOrEqual(2);

      handle.cancel();
      const callsAtCancel = fn.mock.calls.length;
      vi.advanceTimersByTime(200);
      expect(fn.mock.calls.length).toBe(callsAtCancel);
    } finally {
      vi.useRealTimers();
    }
  });
});
