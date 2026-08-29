import { describe, expect, it } from "vitest";
import { aggregateServiceHealth } from "../src/healthDashboard.js";

describe("aggregateServiceHealth", () => {
  it("returns healthy when all services are healthy", () => {
    expect(aggregateServiceHealth(["healthy", "healthy"])).toBe("healthy");
  });

  it("returns degraded when one service is degraded and none are down", () => {
    expect(aggregateServiceHealth(["healthy", "degraded", "healthy"])).toBe("degraded");
  });

  it("returns down when any service is down", () => {
    expect(aggregateServiceHealth(["healthy", "down", "degraded"])).toBe("down");
  });
});
