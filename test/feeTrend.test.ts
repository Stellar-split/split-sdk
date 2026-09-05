import { describe, it, expect } from "vitest";
import { computeMovingAverage } from "../src/fees/trend.js";

describe("computeMovingAverage", () => {
  it("returns NaN-padded SMA for a valid window", () => {
    const samples = [1, 2, 3, 4, 5];
    const result = computeMovingAverage(samples, 3);
    expect(result[0]).toBeNaN();
    expect(result[1]).toBeNaN();
    expect(result[2]).toBeCloseTo(2, 10);
    expect(result[3]).toBeCloseTo(3, 10);
    expect(result[4]).toBeCloseTo(4, 10);
  });

  it("returns the original value when windowSize is 1", () => {
    const samples = [10, 20, 30];
    const result = computeMovingAverage(samples, 1);
    expect(result).toEqual([10, 20, 30]);
  });

  it("returns all NaN when windowSize exceeds sample length", () => {
    const samples = [1, 2];
    const result = computeMovingAverage(samples, 5);
    expect(result[0]).toBeNaN();
    expect(result[1]).toBeNaN();
  });

  it("returns an empty array for empty input", () => {
    expect(computeMovingAverage([], 3)).toEqual([]);
  });

  it("throws RangeError when windowSize is 0", () => {
    expect(() => computeMovingAverage([1, 2, 3], 0)).toThrow(RangeError);
  });

  it("throws RangeError when windowSize is negative", () => {
    expect(() => computeMovingAverage([1, 2, 3], -1)).toThrow(RangeError);
  });

  it("matches hand-calculated SMA for a longer series", () => {
    const samples = [10, 11, 12, 13, 14, 15];
    const result = computeMovingAverage(samples, 4);
    expect(result[0]).toBeNaN();
    expect(result[1]).toBeNaN();
    expect(result[2]).toBeNaN();
    expect(result[3]).toBeCloseTo(11.5, 10); // (10+11+12+13)/4
    expect(result[4]).toBeCloseTo(12.5, 10); // (11+12+13+14)/4
    expect(result[5]).toBeCloseTo(13.5, 10); // (12+13+14+15)/4
  });

  it("does not mutate the input array", () => {
    const samples = [1, 2, 3, 4, 5];
    const snapshot = [...samples];
    computeMovingAverage(samples, 3);
    expect(samples).toEqual(snapshot);
  });
});
