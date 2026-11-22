import { describe, it, expect } from "vitest";
import { PriorityQueue } from "../src/priorityQueue.js";

describe("PriorityQueue custom levels and stats", () => {
  it("honours custom levels and tracks stats", async () => {
    const q = new PriorityQueue({ critical: -1 });
    const order: string[] = [];
    const run = (n: string) => async () => { order.push(n); };
    const ps = [
      q.enqueue("low", run("first")), // starts immediately
      q.enqueue("low", run("low")),
      q.enqueue("critical", run("critical")),
      q.enqueue("high", run("high")),
    ];
    expect(q.size).toBe(3);
    await Promise.all(ps);
    expect(order).toEqual(["first", "critical", "high", "low"]);
    expect(q.getStats()).toEqual({ queued: 0, completed: 4, failed: 0 });
    await expect(q.enqueue("bogus", async () => 1)).rejects.toThrow("Unknown priority");
  });
});
