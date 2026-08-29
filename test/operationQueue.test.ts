import { describe, it, expect, vi, beforeEach } from "vitest";
import { OperationQueue, OperationPriority } from "../src/operationQueue.js";

// ---------------------------------------------------------------------------
// OperationPriority constants
// ---------------------------------------------------------------------------

describe("OperationPriority constants", () => {
  it("exports LOW = 1", () => {
    expect(OperationPriority.LOW).toBe(1);
  });

  it("exports NORMAL = 5", () => {
    expect(OperationPriority.NORMAL).toBe(5);
  });

  it("exports HIGH = 10", () => {
    expect(OperationPriority.HIGH).toBe(10);
  });

  it("HIGH > NORMAL > LOW", () => {
    expect(OperationPriority.HIGH).toBeGreaterThan(OperationPriority.NORMAL);
    expect(OperationPriority.NORMAL).toBeGreaterThan(OperationPriority.LOW);
  });
});

// ---------------------------------------------------------------------------
// OperationQueue — online (immediate execution)
// ---------------------------------------------------------------------------

describe("OperationQueue — online", () => {
  it("executes operations immediately when online", async () => {
    const healthCheck = vi.fn().mockResolvedValue(true);
    const queue = new OperationQueue(healthCheck);

    const executor = vi.fn().mockResolvedValue("result");
    const result = await queue.enqueue("test", [], executor);

    expect(result).toBe("result");
    expect(executor).toHaveBeenCalledOnce();
  });

  it("queueSize is 0 when online (operations are not buffered)", async () => {
    const queue = new OperationQueue(vi.fn().mockResolvedValue(true));
    void queue.enqueue("op", [], vi.fn().mockResolvedValue(undefined));
    expect(queue.queueSize).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// OperationQueue — offline buffering
// ---------------------------------------------------------------------------

describe("OperationQueue — offline buffering", () => {
  it("buffers operations when offline and drains on setOnline(true)", async () => {
    const queue = new OperationQueue(vi.fn().mockResolvedValue(false));
    queue.setOnline(false);

    const order: string[] = [];
    const p1 = queue.enqueue("op1", [], async () => { order.push("op1"); return "a"; });
    const p2 = queue.enqueue("op2", [], async () => { order.push("op2"); return "b"; });

    expect(queue.queueSize).toBe(2);

    queue.setOnline(true);

    expect(await p1).toBe("a");
    expect(await p2).toBe("b");
    expect(queue.queueSize).toBe(0);
  });

  it("drains in priority order: HIGH before NORMAL before LOW", async () => {
    const queue = new OperationQueue(vi.fn().mockResolvedValue(false));
    queue.setOnline(false);

    const order: string[] = [];
    const pLow    = queue.enqueue("low",    [], async () => { order.push("LOW");    }, OperationPriority.LOW);
    const pNormal = queue.enqueue("normal", [], async () => { order.push("NORMAL"); }, OperationPriority.NORMAL);
    const pHigh   = queue.enqueue("high",   [], async () => { order.push("HIGH");   }, OperationPriority.HIGH);

    expect(queue.queueSize).toBe(3);

    queue.setOnline(true);

    await Promise.all([pLow, pNormal, pHigh]);

    expect(order).toEqual(["HIGH", "NORMAL", "LOW"]);
  });

  it("defaults to NORMAL priority when none is specified", async () => {
    const queue = new OperationQueue(vi.fn().mockResolvedValue(false));
    queue.setOnline(false);

    const order: string[] = [];
    // LOW enqueued first but HIGH enqueued last — HIGH should drain first
    const pLow    = queue.enqueue("low",    [], async () => { order.push("LOW");    }, OperationPriority.LOW);
    const pDefault = queue.enqueue("def",   [], async () => { order.push("DEFAULT"); });  // no priority → NORMAL
    const pHigh   = queue.enqueue("high",   [], async () => { order.push("HIGH");   }, OperationPriority.HIGH);

    queue.setOnline(true);
    await Promise.all([pLow, pDefault, pHigh]);

    expect(order[0]).toBe("HIGH");
    expect(order[1]).toBe("DEFAULT");
    expect(order[2]).toBe("LOW");
  });
});

// ---------------------------------------------------------------------------
// OperationQueue — start / stop polling
// ---------------------------------------------------------------------------

describe("OperationQueue — start/stop", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it("start() kicks off polling and stop() clears the interval", async () => {
    const healthCheck = vi.fn().mockResolvedValue(true);
    const queue = new OperationQueue(healthCheck, 1000);

    queue.start();
    // Advance past one interval
    await vi.advanceTimersByTimeAsync(1000);
    expect(healthCheck).toHaveBeenCalledTimes(1);

    queue.stop();
    // Advance another interval — healthCheck should NOT be called again
    await vi.advanceTimersByTimeAsync(1000);
    expect(healthCheck).toHaveBeenCalledTimes(1);

    vi.useRealTimers();
  });

  it("calling start() twice does not create a second interval", async () => {
    const healthCheck = vi.fn().mockResolvedValue(true);
    const queue = new OperationQueue(healthCheck, 1000);

    queue.start();
    queue.start(); // duplicate call

    await vi.advanceTimersByTimeAsync(1000);
    // If two intervals were created the mock would be called twice
    expect(healthCheck).toHaveBeenCalledTimes(1);

    queue.stop();
    vi.useRealTimers();
  });
});
