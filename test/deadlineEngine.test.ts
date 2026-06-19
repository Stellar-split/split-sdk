import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DeadlineEngine } from "../src/deadlineEngine.js";

describe("DeadlineEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("counts only business-hours seconds across a weekend", () => {
    vi.setSystemTime(new Date("2026-06-19T21:00:00.000Z")); // Friday 5pm in New York
    const engine = new DeadlineEngine();
    const monday11amNewYork = Date.parse("2026-06-22T15:00:00.000Z") / 1000;

    const countdown = engine.getCountdown(monday11amNewYork, {
      timezone: "America/New_York",
      businessHours: { start: 9, end: 17, days: [1, 2, 3, 4, 5] },
    });

    expect(countdown.expired).toBe(false);
    expect(countdown.secondsRemaining).toBe(2 * 60 * 60);
    expect(countdown.display).toBe("2h");
    expect(countdown.localDisplay).toContain("2026");
  });

  it("fires a registered callback once after mock time advances past the deadline", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const engine = new DeadlineEngine({ pollIntervalMs: 100 });
    const cb = vi.fn();

    engine.registerExpiryCallback(Math.floor(Date.now() / 1000) + 1, "invoice-1", cb);

    await vi.advanceTimersByTimeAsync(1_100);
    await vi.advanceTimersByTimeAsync(1_000);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("invoice-1");
  });

  it("unsubscribe prevents a registered callback from firing", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const engine = new DeadlineEngine({ pollIntervalMs: 100 });
    const cb = vi.fn();
    const unsubscribe = engine.registerExpiryCallback(
      Math.floor(Date.now() / 1000) + 1,
      "invoice-2",
      cb
    );

    unsubscribe();
    await vi.advanceTimersByTimeAsync(1_100);

    expect(cb).not.toHaveBeenCalled();
  });

  it("fires multiple callbacks registered for the same deadline", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const engine = new DeadlineEngine({ pollIntervalMs: 100 });
    const first = vi.fn();
    const second = vi.fn();
    const deadline = Math.floor(Date.now() / 1000) + 1;

    engine.registerExpiryCallback(deadline, "invoice-a", first);
    engine.registerExpiryCallback(deadline, "invoice-b", second);

    await vi.advanceTimersByTimeAsync(1_100);

    expect(first).toHaveBeenCalledWith("invoice-a");
    expect(second).toHaveBeenCalledWith("invoice-b");
  });

  it("destroy clears callbacks and the shared interval", async () => {
    vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z"));
    const engine = new DeadlineEngine({ pollIntervalMs: 100 });
    const cb = vi.fn();

    engine.registerExpiryCallback(Math.floor(Date.now() / 1000) + 1, "invoice-3", cb);
    engine.destroy();
    await vi.advanceTimersByTimeAsync(1_100);

    expect(cb).not.toHaveBeenCalled();
  });
});
