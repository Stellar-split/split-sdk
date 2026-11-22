import { describe, it, expect } from "vitest";
import { PriorityQueue } from "../src/priorityQueue.js";

/** A task that stays pending until released. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((r) => (release = r));
  return { promise, release };
}

describe("PriorityQueue", () => {
  it("runs the first enqueued task immediately, then orders by priority", async () => {
    const q = new PriorityQueue();
    const order: string[] = [];
    const g = gate();
    const task = (name: string) => async () => {
      order.push(name);
      return name;
    };

    const first = q.enqueue("low", async () => {
      await g.promise;
      order.push("first");
    });
    const rest = [
      q.enqueue("low", task("low")),
      q.enqueue("normal", task("normal")),
      q.enqueue("high", task("high")),
    ];
    g.release();
    await Promise.all([first, ...rest]);
    expect(order).toEqual(["first", "high", "normal", "low"]);
  });

  it("is FIFO within the same priority level (no starvation among peers)", async () => {
    const q = new PriorityQueue();
    const order: number[] = [];
    const g = gate();
    const p = [q.enqueue("normal", () => g.promise)];
    for (let i = 0; i < 10; i++) {
      p.push(q.enqueue("normal", async () => void order.push(i)));
    }
    g.release();
    await Promise.all(p);
    expect(order).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("resolves with the task result and rejects with its error without stopping the queue", async () => {
    const q = new PriorityQueue();
    const g = gate();
    const a = q.enqueue("normal", async () => {
      await g.promise;
      return 1;
    });
    const b = q.enqueue("normal", async () => {
      throw new Error("fail");
    });
    const c = q.enqueue("normal", async () => 3);
    g.release();
    expect(await a).toBe(1);
    await expect(b).rejects.toThrow("fail");
    expect(await c).toBe(3);
  });

  it("executes tasks serially", async () => {
    const q = new PriorityQueue();
    let active = 0;
    let maxActive = 0;
    const work = async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await Promise.resolve();
      active--;
    };
    await Promise.all(Array.from({ length: 5 }, () => q.enqueue("high", work)));
    expect(maxActive).toBe(1);
  });

  it("interleaves late high priority tasks ahead of queued low ones", async () => {
    const q = new PriorityQueue();
    const order: string[] = [];
    const g = gate();
    const all = [
      q.enqueue("normal", () => g.promise),
      q.enqueue("low", async () => void order.push("low1")),
      q.enqueue("low", async () => void order.push("low2")),
      q.enqueue("high", async () => void order.push("high")),
    ];
    g.release();
    await Promise.all(all);
    expect(order).toEqual(["high", "low1", "low2"]);
  });

  describe("edge cases", () => {
    it("drain resolves immediately when idle and after pending work completes", async () => {
      const q = new PriorityQueue();
      await q.drain();
      let done = false;
      const p = q.enqueue("normal", async () => {
        await Promise.resolve();
        done = true;
      });
      await q.drain();
      expect(done).toBe(true);
      await p;
    });

    it("rejects new tasks after shutdown but finishes queued ones", async () => {
      const q = new PriorityQueue();
      const p = q.enqueue("normal", async () => "ok");
      await q.shutdown();
      expect(await p).toBe("ok");
      await expect(q.enqueue("high", async () => 1)).rejects.toThrow("Queue is shut down");
    });

    it("can be reused after draining", async () => {
      const q = new PriorityQueue();
      expect(await q.enqueue("low", async () => 1)).toBe(1);
      await q.drain();
      expect(await q.enqueue("low", async () => 2)).toBe(2);
    });
  });
});
