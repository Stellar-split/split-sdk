import { describe, it, expect, vi } from "vitest";
import { LedgerAdapter, MIN_LEDGER_FIRMWARE } from "../src/adapters/ledger.js";
import { LedgerFirmwareTooOldError } from "../src/errors.js";

const mockTransport = {
  close: vi.fn().mockResolvedValue(undefined),
};

const mockStr = {
  getAppConfiguration: vi.fn(),
  getPublicKey: vi.fn(),
  signTransaction: vi.fn(),
};

vi.mock("@ledgerhq/hw-transport-webhid", () => ({
  default: {
    create: vi.fn().mockResolvedValue(mockTransport),
  },
}));

vi.mock("@ledgerhq/hw-app-str", () => ({
  default: vi.fn().mockImplementation(() => mockStr),
}));

describe("LedgerAdapter firmware version check", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("throws LedgerFirmwareTooOldError when app version is below minimum", async () => {
    mockStr.getAppConfiguration.mockResolvedValue({ version: "1.0.0" });

    const adapter = new LedgerAdapter();
    await expect(adapter.getAddress()).rejects.toThrow(LedgerFirmwareTooOldError);
    await expect(adapter.getAddress()).rejects.toThrow(
      /Ledger firmware\/app version 1\.0\.0 is too old/
    );
  });

  it("includes the required version in the error message", async () => {
    mockStr.getAppConfiguration.mockResolvedValue({ version: "1.5.0" });

    const adapter = new LedgerAdapter();
    try {
      await adapter.getAddress();
      expect.fail("Should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(LedgerFirmwareTooOldError);
      expect((err as LedgerFirmwareTooOldError).requiredVersion).toBe(
        MIN_LEDGER_FIRMWARE
      );
      expect((err as LedgerFirmwareTooOldError).actualVersion).toBe("1.5.0");
    }
  });

  it("proceeds normally when app version meets the minimum", async () => {
    mockStr.getAppConfiguration.mockResolvedValue({ version: "2.0.0" });
    mockStr.getPublicKey.mockResolvedValue({ publicKey: "GABC..." });

    const adapter = new LedgerAdapter();
    const address = await adapter.getAddress();
    expect(address).toBe("GABC...");
    expect(mockStr.getAppConfiguration).toHaveBeenCalled();
  });

  it("proceeds normally when app version exceeds the minimum", async () => {
    mockStr.getAppConfiguration.mockResolvedValue({ version: "3.1.0" });
    mockStr.getPublicKey.mockResolvedValue({ publicKey: "GDEF..." });

    const adapter = new LedgerAdapter();
    const address = await adapter.getAddress();
    expect(address).toBe("GDEF...");
  });

  it("skips firmware check when skipFirmwareCheck is true", async () => {
    mockStr.getPublicKey.mockResolvedValue({ publicKey: "GHIJ..." });

    const adapter = new LedgerAdapter({ skipFirmwareCheck: true });
    const address = await adapter.getAddress();
    expect(address).toBe("GHIJ...");
    expect(mockStr.getAppConfiguration).not.toHaveBeenCalled();
  });

  it("checks firmware before signing transactions", async () => {
    mockStr.getAppConfiguration.mockResolvedValue({ version: "2.1.0" });
    mockStr.signTransaction.mockResolvedValue({
      signature: Buffer.from("sig"),
    });

    const adapter = new LedgerAdapter();
    const signed = await adapter.signTransaction("mock-xdr", "testnet");
    expect(signed).toBe("c2ln"); // base64 of "sig"
    expect(mockStr.getAppConfiguration).toHaveBeenCalled();
  });
});
