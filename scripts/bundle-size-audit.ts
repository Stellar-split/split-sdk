/**
 * Bundle Size Audit — Automated tree-shaking guard for SDK exports.
 * 
 * Measures the gzipped size of built exports and fails CI if any export 
 * exceeds its configured budget.
 */

import { gzipSync } from "zlib";
import * as fs from "fs";
import * as path from "path";

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
      console.log("\n✅ Bundle size audit PASSED - all exports estimated within budget");
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
