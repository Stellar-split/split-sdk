import { describe, it, expect } from "vitest";
import {
  compressMetadata,
  decompressMetadata,
} from "../src/compression.js";
import { SdkError, SdkErrorCode } from "../src/errors.js";

describe("compressMetadata", () => {
  it("serializes an object to base64url (no padding)", () => {
    const obj = { amount: "100", asset: "USDC" };
    const encoded = compressMetadata(obj);
    // base64url should never contain padding '='
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
  });

  it("round-trips a simple object", () => {
    const obj = { amount: "100", asset: "USDC", memo: "test payment" };
    const encoded = compressMetadata(obj);
    const decoded = decompressMetadata(encoded);
    expect(decoded).toEqual(obj);
  });

  it("round-trips an empty object", () => {
    const obj: Record<string, unknown> = {};
    const encoded = compressMetadata(obj);
    const decoded = decompressMetadata(encoded);
    expect(decoded).toEqual({});
  });

  it("round-trips nested objects and arrays", () => {
    const obj = {
      level1: { level2: { level3: "deep" } },
      items: [1, 2, 3],
      flag: true,
      nil: null,
    };
    const encoded = compressMetadata(obj);
    const decoded = decompressMetadata(encoded);
    expect(decoded).toEqual(obj);
  });

  it("throws SdkError CONTRACT_REJECTED when exceeding maxBytes", () => {
    const obj = { data: "x".repeat(1000) };
    expect(() => compressMetadata(obj, 100)).toThrow(SdkError);
    try {
      compressMetadata(obj, 100);
    } catch (e) {
      expect(e).toBeInstanceOf(SdkError);
      expect((e as SdkError).code).toBe(SdkErrorCode.CONTRACT_REJECTED);
    }
  });

  it("respects custom maxBytes argument", () => {
    const obj = { short: "ok" };
    // Should fit within a generous limit
    expect(() => compressMetadata(obj, 512)).not.toThrow();
    // Should fail with a tiny limit
    expect(() => compressMetadata(obj, 1)).toThrow(SdkError);
  });
});

describe("decompressMetadata", () => {
  it("throws SdkError CONTRACT_REJECTED on invalid base64 input", () => {
    // Not valid base64url — contains characters outside the alphabet
    expect(() => decompressMetadata("!!!notbase64!!!")).toThrow(SdkError);
    try {
      decompressMetadata("!!!notbase64!!!");
    } catch (e) {
      expect(e).toBeInstanceOf(SdkError);
      expect((e as SdkError).code).toBe(SdkErrorCode.CONTRACT_REJECTED);
    }
  });

  it("throws SdkError CONTRACT_REJECTED on valid base64 but invalid JSON", () => {
    // "not json" encoded as base64url
    const encoded = Buffer.from("not json").toString("base64url");
    expect(() => decompressMetadata(encoded)).toThrow(SdkError);
    try {
      decompressMetadata(encoded);
    } catch (e) {
      expect(e).toBeInstanceOf(SdkError);
      expect((e as SdkError).code).toBe(SdkErrorCode.CONTRACT_REJECTED);
    }
  });

  it("throws SdkError CONTRACT_REJECTED when decoded JSON is not an object", () => {
    // JSON array
    const encoded = Buffer.from("[1, 2, 3]").toString("base64url");
    expect(() => decompressMetadata(encoded)).toThrow(SdkError);
    // JSON string
    const strEncoded = Buffer.from('"hello"').toString("base64url");
    expect(() => decompressMetadata(strEncoded)).toThrow(SdkError);
    // JSON number
    const numEncoded = Buffer.from("42").toString("base64url");
    expect(() => decompressMetadata(numEncoded)).toThrow(SdkError);
  });

  it("decodes a previously compressed object correctly", () => {
    const original = { invoiceId: "inv_123", total: "500.00", currency: "USDC" };
    const encoded = compressMetadata(original);
    const decoded = decompressMetadata(encoded);
    expect(decoded).toEqual(original);
  });
});
