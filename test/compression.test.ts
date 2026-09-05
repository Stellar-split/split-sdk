import { describe, it, expect } from "vitest";
import {
  compressMetadata,
  decompressMetadata,
} from "../src/compression.js";
import { SdkError, SdkErrorCode } from "../src/errors.js";

describe("compressMetadata / decompressMetadata", () => {
  it("round-trips a simple object", () => {
    const obj = { name: "Invoice #1", amount: 1000, tags: ["urgent"] };
    const encoded = compressMetadata(obj);
    expect(typeof encoded).toBe("string");
    expect(encoded).not.toContain("=");
    expect(decompressMetadata(encoded)).toEqual(obj);
  });

  it("round-trips nested objects", () => {
    const obj = { a: { b: { c: 1 } }, list: [1, 2, 3] };
    expect(decompressMetadata(compressMetadata(obj))).toEqual(obj);
  });

  it("produces base64url output (no padding)", () => {
    const encoded = compressMetadata({ test: true });
    expect(encoded).not.toContain("=");
    expect(encoded).not.toContain("+");
    expect(encoded).not.toContain("/");
  });

  it("throws SdkError when exceeding maxBytes", () => {
    const big = { data: "x".repeat(1000) };
    expect(() => compressMetadata(big, 10)).toThrow(SdkError);
    try {
      compressMetadata(big, 10);
    } catch (err) {
      expect((err as SdkError).code).toBe(SdkErrorCode.CONTRACT_REJECTED);
    }
  });

  it("allows custom maxBytes when within limit", () => {
    const obj = { a: 1 };
    expect(() => compressMetadata(obj, 5)).toThrow(SdkError);
    expect(() => compressMetadata(obj, 100)).not.toThrow();
  });

  it("throws SdkError on invalid base64url input", () => {
    expect(() => decompressMetadata("!!!")).toThrow(SdkError);
    try {
      decompressMetadata("!!!");
    } catch (err) {
      expect((err as SdkError).code).toBe(SdkErrorCode.CONTRACT_REJECTED);
    }
  });

  it("throws SdkError on valid base64url but invalid JSON", () => {
    const encoded = Buffer.from("not-json").toString("base64url");
    expect(() => decompressMetadata(encoded)).toThrow(SdkError);
  });
});
