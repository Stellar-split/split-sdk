import { describe, it, expect, vi } from "vitest";
import { FreighterAdapter } from "../src/wallets/adapters/FreighterAdapter.js";
import { FreighterNotInstalledError } from "../src/errors.js";

describe("FreighterAdapter not-installed handling", () => {
  it("throws FreighterNotInstalledError on connect when window.freighter is absent", async () => {
    const adapter = new FreighterAdapter();
    // Ensure window.freighter is undefined
    (globalThis as any).window = { freighter: undefined };
    await expect(adapter.connect()).rejects.toThrow(FreighterNotInstalledError);
  });

  it("throws FreighterNotInstalledError on sign when window.freighter is absent", async () => {
    const adapter = new FreighterAdapter();
    (globalThis as any).window = { freighter: undefined };
    await expect(adapter.sign("xdr", "testnet")).rejects.toThrow(FreighterNotInstalledError);
  });

  it("throws FreighterNotInstalledError on getAddress when window.freighter is absent", async () => {
    const adapter = new FreighterAdapter();
    (globalThis as any).window = { freighter: undefined };
    await expect(adapter.getAddress()).rejects.toThrow(FreighterNotInstalledError);
  });

  it("error message includes the Freighter install URL", async () => {
    const adapter = new FreighterAdapter();
    (globalThis as any).window = { freighter: undefined };
    try {
      await adapter.connect();
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(FreighterNotInstalledError);
      expect((err as Error).message).toContain("https://www.freighter.app");
    }
  });

  it("connects normally when window.freighter is present", async () => {
    const adapter = new FreighterAdapter();
    (globalThis as any).window = {
      freighter: {
        isConnected: vi.fn().mockResolvedValue(true),
        getPublicKey: vi.fn().mockResolvedValue("GABC..."),
        signTransaction: vi.fn().mockResolvedValue("signed-xdr"),
      },
    };

    const address = await adapter.connect();
    expect(address).toBe("GABC...");
    adapter.disconnect();
  });
});
