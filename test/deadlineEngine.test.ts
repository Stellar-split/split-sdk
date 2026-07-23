import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { DeadlineEngine } from "../src/deadlineEngine.js";

function setNowEpochSeconds(sec: number) {
  vi.setSystemTime(sec * 1000);
}

describe("DeadlineEngine", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("computes business-hours seconds across weekend", () => {
    // Fri 2024-01-05 16:00:00 America/New_York (open until 17:00)
    const tz = "America/New_York";
    const engine = new DeadlineEngine();

    // Deadline at Fri 2024-01-05 18:00:00 (2h later UTC offset still -5)
    // Effective business-hours from Fri 16:00 to Fri 17:00 = 1h, then skip weekend to Mon 9:00.
    // Business hours Mon-Fri 9-17.
    // We expect remaining business seconds = Fri 1h + Mon 9-17 window until deadline (Mon? actually deadline is Fri 18, so after 18 there is no more)
    // Our deadline is only 2h after, so expected business seconds = 1h.

    // Use epoch by constructing Date in runtime tz.
    const deadlineDate = new Date("2024-01-05T18:00:00-05:00");
    const nowDate = new Date("2024-01-05T16:00:00-05:00");

    const deadline = Math.floor(deadlineDate.getTime() / 1000);
    const now = Math.floor(nowDate.getTime() / 1000);
    setNowEpochSeconds(now);

    const { secondsRemaining } = engine.getCountdown(deadline, {
      timezone: tz,
      businessHours: {
        start: 9,
        end: 17,
        days: [1, 2, 3, 4, 5],
      },
    });

    expect(secondsRemaining).toBe(3600);
  });

  it("fires callback after mock time advance and only once", () => {
    const engine = new DeadlineEngine({ intervalMs: 1000 });
    const tz = "UTC";

    const deadline = 1700000000;
    setNowEpochSeconds(deadline - 2);

    const cb = vi.fn();
    engine.registerExpiryCallback(deadline, "inv-1", (invoiceId) =>
      cb(invoiceId),
    );

    // advance 2 seconds to deadline
    vi.advanceTimersByTime(2000);

    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith("inv-1");

    // advance further; should not fire again
    vi.advanceTimersByTime(5000);
    expect(cb).toHaveBeenCalledTimes(1);

    engine.destroy();
  });

  it("unsubscribe prevents callback", () => {
    const engine = new DeadlineEngine({ intervalMs: 1000 });
    const deadline = 1700001000;

    setNowEpochSeconds(deadline - 1);

    const cb = vi.fn();
    const unsubscribe = engine.registerExpiryCallback(
      deadline,
      "inv-1",
      (invoiceId) => cb(invoiceId),
    );

    unsubscribe();
    vi.advanceTimersByTime(2000);

    expect(cb).toHaveBeenCalledTimes(0);

    engine.destroy();
  });

  it("multiple callbacks on same deadline all fire", () => {
    const engine = new DeadlineEngine({ intervalMs: 1000 });
    const deadline = 1700002000;

    setNowEpochSeconds(deadline - 1);

    const cb1 = vi.fn();
    const cb2 = vi.fn();

    engine.registerExpiryCallback(deadline, "inv-1", (invoiceId) =>
      cb1(invoiceId),
    );
    engine.registerExpiryCallback(deadline, "inv-2", (invoiceId) =>
      cb2(invoiceId),
    );

    vi.advanceTimersByTime(2000);

    expect(cb1).toHaveBeenCalledTimes(1);
    expect(cb1).toHaveBeenCalledWith("inv-1");

    expect(cb2).toHaveBeenCalledTimes(1);
    expect(cb2).toHaveBeenCalledWith("inv-2");

    engine.destroy();
  });

  it("destroy clears callbacks", () => {
    const engine = new DeadlineEngine({ intervalMs: 1000 });
    const deadline = 1700003000;

    setNowEpochSeconds(deadline - 1);

    const cb = vi.fn();
    engine.registerExpiryCallback(deadline, "inv-1", (invoiceId) =>
      cb(invoiceId),
    );

    engine.destroy();
    vi.advanceTimersByTime(5000);

    expect(cb).toHaveBeenCalledTimes(0);
  });
});
