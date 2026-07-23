import { describe, it, expect, beforeEach } from "vitest";
import { SimpleCache } from "../src/cache.js";
import {
  registerUpgradeMigration,
  clearUpgradeMigrations,
  makeMigrationCallback,
} from "../src/upgradeMigrationRunner.js";

beforeEach(() => clearUpgradeMigrations());

const makeEvent = (previousHash: string, newHash: string) => ({
  previousHash,
  newHash,
  detectedAt: Date.now(),
});

describe("registerUpgradeMigration / makeMigrationCallback", () => {
  it("runs the registered migration on a matching upgrade", () => {
    const cache = new SimpleCache<{ amount: number }>(60_000);
    cache.set("inv-1", { amount: 100 });

    registerUpgradeMigration<{ amount: number }>(
      "hash-v1",
      "hash-v2",
      (entries) => {
        const next = new Map(entries);
        for (const [k, v] of next) next.set(k, { ...v, amount: v.amount * 2 });
        return next;
      }
    );

    const cb = makeMigrationCallback(
      cache,
      () => cache.entries(),
      (next) => cache.replaceAll(next)
    );

    cb(makeEvent("hash-v1", "hash-v2"));

    expect(cache.get("inv-1")).toEqual({ amount: 200 });
  });

  it("runs multiple migrations in registration order", () => {
    const cache = new SimpleCache<number>(60_000);
    cache.set("x", 1);

    registerUpgradeMigration<number>("v1", "v2", (m) => {
      const n = new Map(m);
      n.set("x", (n.get("x") ?? 0) + 10);
      return n;
    });
    registerUpgradeMigration<number>("v1", "v2", (m) => {
      const n = new Map(m);
      n.set("x", (n.get("x") ?? 0) * 3);
      return n;
    });

    const cb = makeMigrationCallback(
      cache,
      () => cache.entries(),
      (next) => cache.replaceAll(next)
    );

    cb(makeEvent("v1", "v2"));

    // (1 + 10) * 3 = 33
    expect(cache.get("x")).toBe(33);
  });

  it("invalidates all cache entries for unknown version transitions", () => {
    const cache = new SimpleCache<string>(60_000);
    cache.set("a", "stale");
    cache.set("b", "stale");

    // No migration registered for v9 -> v10

    const cb = makeMigrationCallback(
      cache,
      () => cache.entries(),
      (next) => cache.replaceAll(next)
    );

    cb(makeEvent("v9", "v10"));

    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeUndefined();
  });
});
