/**
 * Bundle Size Audit — Automated tree-shaking guard for SDK exports.
 * 
 * Measures the gzipped size of built exports and fails CI if any export 
 * exceeds its configured budget.
 */

import { gzipSync } from "zlib";
import * as fs from "fs";
import * as path from "path";
import { EventEmitter } from "events";

interface SizeBudget {
  maxBytes: number;
}

interface SizeLimits {
  [exportName: string]: SizeBudget;
}

interface AuditResult {
  exportName: string;
  actualBytes: number;
  budgetBytes: number;
  overBudget: boolean;
  percentUsed: number;
}

interface BenchmarkSample {
  exportName: string;
  bytes: number;
  durationMs: number;
}

interface BenchmarkReport {
  samples: BenchmarkSample[];
  totalBytes: number;
  totalDurationMs: number;
  iterations: number;
}

interface SizeBaseline {
  totalBytes: number;
  recordedAt: string;
}

/**
 * Emits lifecycle events for the SDK performance benchmark suite.
 * Events: "start", "iteration", "sample", "complete", "error".
 */
export class BenchmarkRunner extends EventEmitter {
  private readonly iterations: number;

  constructor(iterations: number = 3) {
    super();
    this.iterations = Math.max(1, iterations);
  }

  /**
   * Run the benchmark across the provided export names, emitting lifecycle events.
   */
  run(exportNames: string[], measure: () => number): BenchmarkReport {
    this.emit("start", { exportNames, iterations: this.iterations });

    const samples: BenchmarkSample[] = [];
    let totalBytes = 0;
    let totalDurationMs = 0;

    try {
      for (let i = 0; i < this.iterations; i++) {
        this.emit("iteration", { index: i, total: this.iterations });

        const start = Date.now();
        const bytes = measure();
        const durationMs = Date.now() - start;

        totalBytes += bytes;
        totalDurationMs += durationMs;

        const perExport = Math.floor(bytes / Math.max(1, exportNames.length));
        for (const exportName of exportNames) {
          const sample: BenchmarkSample = { exportName, bytes: perExport, durationMs };
          samples.push(sample);
          this.emit("sample", sample);
        }
      }

      const report: BenchmarkReport = {
        samples,
        totalBytes,
        totalDurationMs,
        iterations: this.iterations,
      };

      this.emit("complete", report);
      return report;
    } catch (err) {
      this.emit("error", err);
      throw err;
    }
  }
}

/**
 * Load size limits configuration from the root.
 */
function loadSizeLimits(): SizeLimits {
  const configPath = path.resolve(process.cwd(), "size-limits.config.ts");
  
  if (!fs.existsSync(configPath)) {
    console.error("❌ size-limits.config.ts not found in project root");
    process.exit(1);
  }

  const configContent = fs.readFileSync(configPath, "utf-8");
  
  // Simple evaluation - extract the limits object
  const configMatch = configContent.match(/export\s+(?:const|default)\s+\w+\s*[:=]\s*({[\s\S]*})/);
  if (!configMatch) {
    console.error("❌ Could not parse size-limits.config.ts");
    process.exit(1);
  }

  try {
    // Parse the configuration object
    const configStr = configMatch[1]!.replace(/\/\/.*/g, ""); // Remove comments
    return eval(`(${configStr})`);
  } catch (err) {
    console.error("❌ Error parsing size limits config:", err);
    process.exit(1);
  }
}

/**
 * Path to the persisted size baseline used to track bundle size over time.
 */
function baselinePath(): string {
  return path.resolve(process.cwd(), "bundle-size-baseline.json");
}

/**
 * Load the previously recorded baseline, if any.
 */
function loadBaseline(): SizeBaseline | null {
  const file = baselinePath();
  if (!fs.existsSync(file)) {
    return null;
  }
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as SizeBaseline;
  } catch {
    return null;
  }
}

/**
 * Persist the current size as the new baseline for future runs.
 */
function saveBaseline(totalBytes: number): void {
  const baseline: SizeBaseline = {
    totalBytes,
    recordedAt: new Date().toISOString(),
  };
  fs.writeFileSync(baselinePath(), JSON.stringify(baseline, null, 2) + "\n", "utf-8");
}

/**
 * Measure the gzipped size of the entire dist bundle.
 * This is a simplified check since we can't easily split individual exports without rollup.
 */
function measureDistSize(): number {
  const distIndex = path.resolve(process.cwd(), "dist/index.js");

  if (!fs.existsSync(distIndex)) {
    throw new Error("dist/index.js not found. Run npm run build first.");
  }

  const code = fs.readFileSync(distIndex, "utf-8");
  
  // Minify basic (remove whitespace and comments)
  const minified = code
    .replace(/\/\*[\s\S]*?\*\//g, "") // Remove block comments
    .replace(/\/\/.*/g, "") // Remove line comments
    .replace(/\s+/g, " ") // Collapse whitespace
    .trim();

  // Gzip and measure
  const gzipped = gzipSync(Buffer.from(minified));
  return gzipped.length;
}

/**
 * Run the audit on all configured exports.
 * For now, we'll check if the total bundle size is reasonable.
 */
async function runAudit(): Promise<void> {
  console.log("📦 Bundle Size Audit\n");
  console.log("Loading size limits configuration...");
  
  const sizeLimits = loadSizeLimits();
  const exportNames = Object.keys(sizeLimits);
  
  console.log(`Found ${exportNames.length} export budgets to audit\n`);

  const results: AuditResult[] = [];
  let hasFailures = false;

  // For now, measure the total bundle size
  try {
    process.stdout.write("Measuring total bundle size... ");
    const totalBytes = measureDistSize();
    console.log(`${totalBytes} bytes gzipped\n`);

    // Track size against the recorded baseline
    const baseline = loadBaseline();
    if (baseline) {
      const delta = totalBytes - baseline.totalBytes;
      const sign = delta > 0 ? "+" : "";
      console.log(
        `Baseline: ${baseline.totalBytes}B (${baseline.recordedAt}) → Δ ${sign}${delta}B\n`
      );
    } else {
      console.log("No baseline recorded yet — this run will establish one.\n");
    }

    // Check each export budget (simplified - we assume proportional distribution)
    for (const exportName of exportNames) {
      const budget = sizeLimits[exportName]!.maxBytes;
      
      // Simplified: Check if the export would reasonably fit in the budget
      // Real implementation would need bundler to tree-shake individual exports
      const estimatedBytes = Math.floor(totalBytes / exportNames.length);
      const overBudget = estimatedBytes > budget;
      const percentUsed = ((estimatedBytes / budget) * 100).toFixed(1);

      if (overBudget) {
        hasFailures = true;
        console.log(`${exportName}: ❌ ~${estimatedBytes}B (${percentUsed}% of ${budget}B budget)`);
      } else {
        console.log(`${exportName}: ✅ ~${estimatedBytes}B (${percentUsed}% of ${budget}B budget)`);
      }

      results.push({
        exportName,
        actualBytes: estimatedBytes,
        budgetBytes: budget,
        overBudget,
        percentUsed: parseFloat(percentUsed),
      });
    }

    // Print summary table
    console.log("\n📊 Summary\n");
    console.log("| Export | Estimated | Budget | % Used | Status |");
    console.log("|--------|-----------|--------|--------|--------|");
    
    for (const result of results) {
      const status = result.overBudget ? "❌ OVER" : "✅ OK";
      const actual = `${result.actualBytes}B`;
      const budget = `${result.budgetBytes}B`;
      console.log(
        `| ${result.exportName.padEnd(20)} | ${actual.padEnd(9)} | ${budget.padEnd(8)} | ${result.percentUsed.toFixed(1)}% | ${status} |`
      );
    }

    if (hasFailures) {
      console.log("\n❌ Bundle size audit FAILED - one or more exports may exceed their budget");
      console.log("Note: This is an estimated check. Consider adding rollup for precise per-export measurement.");
      process.exit(1);
    } else {
      // Record the current size as the new baseline for future tracking
      saveBaseline(totalBytes);
      console.log("\n✅ Bundle size audit PASSED - all exports estimated within budget");
      console.log(`📌 Baseline updated to ${totalBytes}B`);
      process.exit(0);
    }
  } catch (err: any) {
    console.error("\n❌ Audit failed:", err.message);
    process.exit(1);
  }
}

// Run the audit
runAudit().catch((err) => {
  console.error("❌ Audit failed with error:", err);
  process.exit(1);
});
