import { describe, it, expect, vi } from "vitest";
import { checkPayerReadiness } from "../src/preflightChecker.js";

function makeServer(balances: object[] | null) {
  return {
    getAccount: vi.fn(async () => {
      if (balances === null) throw new Error("Not Found");
      return { balances };
    }),
  };
}

const TOKEN = "GTOKEN_ISSUER_ADDRESS";
const REQUIRED = 1_000_000_0n; // 1 unit in stroops (7 decimals)

describe("checkPayerReadiness", () => {
  it("returns ready: false, reason: account_not_found when account does not exist", async () => {
    const server = makeServer(null);
    const result = await checkPayerReadiness(server as never, "GPAYER", REQUIRED, TOKEN);
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("account_not_found");
  });

  it("returns ready: false, reason: no_trustline when token trustline is absent", async () => {
    const server = makeServer([
      { balance: "100.0000000", asset_type: "native" },
    ]);
    const result = await checkPayerReadiness(server as never, "GPAYER", REQUIRED, TOKEN);
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("no_trustline");
  });

  it("returns ready: false, reason: insufficient_balance when balance is below required", async () => {
    const server = makeServer([
      { balance: "0.5000000", asset_type: "credit_alphanum12", asset_code: "USDC", asset_issuer: TOKEN },
    ]);
    const result = await checkPayerReadiness(server as never, "GPAYER", REQUIRED, TOKEN);
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("insufficient_balance");
  });

  it("returns ready: true when account has sufficient balance and trustline", async () => {
    const server = makeServer([
      { balance: "10.0000000", asset_type: "credit_alphanum12", asset_code: "USDC", asset_issuer: TOKEN },
    ]);
    const result = await checkPayerReadiness(server as never, "GPAYER", REQUIRED, TOKEN);
    expect(result.ready).toBe(true);
    expect(result.reason).toBeUndefined();
  });

  it("handles native token: no_trustline when no native balance entry", async () => {
    const server = makeServer([
      { balance: "5.0000000", asset_type: "credit_alphanum4", asset_code: "USDC", asset_issuer: TOKEN },
    ]);
    const result = await checkPayerReadiness(server as never, "GPAYER", REQUIRED, "native");
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("no_trustline");
  });

  it("handles native token: insufficient_balance", async () => {
    const server = makeServer([
      { balance: "0.5000000", asset_type: "native" },
    ]);
    const result = await checkPayerReadiness(server as never, "GPAYER", REQUIRED, "native");
    expect(result.ready).toBe(false);
    expect(result.reason).toBe("insufficient_balance");
  });

  it("handles native token: ready when sufficient native balance", async () => {
    const server = makeServer([
      { balance: "100.0000000", asset_type: "native" },
    ]);
    const result = await checkPayerReadiness(server as never, "GPAYER", REQUIRED, "native");
    expect(result.ready).toBe(true);
    expect(result.reason).toBeUndefined();
  });
});
