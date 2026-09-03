import { describe, expect, it, vi } from "vitest";
import { RollbackCoordinator, RollbackTimeoutError } from "../src/splitRollbackCoordinator.js";

describe("RollbackCoordinator", () => {
  it("cleans up partial state when rollback execution times out", async () => {
    vi.useFakeTimers();

    const coordinator = new RollbackCoordinator();
    coordinator.begin("split-1", "invoice-1", [{ recipient: "GDEST", amount: 10n }]);

    const cleanup = vi.fn().mockRejectedValue(new Error("delete failed"));
    const promise = coordinator.initiateRollbackWithTimeout("split-1", {
      timeoutMs: 100,
      execute: () => new Promise<void>(() => undefined),
      cleanup,
    });

    // Attach rejection handler before advancing timers to avoid unhandled rejection warning.
    const assertRejects = expect(promise).rejects.toBeInstanceOf(RollbackTimeoutError);
    await vi.advanceTimersByTimeAsync(100);
    await assertRejects;
    expect(coordinator.getRollbackRecord("split-1")).toBeUndefined();
    expect(coordinator.getCheckpointFor("split-1")).toBeUndefined();

    vi.useRealTimers();
  });
});
