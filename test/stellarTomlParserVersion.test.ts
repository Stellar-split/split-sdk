import { describe, it, expect } from "vitest";
import {
  StellarTomlParser,
  SUPPORTED_TOML_VERSIONS,
} from "../src/anchors/StellarTomlParser.js";
import { UnsupportedTomlVersionError } from "../src/errors.js";

describe("StellarTomlParser VERSION validation", () => {
  it("accepts TOML with supported version 2.0", async () => {
    const parser = new StellarTomlParser();
    // Mock the fetch by overriding _fetchRaw
    (parser as any)._fetchRaw = async () => 'VERSION = "2.0"\n';
    const meta = await parser.fetch("example.com");
    expect(meta.VERSION).toBe("2.0");
  });

  it("accepts TOML with supported version 2.1", async () => {
    const parser = new StellarTomlParser();
    (parser as any)._fetchRaw = async () => 'VERSION = "2.1"\n';
    const meta = await parser.fetch("example.com");
    expect(meta.VERSION).toBe("2.1");
  });

  it("throws UnsupportedTomlVersionError for unsupported version", async () => {
    const parser = new StellarTomlParser();
    (parser as any)._fetchRaw = async () => 'VERSION = "3.0"\n';
    await expect(parser.fetch("example.com")).rejects.toThrow(
      UnsupportedTomlVersionError,
    );
  });

  it("UnsupportedTomlVersionError names the encountered version", async () => {
    const parser = new StellarTomlParser();
    (parser as any)._fetchRaw = async () => 'VERSION = "99.0"\n';
    try {
      await parser.fetch("example.com");
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(UnsupportedTomlVersionError);
      expect((err as UnsupportedTomlVersionError).version).toBe("99.0");
    }
  });

  it("accepts TOML with no VERSION field", async () => {
    const parser = new StellarTomlParser();
    (parser as any)._fetchRaw = async () => 'ACCOUNTS = ["GA..."]\n';
    const meta = await parser.fetch("example.com");
    expect(meta.ACCOUNTS).toEqual(["GA..."]);
  });

  it("exports SUPPORTED_TOML_VERSIONS as [2.0, 2.1]", () => {
    expect(SUPPORTED_TOML_VERSIONS).toEqual(["2.0", "2.1"]);
  });
});
