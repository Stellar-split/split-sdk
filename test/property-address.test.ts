import { describe, it, expect } from "vitest";
import * as fc from "fast-check";
import { Keypair, StrKey } from "@stellar/stellar-sdk";
import { isValidStellarAddress } from "../src/utils.js";

const VALID_ADDRESSES = Array.from({ length: 50 }, () => Keypair.random().publicKey());

describe("isValidStellarAddress (property-based)", () => {
  it("returns true for all randomly generated Stellar keypairs", () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_ADDRESSES), (address) => {
        expect(isValidStellarAddress(address)).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("returns false for arbitrary non-G-prefixed strings", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 100 }),
        (s) => {
          fc.pre(!s.startsWith("G"));
          expect(isValidStellarAddress(s)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("returns false for strings too short to be valid", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 55 }),
        (s) => {
          fc.pre(s.length < 56);
          expect(isValidStellarAddress(s)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("returns false for G-prefixed strings with invalid base32 chars", () => {
    fc.assert(
      fc.property(
        fc.integer({ min: 56, max: 100 }),
        fc.constant("0123456789ABCDEFGHIJKLMNOPQRSTU.VWXYZ"),
        (len, alphabet) => {
          fc.pre(len > 1);
          const invalid =
            "G" +
            Array.from(
              { length: len - 1 },
              () => alphabet[Math.floor(Math.random() * alphabet.length)],
            ).join("");
          const result = isValidStellarAddress(invalid);
          expect(result).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("returns false for empty string", () => {
    expect(isValidStellarAddress("")).toBe(false);
  });

  it("returns false for 'null' and 'undefined' as strings", () => {
    expect(isValidStellarAddress("null")).toBe(false);
    expect(isValidStellarAddress("undefined")).toBe(false);
  });

  it("returns false for strings containing non-ASCII", () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 50 }),
        fc.integer({ min: 0x80, max: 0x10ffff }),
        (prefix, codePoint) => {
          const addr = prefix + String.fromCodePoint(codePoint);
          expect(isValidStellarAddress(addr)).toBe(false);
        },
      ),
      { numRuns: 500 },
    );
  });

  it("valid addresses always start with 'G'", () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_ADDRESSES), (address) => {
        expect(address.startsWith("G")).toBe(true);
      }),
      { numRuns: 500 },
    );
  });

  it("valid addresses are exactly 56 characters", () => {
    fc.assert(
      fc.property(fc.constantFrom(...VALID_ADDRESSES), (address) => {
        expect(address.length).toBe(56);
      }),
      { numRuns: 500 },
    );
  });
});
