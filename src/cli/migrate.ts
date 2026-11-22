#!/usr/bin/env node

import { program } from "commander";
import * as fs from "fs";
import * as path from "path";
import { detectBreakingChanges, generateMarkdown } from "./detector";
import { execSync } from "child_process";

// Exit codes
const EXIT_SUCCESS = 0;
const EXIT_BREAKING_CHANGES = 1;
const EXIT_GUIDE_OUT_OF_DATE = 3;
const EXIT_ERROR = 2;

program
  .name("stellar-split-sdk-migrate")
  .description("Compare two SDK versions and detect breaking changes")
  .requiredOption("--from <version>", "Base version or path")
  .requiredOption("--to <version>", "Target version or path")
  .option("--out <path>", "Output path for the markdown guide", "docs/MIGRATION.md")
  .option("--check", "Validate that the existing guide documents all detected breaking changes", false)
  .parse(process.argv);

const options = program.opts();

let currentPhase = "init";

function progress(phase: string, message: string) {
  currentPhase = phase;
  console.log(`[${phase}] ${message}`);
}

/**
 * Validates that every detected breaking change is documented in the guide.
 * Returns the list of undocumented changes (empty if the guide is up to date).
 */
function validateGuide(guideContent: string, changes: any[]): any[] {
  const missing: any[] = [];
  for (const change of changes) {
    // A change is considered documented if its identifier/name appears in the guide.
    const identifier =
      change.name || change.symbol || change.identifier || change.signature;
    if (!identifier || !guideContent.includes(String(identifier))) {
      missing.push(change);
    }
  }
  return missing;
}

async function run() {
  progress("init", `Comparing version ${options.from} to ${options.to}...`);

  // We need to fetch the types for --from and --to.
  // In a real scenario, this could checkout branches to a temp directory,
  // or fetch from npm. Since this is an SDK tool, let's assume it checks out git tags/branches.
  // Wait, if it compares using ts-morph, we need the actual files.
  // The requirements say: "Compares exported TypeScript types between versions using ts-morph".
  // Let's implement a simple approach: if it's a path, use it. Otherwise, checkout from git to a temp dir.
  
  // For the sake of the requirements, let's assume we can checkout git references into temp directories.
  const tempDirFrom = fs.mkdtempSync("sdk-migrate-from-");
  const tempDirTo = fs.mkdtempSync("sdk-migrate-to-");

  try {
    // Clone and checkout from
    progress("clone", `Cloning base version ${options.from}...`);
    execSync(`git clone . ${tempDirFrom}`);
    progress("checkout", `Checking out ${options.from}...`);
    execSync(`git checkout ${options.from}`, { cwd: tempDirFrom, stdio: 'ignore' });
    
    // Clone and checkout to
    progress("clone", `Cloning target version ${options.to}...`);
    execSync(`git clone . ${tempDirTo}`);
    progress("checkout", `Checking out ${options.to}...`);
    execSync(`git checkout ${options.to}`, { cwd: tempDirTo, stdio: 'ignore' });

    // Try to find the entry point. Usually src/index.ts or src/**/*.ts
    const fromFiles = [path.join(tempDirFrom, "src/**/*.ts")];
    const toFiles = [path.join(tempDirTo, "src/**/*.ts")];

    progress("detect", "Detecting breaking changes...");
    const changes = detectBreakingChanges(fromFiles, toFiles);

    if (options.check) {
      progress("validate", `Validating guide at ${options.out}...`);
      if (!fs.existsSync(options.out)) {
        console.error(`Guide not found at ${options.out}. Run without --check to generate it.`);
        process.exit(EXIT_GUIDE_OUT_OF_DATE);
      }
      const guideContent = fs.readFileSync(options.out, "utf8");
      const missing = validateGuide(guideContent, changes);
      if (missing.length > 0) {
        console.error(
          `Guide is out of date: ${missing.length} of ${changes.length} breaking change(s) undocumented.`
        );
        for (const change of missing) {
          const identifier =
            change.name || change.symbol || change.identifier || change.signature;
          console.error(`  - ${identifier ?? "(unknown change)"}`);
        }
        process.exit(EXIT_GUIDE_OUT_OF_DATE);
      }
      progress("validate", "Guide is up to date.");
      process.exit(EXIT_SUCCESS);
    }

    if (changes.length > 0) {
      progress("generate", `Detected ${changes.length} breaking changes. Generating guide...`);
      const md = generateMarkdown(changes);
      
      const outDir = path.dirname(options.out);
      if (!fs.existsSync(outDir)) {
        fs.mkdirSync(outDir, { recursive: true });
      }
      fs.writeFileSync(options.out, md);
      progress("generate", `Migration guide generated at ${options.out}`);
      
      process.exit(EXIT_BREAKING_CHANGES);
    } else {
      progress("generate", "No breaking changes detected.");
      process.exit(EXIT_SUCCESS);
    }
  } catch (error) {
    console.error(`Error during comparison (phase: ${currentPhase}):`, error);
    process.exit(EXIT_ERROR);
  } finally {
    fs.rmSync(tempDirFrom, { recursive: true, force: true });
    fs.rmSync(tempDirTo, { recursive: true, force: true });
  }
}

run();
