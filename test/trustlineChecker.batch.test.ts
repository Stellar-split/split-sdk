import { describe, it, expect, vi } from "vitest";
import { Asset, Horizon } from "@stellar/stellar-sdk";
import { checkTrustlinesBatch } from "../src/trustlineChecker.js";

const USDC_ISSUER = "GBBD47IF6LWK7P7MDEVSCWR7DPUWV3NY3DTQEVFL4NAT4AQH3ZLLFLA5";
const EURT_ISSUER = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";
const HOLDER = "GBVMS4VIB7ETO3X6SVVBGCPUJJG6VRM37KYWWFYP52BCX7NREZ72XCIL";
const MISSING = "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN";

function mockServer(balances: unknown[]): Horizon.Server {
  return {
    loadAccount: vi.fn().mockResolvedValue({ balances }),
  } as unknown as Horizon.Server;
}

describe("checkTrustlinesBatch", () => {
  it("makes a single Horizon account fetch regardless of asset count", async () => {
    const server = mockServer([]);
    const assets = [
      new Asset("USDC", USDC_ISSUER),
      new Asset("EURT", EURT_ISSUER),
      Asset.native(),
    ];

    await checkTrustlinesBatch(server, HOLDER, assets);

    expect(server.loadAccount).toHaveBeenCalledTimes(1);
  });

  it("correctly identifies which assets have a trustline", async () => {
    const usdc = new Asset("USDC", USDC_ISSUER);
    const eurt = new Asset("EURT", EURT_ISSUER);
    const native = Asset.native();

    const server = mockServer([
      {
        asset_type: "credit_alphanum4",
        asset_code: "USDC",
        asset_issuer: USDC_ISSUER,
      },
    ]);

    const result = await checkTrustlinesBatch(server, HOLDER, [usdc, eurt, native]);

    expect(result.get(usdc)).toBe(true);
    expect(result.get(eurt)).toBe(false);
    expect(result.get(native)).toBe(true);
  });

  it("treats every non-native asset as untrusted when the account fetch fails", async () => {
    const server = {
      loadAccount: vi.fn().mockRejectedValue(new Error("not found")),
    } as unknown as Horizon.Server;
    const usdc = new Asset("USDC", USDC_ISSUER);
    const native = Asset.native();

    const result = await checkTrustlinesBatch(server, MISSING, [usdc, native]);

    expect(result.get(usdc)).toBe(false);
    expect(result.get(native)).toBe(true);
  });
});
