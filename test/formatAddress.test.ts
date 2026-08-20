import { describe, it, expect } from "vitest";
import { formatAddress } from "../src/utils.js";
import { StellarSplitError } from "../src/errors.js";

const LONG_ADDRESS = "GABCDEFGHIJKLMNOPQRSTUVWXYZABCDEFGHIJKLMNOPQRSTUVWXYZABC";

describe("formatAddress", () => {
  it("formats with default leading 5 and trailing 4", () => {
    expect(formatAddress(LONG_ADDRESS)).toBe("GABCD...ZABC");
  });

  it("supports custom leading and trailing", () => {
    expect(formatAddress(LONG_ADDRESS, { leading: 3, trailing: 3 })).toBe("GAB...ABC");
  });

  it("throws StellarSplitError with INVALID_RECIPIENT code for addresses too short", () => {
    expect(() => formatAddress("GABCDEF")).toThrow(StellarSplitError);
    try {
      formatAddress("GABCDEF");
    } catch (err) {
      expect(err).toBeInstanceOf(StellarSplitError);
      expect((err as StellarSplitError).code).toBe("INVALID_RECIPIENT");
    }
  });

  it("keeps a full-length address format correct", () => {
    const result = formatAddress(LONG_ADDRESS);
    expect(result).toMatch(/^GABCD\.\.\./);
    expect(result).toMatch(/ZABC$/);
    expect(result.length).toBe(5 + 3 + 4);
  });
});