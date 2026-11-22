import { describe, it, expect } from "vitest";
import { ConfigManager, deepMerge } from "../configManager.js";

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
