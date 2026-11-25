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
  /**
   * Emit a per-module size breakdown (issue #1327) so unused/dead code and
   * oversized assets can be identified before they ship.
   */
  analyze: boolean;
  /**
   * Compress emitted assets with gzip/brotli during the size report
   * (issue #1327).
   */
  compressAssets: boolean;
  /**
   * Persist the measured size to a tracked baseline file so regressions are
   * visible over time (issue #1327).
   */
  trackSize: boolean;
  /** Path to the tracked size baseline used for growth comparisons. */
  baselinePath: string;
}

export const bundleSizeConfig: BundleSizeConfig = {
  entryPoint: "src/index.ts",
  maxGzipBytes: 450_000,
  maxGrowthPercent: 5,
  noiseFloorBytes: 1_024,
  analyze: true,
  compressAssets: true,
  trackSize: true,
  baselinePath: "scripts/bundle-size-baseline.json",
};
