import { describe, it, expect, beforeEach } from "vitest";
import {
  Deduplicator,
  generateIdempotencyKey,
  isKnownKey,
  registerKey,
  clearKeys,
} from "../src/dedup.js";
import * as IndexExports from "../src/index.js";

describe("Deduplication & Idempotency Key Engine (Issue #612)", () => {
  beforeEach(() => {
    clearKeys();
  });

  it("exports idempotency functions from index.ts", () => {
    expect(typeof IndexExports.generateIdempotencyKey).toBe("function");
    expect(typeof IndexExports.isKnownKey).toBe("function");
    expect(typeof IndexExports.registerKey).toBe("function");
    expect(typeof IndexExports.clearKeys).toBe("function");
    expect(IndexExports.Deduplicator).toBeDefined();
  });

  it("generates deterministic 64-character hex SHA-256 key from identical parameters", () => {
    const params1 = {
      invoiceId: "inv_123456",
      payer: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGOBJZ5GYWMSZ6TRECE",
      amount: 10000000n,
    };
    const params2 = {
      invoiceId: "inv_123456",
      payer: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGOBJZ5GYWMSZ6TRECE",
      amount: 10000000n,
    };

    const key1 = generateIdempotencyKey(params1);
    const key2 = generateIdempotencyKey(params2);

    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces distinct keys when amount differs", () => {
    const key1 = generateIdempotencyKey({
      invoiceId: "inv_100",
      payer: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGOBJZ5GYWMSZ6TRECE",
      amount: 500n,
    });
    const key2 = generateIdempotencyKey({
      invoiceId: "inv_100",
      payer: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGOBJZ5GYWMSZ6TRECE",
      amount: 501n,
    });

    expect(key1).not.toBe(key2);
  });

  it("produces distinct keys when invoiceId differs", () => {
    const key1 = generateIdempotencyKey({
      invoiceId: "inv_aaa",
      payer: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGOBJZ5GYWMSZ6TRECE",
      amount: 1000n,
    });
    const key2 = generateIdempotencyKey({
      invoiceId: "inv_bbb",
      payer: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGOBJZ5GYWMSZ6TRECE",
      amount: 1000n,
    });

    expect(key1).not.toBe(key2);
  });

  it("produces distinct keys when payer differs", () => {
    const key1 = generateIdempotencyKey({
      invoiceId: "inv_1",
      payer: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGOBJZ5GYWMSZ6TRECE",
      amount: 1000n,
    });
    const key2 = generateIdempotencyKey({
      invoiceId: "inv_1",
      payer: "GCKICEQ2SA6K6SQ7UGLUP3GHW5WGYE6GYX3GDFQ527V4MGFE6Z3Z2RDT",
      amount: 1000n,
    });

    expect(key1).not.toBe(key2);
  });

  it("changes key when nonce is provided", () => {
    const baseParams = {
      invoiceId: "inv_nonce_test",
      payer: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGOBJZ5GYWMSZ6TRECE",
      amount: 2500000n,
    };

    const keyWithoutNonce = generateIdempotencyKey(baseParams);
    const keyWithNonce1 = generateIdempotencyKey({ ...baseParams, nonce: "nonce-abc" });
    const keyWithNonce2 = generateIdempotencyKey({ ...baseParams, nonce: "nonce-xyz" });

    expect(keyWithoutNonce).not.toBe(keyWithNonce1);
    expect(keyWithNonce1).not.toBe(keyWithNonce2);
  });

  it("registers and tracks known keys correctly", () => {
    const key = generateIdempotencyKey({
      invoiceId: "inv_register",
      payer: "GBRPYHIL2CI3FNQ4BXLFMNDLFJUNPU2HY3ZMFTGOBJZ5GYWMSZ6TRECE",
      amount: 10000n,
    });

    expect(isKnownKey(key)).toBe(false);
    registerKey(key);
    expect(isKnownKey(key)).toBe(true);
  });

  it("clears registered keys on clearKeys()", () => {
    const key1 = "test_key_1";
    const key2 = "test_key_2";

    registerKey(key1);
    registerKey(key2);
    expect(isKnownKey(key1)).toBe(true);
    expect(isKnownKey(key2)).toBe(true);

    clearKeys();
    expect(isKnownKey(key1)).toBe(false);
    expect(isKnownKey(key2)).toBe(false);
  });

  it("retains existing Deduplicator inflight deduplication functionality", async () => {
    const deduplicator = new Deduplicator<string>();
    let executionCount = 0;

    const mockFetch = async () => {
      executionCount++;
      return "result_data";
    };

    const [res1, res2] = await Promise.all([
      deduplicator.dedupe("req_key", mockFetch),
      deduplicator.dedupe("req_key", mockFetch),
    ]);

    expect(res1).toBe("result_data");
    expect(res2).toBe("result_data");
    expect(executionCount).toBe(1);
    expect(deduplicator.cacheHitRate).toBe(0.5);
    expect(deduplicator.getDedupStats()).toEqual({ deduped: 1, total: 2 });
  });
});
