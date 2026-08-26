import { describe, it, expect, beforeEach } from "vitest";
import {
  generateIdempotencyKey,
  isKnownKey,
  registerKey,
  clearKeys,
} from "../src/dedup.js";

describe("generateIdempotencyKey", () => {
  beforeEach(() => {
    clearKeys();
  });

  it("generates the same key for the same params", () => {
    const key1 = generateIdempotencyKey({
      invoiceId: "inv-1",
      payer: "GABC",
      amount: 1000n,
    });
    const key2 = generateIdempotencyKey({
      invoiceId: "inv-1",
      payer: "GABC",
      amount: 1000n,
    });
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("generates different keys for different amounts", () => {
    const key1 = generateIdempotencyKey({
      invoiceId: "inv-1",
      payer: "GABC",
      amount: 1000n,
    });
    const key2 = generateIdempotencyKey({
      invoiceId: "inv-1",
      payer: "GABC",
      amount: 2000n,
    });
    expect(key1).not.toBe(key2);
  });

  it("nonce changes the key", () => {
    const key1 = generateIdempotencyKey({
      invoiceId: "inv-1",
      payer: "GABC",
      amount: 1000n,
      nonce: "abc",
    });
    const key2 = generateIdempotencyKey({
      invoiceId: "inv-1",
      payer: "GABC",
      amount: 1000n,
      nonce: "def",
    });
    expect(key1).not.toBe(key2);
  });

  it("omitting nonce produces a different key than providing one", () => {
    const key1 = generateIdempotencyKey({
      invoiceId: "inv-1",
      payer: "GABC",
      amount: 1000n,
    });
    const key2 = generateIdempotencyKey({
      invoiceId: "inv-1",
      payer: "GABC",
      amount: 1000n,
      nonce: "",
    });
    expect(key1).not.toBe(key2);
  });
});

describe("isKnownKey / registerKey / clearKeys", () => {
  beforeEach(() => {
    clearKeys();
  });

  it("isKnownKey returns false before registering", () => {
    expect(isKnownKey("abc")).toBe(false);
  });

  it("isKnownKey returns true after registerKey", () => {
    registerKey("abc");
    expect(isKnownKey("abc")).toBe(true);
  });

  it("clearKeys resets state", () => {
    registerKey("abc");
    clearKeys();
    expect(isKnownKey("abc")).toBe(false);
  });
});
