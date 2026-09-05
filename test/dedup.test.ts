import {
  generateIdempotencyKey,
  isKnownKey,
  registerKey,
  clearKeys,
} from "../src/dedup.js";

describe("generateIdempotencyKey", () => {
  afterEach(() => {
    clearKeys();
  });

  it("produces the same key for identical inputs", () => {
    const params = {
      invoiceId: "inv-123",
      payer: "GABC123",
      amount: 1000n,
    };
    const key1 = generateIdempotencyKey(params);
    const key2 = generateIdempotencyKey(params);
    expect(key1).toBe(key2);
    expect(key1).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces different keys for different amounts", () => {
    const key1 = generateIdempotencyKey({
      invoiceId: "inv-123",
      payer: "GABC123",
      amount: 1000n,
    });
    const key2 = generateIdempotencyKey({
      invoiceId: "inv-123",
      payer: "GABC123",
      amount: 2000n,
    });
    expect(key1).not.toBe(key2);
  });

  it("produces different keys for different payers", () => {
    const key1 = generateIdempotencyKey({
      invoiceId: "inv-123",
      payer: "GABC123",
      amount: 1000n,
    });
    const key2 = generateIdempotencyKey({
      invoiceId: "inv-123",
      payer: "GDEF456",
      amount: 1000n,
    });
    expect(key1).not.toBe(key2);
  });

  it("produces different keys for different invoiceIds", () => {
    const key1 = generateIdempotencyKey({
      invoiceId: "inv-123",
      payer: "GABC123",
      amount: 1000n,
    });
    const key2 = generateIdempotencyKey({
      invoiceId: "inv-456",
      payer: "GABC123",
      amount: 1000n,
    });
    expect(key1).not.toBe(key2);
  });

  it("changes the key when a nonce is provided", () => {
    const base = generateIdempotencyKey({
      invoiceId: "inv-123",
      payer: "GABC123",
      amount: 1000n,
    });
    const withNonce = generateIdempotencyKey({
      invoiceId: "inv-123",
      payer: "GABC123",
      amount: 1000n,
      nonce: "abc",
    });
    expect(withNonce).not.toBe(base);
    expect(withNonce).toMatch(/^[a-f0-9]{64}$/);
  });

  it("produces the same key for the same nonce", () => {
    const params = {
      invoiceId: "inv-123",
      payer: "GABC123",
      amount: 1000n,
      nonce: "xyz",
    };
    expect(generateIdempotencyKey(params)).toBe(generateIdempotencyKey(params));
  });
});

describe("key registry", () => {
  afterEach(() => {
    clearKeys();
  });

  it("returns false for unknown keys", () => {
    expect(isKnownKey("unknown")).toBe(false);
  });

  it("returns true after registering a key", () => {
    registerKey("my-key");
    expect(isKnownKey("my-key")).toBe(true);
  });

  it("clears all keys", () => {
    registerKey("a");
    registerKey("b");
    clearKeys();
    expect(isKnownKey("a")).toBe(false);
    expect(isKnownKey("b")).toBe(false);
  });
});
