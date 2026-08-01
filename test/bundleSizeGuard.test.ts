// esbuild refuses to load under jsdom's TextEncoder (Uint8Array instance
// check), so this suite runs in the node environment.
// @vitest-environment node
import { describe, expect, it } from "vitest";
import {
  evaluateBundle,
  type BundleSizeConfig,
} from "../scripts/bundle-size-guard.js";

const CONFIG: BundleSizeConfig = {
  entryPoint: "src/index.ts",
  maxGzipBytes: 100_000,
  maxGrowthPercent: 5,
  noiseFloorBytes: 1_024,
};

const baseline = { minifiedBytes: 500_000, gzipBytes: 90_000 };

function exitCodeOf(pass: boolean): number {
  return pass ? 0 : 1;
}

describe("evaluateBundle (bundle:check decision logic)", () => {
  it("passes a bundle under the size threshold", () => {
    const verdict = evaluateBundle(
      { minifiedBytes: 480_000, gzipBytes: 89_500 },
      baseline,
      CONFIG,
    );
    expect(verdict.pass).toBe(true);
    expect(exitCodeOf(verdict.pass)).toBe(0);
    expect(verdict.reasons).toEqual([]);
  });

  it("fails a bundle exactly at the threshold (strict boundary)", () => {
    const verdict = evaluateBundle(
      { minifiedBytes: 500_000, gzipBytes: 100_000 },
      baseline,
      CONFIG,
    );
    expect(verdict.pass).toBe(false);
    expect(exitCodeOf(verdict.pass)).toBe(1);
    expect(verdict.reasons.some((r) => r.includes("max 100,000 B"))).toBe(true);
  });

  it("fails a bundle over the threshold", () => {
    const verdict = evaluateBundle(
      { minifiedBytes: 600_000, gzipBytes: 100_001 },
      baseline,
      CONFIG,
    );
    expect(verdict.pass).toBe(false);
    expect(exitCodeOf(verdict.pass)).toBe(1);
  });

  it("ignores growth below the noise floor even when the percentage is large", () => {
    const verdict = evaluateBundle(
      { minifiedBytes: 500_000, gzipBytes: 90_500 }, // +500 B, well under 1 KB
      baseline,
      CONFIG,
    );
    expect(verdict.pass).toBe(true);
    expect(exitCodeOf(verdict.pass)).toBe(0);
  });

  it("fails when growth exceeds the noise floor and the allowed percentage", () => {
    const verdict = evaluateBundle(
      { minifiedBytes: 500_000, gzipBytes: 95_000 }, // +5 KB = +5.56%
      baseline,
      CONFIG,
    );
    expect(verdict.pass).toBe(false);
    expect(exitCodeOf(verdict.pass)).toBe(1);
    expect(verdict.deltaBytes).toBe(5_000);
    expect(verdict.deltaPercent).toBeGreaterThan(5);
    expect(verdict.reasons.some((r) => r.includes("grew 5,000 B"))).toBe(true);
  });

  it("fails when there is no baseline, instructing a baseline update", () => {
    const verdict = evaluateBundle(
      { minifiedBytes: 500_000, gzipBytes: 90_000 },
      null,
      CONFIG,
    );
    expect(verdict.pass).toBe(false);
    expect(exitCodeOf(verdict.pass)).toBe(1);
    expect(
      verdict.reasons.some((r) => r.includes("bundle:update-baseline")),
    ).toBe(true);
  });

  it("reports minified size, gzipped size, absolute delta, and percentage change", () => {
    const verdict = evaluateBundle(
      { minifiedBytes: 600_000, gzipBytes: 92_000 },
      baseline,
      CONFIG,
    );
    expect(verdict.measured.minifiedBytes).toBe(600_000);
    expect(verdict.measured.gzipBytes).toBe(92_000);
    expect(verdict.deltaBytes).toBe(2_000);
    expect(verdict.deltaPercent).toBeCloseTo((2_000 / 90_000) * 100, 5);
  });

  it("treats shrinkage as always fine", () => {
    const verdict = evaluateBundle(
      { minifiedBytes: 300_000, gzipBytes: 80_000 },
      baseline,
      CONFIG,
    );
    expect(verdict.pass).toBe(true);
    expect(exitCodeOf(verdict.pass)).toBe(0);
  });
});
