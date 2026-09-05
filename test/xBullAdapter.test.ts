import { describe, it, expect, vi } from "vitest";
import { XBullAdapter, MIN_XBULL_VERSION } from "../src/wallets/adapters/XBullAdapter.js";
import { ExtensionVersionTooOldError } from "../src/errors.js";

describe("XBullAdapter version check", () => {
  beforeEach(() => {
    (globalThis as any).window = { xbull: undefined };
  });

  it("throws ExtensionVersionTooOldError when version is missing", async () => {
    (globalThis as any).window = {
      xbull: {
        connect: vi.fn().mockResolvedValue({ public_key: "GABC..." }),
      },
    };

    const adapter = new XBullAdapter();
    await expect(adapter.connect()).rejects.toThrow(ExtensionVersionTooOldError);
    await expect(adapter.connect()).rejects.toThrow(/unknown is too old/);
  });

  it("throws ExtensionVersionTooOldError when version is below minimum", async () => {
    (globalThis as any).window = {
      xbull: {
        version: "2.0.0",
        connect: vi.fn().mockResolvedValue({ public_key: "GABC..." }),
      },
    };

    const adapter = new XBullAdapter();
    await expect(adapter.connect()).rejects.toThrow(ExtensionVersionTooOldError);
    try {
      await adapter.connect();
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(ExtensionVersionTooOldError);
      expect((err as ExtensionVersionTooOldError).requiredVersion).toBe(
        MIN_XBULL_VERSION
      );
      expect((err as ExtensionVersionTooOldError).actualVersion).toBe("2.0.0");
    }
  });

  it("connects normally when version meets the minimum", async () => {
    (globalThis as any).window = {
      xbull: {
        version: "3.0.0",
        connect: vi.fn().mockResolvedValue({ public_key: "GABC..." }),
        onAccountChange: vi.fn().mockReturnValue(() => {}),
      },
    };

    const adapter = new XBullAdapter();
    const address = await adapter.connect();
    expect(address).toBe("GABC...");
  });

  it("connects normally when version exceeds the minimum", async () => {
    (globalThis as any).window = {
      xbull: {
        version: "4.1.0",
        connect: vi.fn().mockResolvedValue({ public_key: "GDEF..." }),
        onAccountChange: vi.fn().mockReturnValue(() => {}),
      },
    };

    const adapter = new XBullAdapter();
    const address = await adapter.connect();
    expect(address).toBe("GDEF...");
  });

  it("checks version in getAddress too", async () => {
    (globalThis as any).window = {
      xbull: {
        version: "2.5.0",
        connect: vi.fn().mockResolvedValue({ public_key: "GHIJ..." }),
      },
    };

    const adapter = new XBullAdapter();
    await expect(adapter.getAddress()).rejects.toThrow(
      ExtensionVersionTooOldError
    );
  });
});
