import { describe, it, expect, vi, beforeEach } from "vitest";
import { OfflineQueue, type OfflineQueueConfig } from "../src/offlineQueue.js";
import type { StellarSplitClient } from "../src/client.js";

interface MemoryStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
  clear(): void;
}

function createMemoryStorage(): MemoryStorage {
  const store = new Map<string, string>();
  return {
    getItem: (key) => (store.has(key) ? store.get(key)! : null),
    setItem: (key, value) => {
      store.set(key, value);
    },
    removeItem: (key) => {
      store.delete(key);
    },
    clear: () => store.clear(),
  };
}

function createMockClient(overrides: Record<string, any> = {}): StellarSplitClient {
  return {
    getInvoice: vi.fn(),
    pay: vi.fn().mockResolvedValue({}),
    emit: vi.fn(),
    ...overrides,
  } as unknown as StellarSplitClient;
}

const baseConfig = (overrides: Partial<OfflineQueueConfig> = {}): OfflineQueueConfig => ({
  enabled: true,
  maxQueueSize: 100,
  persistToStorage: true,
  ...overrides,
});

describe("OfflineQueue", () => {
  let storage: MemoryStorage;

  beforeEach(() => {
    storage = createMemoryStorage();
    (globalThis as any).localStorage = storage;
  });

  describe("queue persistence", () => {
    it("persists enqueued operations across reloads", () => {
      const client = createMockClient();
      const queue = new OfflineQueue(client, baseConfig());
      queue.enqueue("pay", [{ invoiceId: "inv-1", amount: 10n }]);
      queue.enqueue("pay", [{ invoiceId: "inv-2", amount: 20n }]);

      const reloaded = new OfflineQueue(client, baseConfig());
      const items = reloaded.getQueue();
      expect(items).toHaveLength(2);
      expect(items[0].method).toBe("pay");
      expect(items[0].args[0].invoiceId).toBe("inv-1");
      expect(items[0].args[0].amount).toBe(10n);
      expect(items[1].args[0].invoiceId).toBe("inv-2");
    });

    it("does not persist when persistToStorage is false", () => {
      const client = createMockClient();
      const queue = new OfflineQueue(client, baseConfig({ persistToStorage: false }));
      queue.enqueue("pay", [{ invoiceId: "inv-1" }]);

      const reloaded = new OfflineQueue(client, baseConfig({ persistToStorage: false }));
      expect(reloaded.getQueue()).toHaveLength(0);
    });

    it("recovers state from storage via recoverState", () => {
      const client = createMockClient();
      const queue = new OfflineQueue(client, baseConfig());
      queue.enqueue("pay", [{ invoiceId: "inv-1" }]);

      const fresh = new OfflineQueue(client, baseConfig({ persistToStorage: false }));
      expect(fresh.getQueue()).toHaveLength(0);
      const recovered = fresh.recoverState();
      expect(recovered).toHaveLength(1);
      expect(recovered[0].args[0].invoiceId).toBe("inv-1");
    });
  });

  describe("sync logic", () => {
    it("drains operations in order and clears synced items", async () => {
      const calls: string[] = [];
      const client = createMockClient({
        pay: vi.fn(async (arg: any) => {
          calls.push(arg.invoiceId);
          return {};
        }),
      });
      const queue = new OfflineQueue(client, baseConfig());
      queue.enqueue("pay", [{ invoiceId: "inv-1" }]);
      queue.enqueue("pay", [{ invoiceId: "inv-2" }]);

      const result = await queue.sync();
      expect(calls).toEqual(["inv-1", "inv-2"]);
      expect(result.synced).toBe(2);
      expect(result.failed).toBe(0);
      expect(result.conflicts).toBe(0);
      expect(result.operations).toHaveLength(2);
      expect(queue.getQueue()).toHaveLength(0);
      expect(client.emit).toHaveBeenCalledWith("queue:drained", undefined);
    });

    it("returns empty result when queue is empty", async () => {
      const client = createMockClient();
      const queue = new OfflineQueue(client, baseConfig());
      const result = await queue.sync();
      expect(result).toEqual({ synced: 0, failed: 0, conflicts: 0, operations: [] });
    });

    it("drain delegates to sync", async () => {
      const client = createMockClient();
      const queue = new OfflineQueue(client, baseConfig());
      queue.enqueue("pay", [{ invoiceId: "inv-1" }]);
      await queue.drain();
      expect(client.pay).toHaveBeenCalledTimes(1);
      expect(queue.getQueue()).toHaveLength(0);
    });
  });

  describe("conflict resolution", () => {
    it("skips operation with remote-wins when remote invoice is settled", async () => {
      const client = createMockClient({
        getInvoice: vi.fn().mockResolvedValue({ status: "paid" }),
      });
      const queue = new OfflineQueue(client, baseConfig({ conflictStrategy: "remote-wins" }));
      queue.enqueue("pay", [{ invoiceId: "inv-1" }]);

      const result = await queue.sync();
      expect(result.conflicts).toBe(1);
      expect(result.synced).toBe(0);
      expect(client.pay).not.toHaveBeenCalled();
      expect(client.emit).toHaveBeenCalledWith(
        "queue:conflict:resolved",
        expect.objectContaining({ strategy: "remote-wins" })
      );
    });

    it("applies operation with local-wins even when remote is settled", async () => {
      const client = createMockClient({
        getInvoice: vi.fn().mockResolvedValue({ status: "paid" }),
      });
      const queue = new OfflineQueue(client, baseConfig({ conflictStrategy: "local-wins" }));
      queue.enqueue("pay", [{ invoiceId: "inv-1" }]);

      const result = await queue.sync();
      expect(result.conflicts).toBe(1);
      expect(result.synced).toBe(1);
      expect(client.pay).toHaveBeenCalledTimes(1);
    });

    it("honors explicit conflict strategy argument over config", async () => {
      const client = createMockClient({
        getInvoice: vi.fn().mockResolvedValue({ status: "paid" }),
      });
      const queue = new OfflineQueue(client, baseConfig({ conflictStrategy: "local-wins" }));
      queue.enqueue("pay", [{ invoiceId: "inv-1" }]);

      const result = await queue.sync("remote-wins");
      expect(result.conflicts).toBe(1);
      expect(result.synced).toBe(0);
      expect(client.pay).not.toHaveBeenCalled();
    });

    it("proceeds when remote fetch fails", async () => {
      const client = createMockClient({
        getInvoice: vi.fn().mockRejectedValue(new Error("network")),
      });
      const queue = new OfflineQueue(client, baseConfig());
      queue.enqueue("pay", [{ invoiceId: "inv-1" }]);

      const result = await queue.sync();
      expect(result.synced).toBe(1);
      expect(result.conflicts).toBe(0);
    });
  });

  describe("recovery after failed sync", () => {
    it("counts failures and emits failure events", async () => {
      const client = createMockClient({
        pay: vi.fn().mockRejectedValue(new Error("boom")),
      });
      const queue = new OfflineQueue(client, baseConfig());
      queue.enqueue("pay", [{ invoiceId: "inv-1" }]);

      const result = await queue.sync();
      expect(result.failed).toBe(1);
      expect(result.synced).toBe(0);
      expect(client.emit).toHaveBeenCalledWith(
        "queue:operation:failed",
        expect.objectContaining({ error: expect.any(Error) })
      );
    });

    it("allows retrying failed operations after re-enqueue", async () => {
      const pay = vi
        .fn()
        .mockRejectedValueOnce(new Error("boom"))
        .mockResolvedValueOnce({});
      const client = createMockClient({ pay });
      const queue = new OfflineQueue(client, baseConfig());
      queue.enqueue("pay", [{ invoiceId: "inv-1" }]);

      const first = await queue.sync();
      expect(first.failed).toBe(1);

      queue.enqueue("pay", [{ invoiceId: "inv-1" }]);
      const second = await queue.sync();
      expect(second.synced).toBe(1);
      expect(second.failed).toBe(0);
      expect(queue.getQueue()).toHaveLength(0);
    });
  });

  describe("cleanup", () => {
    it("clear empties queue and storage", () => {
      const client = createMockClient();
      const queue = new OfflineQueue(client, baseConfig());
      queue.enqueue("pay", [{ invoiceId: "inv-1" }]);
      expect(queue.getQueue()).toHaveLength(1);

      queue.clear();
      expect(queue.getQueue()).toHaveLength(0);

      const reloaded = new OfflineQueue(client, baseConfig());
      expect(reloaded.getQueue()).toHaveLength(0);
    });

    it("evicts oldest operation when maxQueueSize exceeded", () => {
      const client = createMockClient();
      const queue = new OfflineQueue(client, baseConfig({ maxQueueSize: 2 }));
      queue.enqueue("pay", [{ invoiceId: "inv-1" }]);
      queue.enqueue("pay", [{ invoiceId: "inv-2" }]);
      queue.enqueue("pay", [{ invoiceId: "inv-3" }]);

      const items = queue.getQueue();
      expect(items).toHaveLength(2);
      expect(items[0].args[0].invoiceId).toBe("inv-2");
      expect(items[1].args[0].invoiceId).toBe("inv-3");
    });

    it("does not enqueue when disabled", () => {
      const client = createMockClient();
      const queue = new OfflineQueue(client, baseConfig({ enabled: false }));
      queue.enqueue("pay", [{ invoiceId: "inv-1" }]);
      expect(queue.getQueue()).toHaveLength(0);
    });
  });
});
