import { describe, it, expect, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import { PersistentTxQueue, type PendingItem } from "../src/persistentQueue.js";

function makeItem(id: string, payload: unknown = {}): PendingItem {
  return { id, payload, enqueuedAt: Date.now() };
}

// Fresh IDBFactory per test — prevents cross-test database bleed
beforeEach(() => {
  (globalThis as Record<string, unknown>).indexedDB = new IDBFactory();
});

describe("PersistentTxQueue – persistence round-trip", () => {
  it("hydrate() restores previously enqueued items", async () => {
    const q1 = new PersistentTxQueue();
    await q1.enqueue(makeItem("a", { invoiceId: 1 }));
    await q1.enqueue(makeItem("b", { invoiceId: 2 }));

    // Simulate a reload: new instance, same IDB factory
    const q2 = new PersistentTxQueue();
    const restored = await q2.hydrate();

    expect(restored.map((i) => i.id)).toEqual(["a", "b"]);
  });

  it("process() removes items from IndexedDB after success", async () => {
    const q = new PersistentTxQueue();
    await q.enqueue(makeItem("x"));
    await q.enqueue(makeItem("y"));

    const processed: string[] = [];
    await q.process(async (item) => { processed.push(item.id); });

    expect(processed).toEqual(["x", "y"]);
    expect(q.peek()).toHaveLength(0);

    // A fresh queue hydrating from the same IDB should find nothing
    const q2 = new PersistentTxQueue();
    const restored = await q2.hydrate();
    expect(restored).toHaveLength(0);
  });

  it("failed process() leaves item in IndexedDB", async () => {
    const q = new PersistentTxQueue();
    await q.enqueue(makeItem("fail-me"));

    await expect(
      q.process(async () => { throw new Error("network error"); })
    ).rejects.toThrow("network error");

    const q2 = new PersistentTxQueue();
    const restored = await q2.hydrate();
    expect(restored.map((i) => i.id)).toContain("fail-me");
  });
});

describe("PersistentTxQueue – IndexedDB unavailable fallback", () => {
  it("operates in-memory only when indexedDB is undefined", async () => {
    delete (globalThis as Record<string, unknown>).indexedDB;

    const q = new PersistentTxQueue();
    await q.enqueue(makeItem("m1"));
    expect(q.peek()).toHaveLength(1);

    const processed: string[] = [];
    await q.process(async (item) => { processed.push(item.id); });
    expect(processed).toEqual(["m1"]);
    expect(q.peek()).toHaveLength(0);

    // hydrate() returns empty without throwing
    const items = await q.hydrate();
    expect(items).toEqual([]);
  });
});
