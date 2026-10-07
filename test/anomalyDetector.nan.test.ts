import { describe, expect, it } from "vitest";
import { AnomalyDetector } from "../src/anomalyDetector.js";

describe("AnomalyDetector sensitivityThreshold validation", () => {
  it("rejects NaN instead of silently disabling score alerts", () => {
    expect(() => new AnomalyDetector({ sensitivityThreshold: Number.NaN })).toThrow(
      RangeError
    );
  });

  it("still accepts finite values at the upper boundary", () => {
    expect(() => new AnomalyDetector({ sensitivityThreshold: 1 })).not.toThrow();
  });
});
