import { describe, it, expect, beforeEach } from "vitest";
import { IdempotencyManager } from "../src/idempotency.js";

describe("IdempotencyManager", () => {
  let manager: IdempotencyManager;

  beforeEach(() => {
    manager = new IdempotencyManager({ ttlMs: 300_000 });
  });

  it("generates deterministic keys for the same input", () => {
    const key1 = manager.generateKey("GABC", "op-xdr-1");
    const key2 = manager.generateKey("GABC", "op-xdr-1");
    expect(key1).toBe(key2);
  });

  it("generates different keys for different source addresses", () => {
    const key1 = manager.generateKey("GABC", "op-xdr-1");
    const key2 = manager.generateKey("GDEF", "op-xdr-1");
    expect(key1).not.toBe(key2);
  });

  it("generates different keys for different operations", () => {
    const key1 = manager.generateKey("GABC", "op-xdr-1");
    const key2 = manager.generateKey("GABC", "op-xdr-2");
    expect(key1).not.toBe(key2);
  });

  it("returns duplicate=true for a previously claimed key", () => {
    const key = manager.generateKey("GABC", "op-xdr-1");
    const first = manager.tryClaim(key, { txHash: "hash-1" });
    expect(first.duplicate).toBe(false);

    const second = manager.tryClaim(key, { txHash: "hash-2" });
    expect(second.duplicate).toBe(true);
    expect(second.existing?.txHash).toBe("hash-1");
  });

  it("returns the stored result for duplicate keys", () => {
    const key = manager.generateKey("GABC", "op-xdr-1");
    manager.tryClaim(key, { txHash: "hash-1" });

    const result = manager.getResult(key);
    expect(result).not.toBeNull();
    expect(result!.txHash).toBe("hash-1");
  });

  it("returns null for unknown keys", () => {
    const result = manager.getResult("unknown-key");
    expect(result).toBeNull();
  });

  it("isDuplicate returns true for claimed keys", () => {
    const key = manager.generateKey("GABC", "op-xdr-1");
    expect(manager.isDuplicate(key)).toBe(false);
    manager.tryClaim(key, { txHash: "hash-1" });
    expect(manager.isDuplicate(key)).toBe(true);
  });

  it("evicts expired entries", () => {
    const shortManager = new IdempotencyManager({ ttlMs: -1 });
    const key = shortManager.generateKey("GABC", "op-xdr-1");
    shortManager.tryClaim(key, { txHash: "hash-1" });

    const result = shortManager.getResult(key);
    expect(result).toBeNull();
  });

  it("evicts oldest entry when at max capacity", () => {
    const smallManager = new IdempotencyManager({ ttlMs: 300_000, maxEntries: 2 });

    const key1 = smallManager.generateKey("G1", "op-1");
    const key2 = smallManager.generateKey("G2", "op-2");
    smallManager.tryClaim(key1, { txHash: "hash-1" });
    smallManager.tryClaim(key2, { txHash: "hash-2" });

    const key3 = smallManager.generateKey("G3", "op-3");
    smallManager.tryClaim(key3, { txHash: "hash-3" });

    expect(smallManager.getResult(key1)).toBeNull();
    expect(smallManager.getResult(key2)).not.toBeNull();
    expect(smallManager.getResult(key3)).not.toBeNull();
  });

  it("clear removes all entries", () => {
    const key = manager.generateKey("GABC", "op-xdr-1");
    manager.tryClaim(key, { txHash: "hash-1" });
    manager.clear();
    expect(manager.getResult(key)).toBeNull();
  });
});
