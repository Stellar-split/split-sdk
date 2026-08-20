import { describe, expect, it } from "vitest";
import { compressMetadata, decompressMetadata } from "../src/compression.js";
import { StellarSplitError } from "../src/errors.js";

function expectContractRejected(fn: () => unknown): void {
  try {
    fn();
    expect.unreachable("expected a throw");
  } catch (err) {
    expect(err).toBeInstanceOf(StellarSplitError);
    const stellarErr = err as StellarSplitError;
    expect(stellarErr.code).toBe("CONTRACT_REJECTED");
  }
}

describe("compressMetadata / decompressMetadata", () => {
  it("round-trips a simple object", () => {
    const obj = { invoiceId: "inv_123", amount: 1000, currency: "USDC" };
    const encoded = compressMetadata(obj);
    const decoded = decompressMetadata(encoded);
    expect(decoded).toEqual(obj);
  });

  it("round-trips an empty object", () => {
    const obj = {};
    const encoded = compressMetadata(obj);
    const decoded = decompressMetadata(encoded);
    expect(decoded).toEqual(obj);
  });

  it("produces base64url without padding", () => {
    const encoded = compressMetadata({ a: 1 });
    // base64url has no '=' padding
    expect(encoded).not.toContain("=");
  });

  it("throws CONTRACT_REJECTED on oversized payload", () => {
    const large = { data: "x".repeat(600) };
    expectContractRejected(() => compressMetadata(large, 10));
  });

  it("throws CONTRACT_REJECTED on invalid base64url input", () => {
    expectContractRejected(() => decompressMetadata("!!!invalid-base64!!!"));
  });

  it("throws CONTRACT_REJECTED on non-base64 input", () => {
    // Contains '$' which is not a valid base64url character
    expectContractRejected(() => decompressMetadata("not$base64$!"));
  });

  it("throws CONTRACT_REJECTED on invalid JSON (after valid base64)", () => {
    // Buffer.from("not-json").toString("base64url") -> valid base64, not JSON
    const encoded = Buffer.from("not-json").toString("base64url");
    expectContractRejected(() => decompressMetadata(encoded));
  });

  it("throws CONTRACT_REJECTED on JSON array (not a plain object)", () => {
    const encoded = Buffer.from(JSON.stringify([1, 2, 3])).toString("base64url");
    expectContractRejected(() => decompressMetadata(encoded));
  });

  it("throws CONTRACT_REJECTED on JSON null", () => {
    const encoded = Buffer.from("null").toString("base64url");
    expectContractRejected(() => decompressMetadata(encoded));
  });

  it("uses default maxBytes of 512", () => {
    const justUnder = { data: "x".repeat(300) };
    expect(() => compressMetadata(justUnder)).not.toThrow();
    // 512 bytes is the default; a very large object should throw
    const over = { data: "x".repeat(2000) };
    expectContractRejected(() => compressMetadata(over));
  });
});