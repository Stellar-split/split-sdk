import { describe, expect, it } from "vitest";
import { ServiceDegradationTracker } from "../src/degradation.js";

describe("ServiceDegradationTracker", () => {
  it("reverts to healthy after the recovery window expires", () => {
    let now = 0;
    const tracker = new ServiceDegradationTracker({
      failureThreshold: 2,
      recoveryWindowMs: 1000,
      now: () => now,
    });

    tracker.recordFailure();
    tracker.recordFailure();
    expect(tracker.getState()).toBe("degraded");

    now = 1001;
    expect(tracker.getState()).toBe("healthy");
  });
});
