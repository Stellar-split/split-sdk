import { describe, it, expect } from "vitest";
import { decode, decodeInt128 } from "../src/xdrDecoder.js";

/** Build a 16-byte big-endian INT128 buffer from a signed BigInt. */
function encodeInt128(value: bigint): Buffer {
  const buf = Buffer.alloc(16);
  const mask = (1n << 64n) - 1n;
  const hi = value >> 64n;
  const lo = value & mask;
  buf.writeBigInt64BE(BigInt.asIntN(64, hi), 0);
  buf.writeBigUInt64BE(lo, 8);
  return buf;
}

describe("decodeInt128", () => {
  it("decodes -1 correctly as a negative BigInt", () => {
    const buffer = encodeInt128(-1n);
    expect(decodeInt128(buffer)).toBe(-1n);
  });

  it("decodes a large negative value correctly", () => {
    const value = -170141183460469231731687303715884105728n; // INT128_MIN
    const buffer = encodeInt128(value);
    expect(decodeInt128(buffer)).toBe(value);
  });

  it("decodes a positive value correctly", () => {
    const value = 123456789012345678901234567890n;
    const buffer = encodeInt128(value);
    expect(decodeInt128(buffer)).toBe(value);
  });

  it("decodes zero correctly", () => {
    expect(decodeInt128(encodeInt128(0n))).toBe(0n);
  });

  it("throws on a buffer of the wrong length", () => {
    expect(() => decodeInt128(Buffer.alloc(8))).toThrow();
  });

  it("decode('INT128', buffer) matches decodeInt128", () => {
    const buffer = encodeInt128(-42n);
    expect(decode("INT128", buffer)).toBe(-42n);
    expect(decode("INT128", buffer)).toBe(decodeInt128(buffer));
  });
});
