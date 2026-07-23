import { describe, it, expect } from "vitest";
import {
  isValidStellarAddress,
  truncateAddress,
  addressesEqual,
  toMuxedAddress,
  fromMuxedAddress,
} from "../src/utils.js";
import { Keypair } from "@stellar/stellar-sdk";

describe("utils", () => {
  const validGAddress1 = Keypair.random().publicKey();
  const validGAddress2 = Keypair.random().publicKey();

  describe("isValidStellarAddress", () => {
    it("returns true for valid G addresses", () => {
      expect(isValidStellarAddress(validGAddress1)).toBe(true);
      expect(isValidStellarAddress(validGAddress2)).toBe(true);
    });

    it("returns false for invalid addresses", () => {
      expect(isValidStellarAddress("")).toBe(false);
      expect(isValidStellarAddress("MABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABC")).toBe(false);
      expect(isValidStellarAddress("GABC")).toBe(false);
      expect(isValidStellarAddress("GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABCD")).toBe(false); // too long
    });
  });

  describe("truncateAddress", () => {
    it("truncates with default chars", () => {
      expect(truncateAddress("GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABC")).toBe("GABC...ZABC");
    });

    it("truncates with custom chars", () => {
      expect(truncateAddress("GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABC", 2)).toBe("GA...BC");
    });

    it("does not truncate if too short", () => {
      expect(truncateAddress("GABCDEF", 4)).toBe("GABCDEF");
    });
  });

  describe("addressesEqual", () => {
    it("returns true for identical addresses", () => {
      expect(addressesEqual("GABC", "GABC")).toBe(true);
    });

    it("returns true for case-insensitive identical addresses", () => {
      expect(addressesEqual("Gabc", "GABC")).toBe(true);
    });

    it("returns false for different addresses", () => {
      expect(addressesEqual("GABC", "GXYZ")).toBe(false);
    });
  });

  describe("toMuxedAddress", () => {
    it("creates a muxed address", () => {
      const address = validGAddress1;
      const id = 1234n;
      const muxed = toMuxedAddress(address, id);
      expect(muxed.startsWith("M")).toBe(true);
    });
  });

  describe("fromMuxedAddress", () => {
    it("parses a muxed address back to base address and id", () => {
      const address = validGAddress1;
      const id = 1234n;
      const muxed = toMuxedAddress(address, id);
      
      const parsed = fromMuxedAddress(muxed);
      expect(parsed.address).toBe(address);
      expect(parsed.id).toBe(id);
    });
  });
});
