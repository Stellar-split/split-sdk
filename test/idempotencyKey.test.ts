// @vitest-environment node
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  generateIdempotencyKey,
  isKnownKey,
  registerKey,
  clearKeys,
} from "../src/dedup.js";

describe("generateIdempotencyKey", () => {
  const params = {
    invoiceId: "inv-001",
    payer: "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2",
    amount: 10000000n,
  };

  it("produces a deterministic hex string for the same inputs", () => {
    const key1 = generateIdempotencyKey(params);
    const key2 = generateIdempotencyKey(params);
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[0-9a-f]{64}$/);
  });

  it("produces different keys for different amounts", () => {
    const key1 = generateIdempotencyKey({ ...params, amount: 10000000n });
    const key2 = generateIdempotencyKey({ ...params, amount: 20000000n });
    expect(key1).not.toBe(key2);
  });

  it("produces different keys for different payers", () => {
    const key1 = generateIdempotencyKey(params);
    const key2 = generateIdempotencyKey({
      ...params,
      payer: "GBRPYHIL2CI3WHSCULNJJMA3CJBYWR5LK662LFXISKW3P7UKDXTX",
    });
    expect(key1).not.toBe(key2);
  });

  it("includes nonce when provided", () => {
    const key1 = generateIdempotencyKey({ ...params, nonce: "abc" });
    const key2 = generateIdempotencyKey({ ...params, nonce: "def" });
    expect(key1).not.toBe(key2);
  });

  it("same params with nonce but different nonce produces different keys", () => {
    const key1 = generateIdempotencyKey(params);
    const key2 = generateIdempotencyKey({ ...params, nonce: "retry-1" });
    expect(key1).not.toBe(key2);
  });
});

describe("isKnownKey / registerKey / clearKeys", () => {
  beforeEach(() => {
    clearKeys();
  });

  afterEach(() => {
    clearKeys();
  });

  it("isKnownKey returns false for unregistered keys", () => {
    expect(isKnownKey("unknown-key")).toBe(false);
  });

  it("isKnownKey returns true after registerKey", () => {
    const key = generateIdempotencyKey({
      invoiceId: "inv-002",
      payer: "GCZST3XVCDTUJ76ZAV2HA72KYTZ4KXX52HRXVWWRWXH2NBDXZWQS2FB2",
      amount: 5000000n,
    });
    expect(isKnownKey(key)).toBe(false);
    registerKey(key);
    expect(isKnownKey(key)).toBe(true);
  });

  it("clearKeys resets the known-key set", () => {
    const key = "some-test-key";
    registerKey(key);
    expect(isKnownKey(key)).toBe(true);
    clearKeys();
    expect(isKnownKey(key)).toBe(false);
  });

  it("multiple keys can be registered and checked independently", () => {
    const key1 = "key-a";
    const key2 = "key-b";
    registerKey(key1);
    expect(isKnownKey(key1)).toBe(true);
    expect(isKnownKey(key2)).toBe(false);
    registerKey(key2);
    expect(isKnownKey(key2)).toBe(true);
  });
});