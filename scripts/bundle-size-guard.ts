/**
 * SDK Bundle Size Regression Guard (issue #586)
 *
 * Measures the minified and gzipped ESM bundle produced from `src/index.ts`
 * and fails the build when the size exceeds a threshold or grows by more than
 * an allowed percentage relative to the main-branch baseline.
 *
 * Usage:
 *   npm run bundle:check              # compare against scripts/bundle-size-baseline.json
 *   BUNDLE_BASELINE_UPDATE=true npm run bundle:check   # (re)write the baseline
 *
 * The `bundle:update-baseline` npm script is guarded against accidental
 * invocation outside CI by requiring the `BUNDLE_BASELINE_UPDATE=true` env
 * var.
 */

import { build } from "esbuild";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { fileURLToPath, pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { bundleSizeConfig, type BundleSizeConfig } from "./bundle-size-config.js";

/** A size measurement of the produced bundle. */
export interface BundleMeasurement {
  minifiedBytes: number;
  gzipBytes: number;
}

/** Baseline persisted to scripts/bundle-size-baseline.json. */
export interface BundleBaseline extends BundleMeasurement {
  entryPoint: string;
  measuredAt: string;
}

/** Verdict produced by {@link evaluateBundle}. */
export interface BundleSizeVerdict {
  pass: boolean;
  measured: BundleMeasurement;
  baseline: BundleMeasurement | null;
  /** Signed delta in gzipped bytes vs baseline (negative = smaller). */
  deltaBytes: number;
  /** Signed percentage change vs baseline. */
  deltaPercent: number;
  /** Human-readable reasons when the check fails. */
  reasons: string[];
}

const CONFIG_DIR = dirname(fileURLToPath(import.meta.url));
const BASELINE_PATH = join(CONFIG_DIR, "bundle-size-baseline.json");
const REPORT_PATH = join(CONFIG_DIR, "bundle-size-report.json");

/**
 * Pure decision logic, exported for unit tests.
 *
 * Rules:
 *  - No baseline ⇒ fail with instructions to regenerate it.
 *  - `gzipBytes >= maxGzipBytes` ⇒ fail (strict at the boundary).
 *  - Growth above the noise floor *and* at/over the allowed percentage ⇒ fail.
 *  - Shrinkage is always fine.
 */
export function evaluateBundle(
  measured: BundleMeasurement,
  baseline: BundleMeasurement | null,
  config: BundleSizeConfig,
): BundleSizeVerdict {
  const reasons: string[] = [];

  if (!baseline) {
    reasons.push(
      `no baseline found — run \`npm run bundle:update-baseline\` to record scripts/bundle-size-baseline.json`,
    );
  }

  const deltaBytes = baseline ? measured.gzipBytes - baseline.gzipBytes : 0;
  const deltaPercent =
    baseline && baseline.gzipBytes > 0
      ? (deltaBytes / baseline.gzipBytes) * 100
      : 0;

  const formatBytes = (bytes: number): string =>
    bytes.toLocaleString("en-US");

  if (measured.gzipBytes >= config.maxGzipBytes) {
    reasons.push(
      `gzipped bundle ${formatBytes(measured.gzipBytes)} B >= max ${formatBytes(
        config.maxGzipBytes,
      )} B`,
    );
  }

  if (
    baseline &&
    deltaBytes > config.noiseFloorBytes &&
    deltaPercent >= config.maxGrowthPercent
  ) {
    reasons.push(
      `gzipped bundle grew ${formatBytes(deltaBytes)} B (${deltaPercent.toFixed(
        2,
      )}%) — exceeds noise floor ${formatBytes(
        config.noiseFloorBytes,
      )} B and ${config.maxGrowthPercent}% allowance`,
    );
  }

  return {
    pass: reasons.length === 0,
    measured,
    baseline,
    deltaBytes,
    deltaPercent,
    reasons,
  };
}

/** Bundles the entry point with esbuild and measures minified + gzipped sizes. */
export async function measureBundle(
  entryPoint: string,
): Promise<BundleMeasurement> {
  const result = await build({
    entryPoints: [entryPoint],
    bundle: true,
    format: "esm",
    // Node platform mirrors the real `npm run build` (tsup) output: Node
    // builtins such as `crypto`/`fs` stay external and are not counted, so the
    // measurement reflects the SDK's own payload plus bundled dependencies.
    platform: "node",
    target: "es2020",
    minify: true,
    write: false,
    logLevel: "error",
  });
  const minifiedBytes = result.outputFiles[0]!.contents.byteLength;
  const gzipBytes = gzipSync(result.outputFiles[0]!.contents).byteLength;
  return { minifiedBytes, gzipBytes };
}

function loadBaseline(): BundleMeasurement | null {
  if (!existsSync(BASELINE_PATH)) return null;
  const parsed = JSON.parse(readFileSync(BASELINE_PATH, "utf8")) as BundleBaseline;
  return { minifiedBytes: parsed.minifiedBytes, gzipBytes: parsed.gzipBytes };
}

function writeBaseline(measured: BundleMeasurement): void {
  const baseline: BundleBaseline = {
    ...measured,
    entryPoint: bundleSizeConfig.entryPoint,
    measuredAt: new Date().toISOString(),
  };
  writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 2)}\n`);
  console.log(`✅ baseline written to ${BASELINE_PATH}`);
}

function formatBytes(bytes: number): string {
  return `${bytes.toLocaleString("en-US")} B`;
}

function printReport(verdict: BundleSizeVerdict): void {
  console.log("📦 SDK Bundle Size Guard\n");
  console.log(`  minified : ${formatBytes(verdict.measured.minifiedBytes)}`);
  console.log(`  gzipped  : ${formatBytes(verdict.measured.gzipBytes)}`);

  if (verdict.baseline) {
    const sign = verdict.deltaBytes >= 0 ? "+" : "";
    console.log(
      `  baseline : ${formatBytes(verdict.baseline.gzipBytes)} (delta ${sign}${formatBytes(
        verdict.deltaBytes,
      )} / ${sign}${verdict.deltaPercent.toFixed(2)}%)`,
    );
  } else {
    console.log("  baseline : <none>");
  }

  writeFileSync(
    REPORT_PATH,
    `${JSON.stringify(verdict, null, 2)}\n`,
  );
  console.log(`\n  report   : ${REPORT_PATH}`);

  if (verdict.pass) {
    console.log("\n✅ Bundle size within threshold");
  } else {
    console.log("\n❌ Bundle size guard failed:");
    for (const reason of verdict.reasons) {
      console.log(`   - ${reason}`);
    }
  }
}

async function main(): Promise<void> {
  // Baseline updates are guarded against accidental invocation: the baseline is
  // only (re)written when BUNDLE_BASELINE_UPDATE=true is explicitly set (see
  // the `bundle:update-baseline` npm script).
  const updateBaseline = process.env.BUNDLE_BASELINE_UPDATE === "true";

  const measured = await measureBundle(bundleSizeConfig.entryPoint);

  if (updateBaseline) {
    writeBaseline(measured);
    process.exit(0);
  }

  const verdict = evaluateBundle(
    measured,
    loadBaseline(),
    bundleSizeConfig,
  );
  printReport(verdict);
  process.exit(verdict.pass ? 0 : 1);
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  main().catch((error) => {
    console.error("❌ bundle size guard failed with error:", error);
    process.exit(1);
  });
}
