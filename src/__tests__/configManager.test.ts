import { describe, it, expect } from "vitest";
import { ConfigManager, deepMerge } from "../configManager.js";
import { CsrfProtection } from "../csrf.js";

describe("ConfigManager", () => {
  it("deep merges", () => {
    expect(deepMerge({ a: { b: 1, c: 2 } }, { a: { b: 3 } })).toEqual({ a: { b: 3, c: 2 } });
  });

  it("loads, applies environments and tracks history", async () => {
    const m = new ConfigManager("prod");
    await m.load({ rpc: { url: "a", timeout: 1 } }, "base");
    await m.load(async () => ({ rpc: { timeout: 5 } }), "async");
    m.defineEnvironment("prod", { rpc: { url: "prod" } });
    expect(m.get()).toEqual({ rpc: { url: "prod", timeout: 5 } });
    m.setEnvironment("dev");
    expect(m.get()).toEqual({ rpc: { url: "a", timeout: 5 } });
    expect(m.getHistory().map((h) => h.source)).toEqual(["base", "async"]);
  });

  it("loads env vars", () => {
    const m = new ConfigManager();
    m.loadEnvVars("SPLIT_", { SPLIT_RPC_URL: "x", OTHER: "y" });
    expect(m.get()).toEqual({ rpcUrl: "x" });
  });
});

describe("CsrfProtection", () => {
  it("issues secure tokens and validates them strictly", () => {
    const csrf = new CsrfProtection();
    const token = csrf.issueToken();
    expect(token.length).toBeGreaterThanOrEqual(32);
    expect(csrf.validateToken(token)).toBe(true);
    expect(csrf.validateToken("bogus")).toBe(false);
    expect(csrf.validateToken(undefined)).toBe(false);
  });

  it("rejects reused tokens after consumption", () => {
    const csrf = new CsrfProtection();
    const token = csrf.issueToken();
    expect(csrf.validateToken(token, { consume: true })).toBe(true);
    expect(csrf.validateToken(token)).toBe(false);
  });

  it("refreshes tokens and tracks state", () => {
    const csrf = new CsrfProtection();
    const first = csrf.issueToken();
    const refreshed = csrf.refreshToken(first);
    expect(refreshed).not.toBe(first);
    expect(csrf.validateToken(refreshed)).toBe(true);
    expect(csrf.validateToken(first)).toBe(false);
    expect(csrf.getStats().issued).toBe(2);
  });

  it("protects state-changing requests only", () => {
    const csrf = new CsrfProtection();
    const token = csrf.issueToken();
    expect(csrf.protectRequest("GET", {})).toBe(true);
    expect(csrf.protectRequest("POST", {})).toBe(false);
    expect(csrf.protectRequest("POST", { "x-csrf-token": token })).toBe(true);
  });
});
