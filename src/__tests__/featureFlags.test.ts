import { describe, it, expect } from "vitest";
import { FeatureFlagManager } from "../featureFlags.js";

describe("FeatureFlagManager", () => {
  const m = new FeatureFlagManager([
    { key: "on", enabled: true },
    { key: "off", enabled: false },
    { key: "cond", enabled: true, conditions: [{ attribute: "env", operator: "in", value: ["test", "dev"] }] },
  ]);

  it("evaluates basic flags", () => {
    expect(m.isEnabled("on")).toBe(true);
    expect(m.evaluate("off").reason).toBe("disabled");
    expect(m.evaluate("nope").reason).toBe("unknown");
  });

  it("respects conditions", () => {
    expect(m.isEnabled("cond", { env: "dev" })).toBe(true);
    expect(m.evaluate("cond", { env: "prod" }).reason).toBe("condition_failed");
  });

  it("tracks usage", () => {
    expect(m.getUsage("cond")).toEqual({ evaluations: 2, enabled: 1 });
  });
});
