/**
 * Bundle size regression guard configuration (issue #586).
 *
 * Thresholds are applied to the minified-and-gzipped ESM bundle produced from
 * `src/index.ts`. Tune these as the SDK grows; update the baseline with:
 *
 *   npm run bundle:update-baseline
 */
export interface BundleSizeConfig {
  /** Entry point measured by the guard. */
  entryPoint: string;
  /**
   * Fail when the gzipped bundle size reaches or exceeds this many bytes.
   * Under-threshold bundles pass; exactly-at-threshold fails (a regression
   * guard should be strict at the boundary).
   */
  maxGzipBytes: number;
  /**
   * Fail when the gzipped bundle grows by this percentage or more relative to
   * the main-branch baseline.
   */
  maxGrowthPercent: number;
  /**
   * Changes smaller than this many gzipped bytes are ignored, preventing
   * spurious CI failures on trivial edits. Default per issue: 1 KB.
   */
  noiseFloorBytes: number;
}

export const bundleSizeConfig: BundleSizeConfig = {
  entryPoint: "src/index.ts",
  maxGzipBytes: 450_000,
  maxGrowthPercent: 5,
  noiseFloorBytes: 1_024,
};
