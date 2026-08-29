import { describe, it, expect, vi } from "vitest";
import { Asset, Horizon } from "@stellar/stellar-sdk";
import { checkTrustlinesBatch } from "../src/trustlineChecker.js";

function mockServer(balances: unknown[]): Horizon.Server {
  return {
    loadAccount: vi.fn().mockResolvedValue({ balances }),
  } as unknown as Horizon.Server;
}

describe("checkTrustlinesBatch", () => {
  it("makes a single Horizon account fetch regardless of asset count", async () => {
    const server = mockServer([]);
    const assets = [
      new Asset("USDC", "GISSUERUSDC000000000000000000000000000000000000000"),
      new Asset("EURT", "GISSUEREURT000000000000000000000000000000000000000"),
      Asset.native(),
    ];

    await checkTrustlinesBatch(server, "GACCOUNT", assets);

    expect(server.loadAccount).toHaveBeenCalledTimes(1);
  });

  it("correctly identifies which assets have a trustline", async () => {
    const usdc = new Asset("USDC", "GISSUERUSDC000000000000000000000000000000000000000");
    const eurt = new Asset("EURT", "GISSUEREURT000000000000000000000000000000000000000");
    const native = Asset.native();

    const server = mockServer([
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: "GISSUERUSDC000000000000000000000000000000000000000",
      },
    ]);

    const result = await checkTrustlinesBatch(server, "GACCOUNT", [usdc, eurt, native]);

    expect(result.get(usdc)).toBe(true);
    expect(result.get(eurt)).toBe(false);
    expect(result.get(native)).toBe(true);
  });

  it("treats every non-native asset as untrusted when the account fetch fails", async () => {
    const server = {
      loadAccount: vi.fn().mockRejectedValue(new Error("not found")),
    } as unknown as Horizon.Server;
    const usdc = new Asset("USDC", "GISSUERUSDC000000000000000000000000000000000000000");
    const native = Asset.native();

    const result = await checkTrustlinesBatch(server, "GMISSING", [usdc, native]);

    expect(result.get(usdc)).toBe(false);
    expect(result.get(native)).toBe(true);
  });
});
