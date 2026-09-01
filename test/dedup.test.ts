import { describe, it, expect, beforeEach } from "vitest";
import { createHash } from "crypto";
import {
  generateIdempotencyKey,
  isKnownKey,
  registerKey,
  clearKeys,
  Deduplicator,
} from "../src/dedup.js";
import * as rootExports from "../src/index.js";

describe("dedup module - generateIdempotencyKey & Key Registry", () => {
  beforeEach(() => {
    clearKeys();
  });

  describe("generateIdempotencyKey", () => {
    it("generates deterministic keys for identical parameters without nonce", () => {
      const params = {
        invoiceId: "inv_12345",
        payer: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYORTMXZAXGIIO7NUM9",
        amount: 10000000n,
      };

      const key1 = generateIdempotencyKey(params);
      const key2 = generateIdempotencyKey(params);

      expect(key1).toBe(key2);
      expect(key1).toMatch(/^[a-f0-9]{64}$/);

      const expectedPayload = `${params.invoiceId}:${params.payer}:${params.amount.toString()}`;
      const expectedHash = createHash("sha256").update(expectedPayload).digest("hex");
      expect(key1).toBe(expectedHash);
    });

    it("generates deterministic keys for identical parameters with nonce", () => {
      const params = {
        invoiceId: "inv_12345",
        payer: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFXYORTMXZAXGIIO7NUM9",
        amount: 10000000n,
        nonce: "nonce_abc",
      };

      const key1 = generateIdempotencyKey(params);
      const key2 = generateIdempotencyKey(params);

      expect(key1).toBe(key2);
      expect(key1).toMatch(/^[a-f0-9]{64}$/);

      const expectedPayload = `${params.invoiceId}:${params.payer}:${params.amount.toString()}:${params.nonce}`;
      const expectedHash = createHash("sha256").update(expectedPayload).digest("hex");
      expect(key1).toBe(expectedHash);
    });

    it("produces different keys when amount differs", () => {
      const baseParams = {
        invoiceId: "inv_100",
        payer: "GABC",
      };

      const key1 = generateIdempotencyKey({ ...baseParams, amount: 100n });
      const key2 = generateIdempotencyKey({ ...baseParams, amount: 200n });

      expect(key1).not.toBe(key2);
    });

    it("produces different keys when invoiceId differs", () => {
      const baseParams = {
        payer: "GABC",
        amount: 100n,
      };

      const key1 = generateIdempotencyKey({ ...baseParams, invoiceId: "inv_1" });
      const key2 = generateIdempotencyKey({ ...baseParams, invoiceId: "inv_2" });

      expect(key1).not.toBe(key2);
    });

    it("produces different keys when payer differs", () => {
      const baseParams = {
        invoiceId: "inv_1",
        amount: 100n,
      };

      const key1 = generateIdempotencyKey({ ...baseParams, payer: "GA" });
      const key2 = generateIdempotencyKey({ ...baseParams, payer: "GB" });

      expect(key1).not.toBe(key2);
    });

    it("produces different keys when nonce is provided vs omitted", () => {
      const baseParams = {
        invoiceId: "inv_100",
        payer: "GABC",
        amount: 500n,
      };

      const keyWithoutNonce = generateIdempotencyKey(baseParams);
      const keyWithNonce = generateIdempotencyKey({ ...baseParams, nonce: "n1" });

      expect(keyWithoutNonce).not.toBe(keyWithNonce);
    });

    it("produces different keys for different nonce values", () => {
      const baseParams = {
        invoiceId: "inv_100",
        payer: "GABC",
        amount: 500n,
      };

      const key1 = generateIdempotencyKey({ ...baseParams, nonce: "n1" });
      const key2 = generateIdempotencyKey({ ...baseParams, nonce: "n2" });

      expect(key1).not.toBe(key2);
    });
  });

  describe("isKnownKey, registerKey, clearKeys", () => {
    it("returns false for unregistered key", () => {
      const key = generateIdempotencyKey({
        invoiceId: "inv_1",
        payer: "GABC",
        amount: 100n,
      });

      expect(isKnownKey(key)).toBe(false);
    });

    it("returns true for registered key after registerKey", () => {
      const key = generateIdempotencyKey({
        invoiceId: "inv_1",
        payer: "GABC",
        amount: 100n,
      });

      registerKey(key);
      expect(isKnownKey(key)).toBe(true);
    });

    it("does not affect other keys when one key is registered", () => {
      const key1 = generateIdempotencyKey({
        invoiceId: "inv_1",
        payer: "GABC",
        amount: 100n,
      });
      const key2 = generateIdempotencyKey({
        invoiceId: "inv_2",
        payer: "GABC",
        amount: 100n,
      });

      registerKey(key1);
      expect(isKnownKey(key1)).toBe(true);
      expect(isKnownKey(key2)).toBe(false);
    });

    it("clearKeys resets state so registered keys return false", () => {
      const key1 = generateIdempotencyKey({
        invoiceId: "inv_1",
        payer: "GABC",
        amount: 100n,
      });
      const key2 = generateIdempotencyKey({
        invoiceId: "inv_2",
        payer: "GDEF",
        amount: 200n,
      });

      registerKey(key1);
      registerKey(key2);
      expect(isKnownKey(key1)).toBe(true);
      expect(isKnownKey(key2)).toBe(true);

      clearKeys();

      expect(isKnownKey(key1)).toBe(false);
      expect(isKnownKey(key2)).toBe(false);
    });
  });

  describe("Root exports check", () => {
    it("exports generateIdempotencyKey, isKnownKey, registerKey, clearKeys, and Deduplicator from root index", () => {
      expect(typeof rootExports.generateIdempotencyKey).toBe("function");
      expect(typeof rootExports.isKnownKey).toBe("function");
      expect(typeof rootExports.registerKey).toBe("function");
      expect(typeof rootExports.clearKeys).toBe("function");
      expect(typeof rootExports.Deduplicator).toBe("function");
    });
  });

  describe("Deduplicator existing functionality", () => {
    it("deduplicates concurrent async function calls", async () => {
      const deduplicator = new Deduplicator<string>();
      let callCount = 0;

      const slowFn = async () => {
        callCount++;
        return "result-1";
      };

      const [res1, res2] = await Promise.all([
        deduplicator.dedupe("key1", slowFn),
        deduplicator.dedupe("key1", slowFn),
      ]);

      expect(res1).toBe("result-1");
      expect(res2).toBe("result-1");
      expect(callCount).toBe(1);
      expect(deduplicator.getDedupStats()).toEqual({ deduped: 1, total: 2 });
      expect(deduplicator.cacheHitRate).toBe(0.5);
    });
  });
});
