#!/usr/bin/env tsx
/**
 * Release Management Tool
 * 
 * Automates the SDK release process including:
 * - Version bumping (semver compliant)
 * - Changelog generation
 * - Git tagging
 * - Pre-release checks
 * - Release notes generation
 * 
 * Usage:
 *   npm run release -- <major|minor|patch|prerelease> [options]
 *   npm run release -- patch --dry-run
 *   npm run release -- minor --skip-tests
 */

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";

type ReleaseType = "major" | "minor" | "patch" | "prerelease";

interface ReleaseOptions {
  type: ReleaseType;
  dryRun: boolean;
  skipTests: boolean;
  skipBuild: boolean;
  skipChecks: boolean;
  preId?: string;
  tag?: string;
  message?: string;
  force: boolean;
}

interface Version {
  major: number;
  minor: number;
  patch: number;
  prerelease?: string;
}

class ReleaseManager {
  private cwd: string;
  private packageJson: any;
  private currentVersion: Version;

  constructor() {
    this.cwd = process.cwd();
    this.packageJson = this.readPackageJson();
    this.currentVersion = this.parseVersion(this.packageJson.version);
  }

  private readPackageJson(): any {
    const path = resolve(this.cwd, "package.json");
    return JSON.parse(readFileSync(path, "utf8"));
  }

  private writePackageJson(data: any): void {
    const path = resolve(this.cwd, "package.json");
    writeFileSync(path, JSON.stringify(data, null, 2) + "\n", "utf8");
  }

  private parseVersion(versionString: string): Version {
    const match = versionString.match(/^(\d+)\.(\d+)\.(\d+)(?:-(.+))?$/);
    if (!match) {
      throw new Error(`Invalid version format: ${versionString}`);
    }
    return {
      major: parseInt(match[1], 10),
      minor: parseInt(match[2], 10),
      patch: parseInt(match[3], 10),
      prerelease: match[4],
    };
  }

  private formatVersion(version: Version): string {
    let v = `${version.major}.${version.minor}.${version.patch}`;
    if (version.prerelease) {
      v += `-${version.prerelease}`;
    }
    return v;
  }

  private bumpVersion(type: ReleaseType, preId?: string): Version {
    const v = { ...this.currentVersion };

    switch (type) {
      case "major":
        v.major++;
        v.minor = 0;
        v.patch = 0;
        v.prerelease = undefined;
        break;
      case "minor":
        v.minor++;
        v.patch = 0;
        v.prerelease = undefined;
        break;
      case "patch":
        v.patch++;
        v.prerelease = undefined;
        break;
      case "prerelease":
        if (v.prerelease) {
          // Bump existing prerelease
          const match = v.prerelease.match(/^(.+)\.(\d+)$/);
          if (match) {
            const id = match[1];
            const num = parseInt(match[2], 10);
            v.prerelease = `${id}.${num + 1}`;
          } else {
            v.prerelease = `${v.prerelease}.1`;
          }
        } else {
          // New prerelease
          const id = preId || "rc";
          v.patch++;
          v.prerelease = `${id}.0`;
        }
        break;
    }

    return v;
  }

  private exec(command: string, options: { silent?: boolean } = {}): string {
    try {
      return execSync(command, {
        cwd: this.cwd,
        encoding: "utf8",
        stdio: options.silent ? "pipe" : "inherit",
      }).trim();
    } catch (err: any) {
      if (options.silent) return "";
      throw err;
    }
  }

  private checkGitStatus(): void {
    const status = this.exec("git status --porcelain", { silent: true });
    if (status) {
      console.error("❌ Working directory not clean. Commit or stash changes first.");
      console.error(status);
      process.exit(1);
    }
  }

  private checkBranch(): void {
    const branch = this.exec("git rev-parse --abbrev-ref HEAD", { silent: true });
    if (branch !== "main" && branch !== "master") {
      console.warn(`⚠️  Warning: You're on branch '${branch}', not 'main'`);
    }
  }

  private checkNpmAuth(): void {
    try {
      this.exec("npm whoami", { silent: true });
    } catch {
      console.error("❌ Not authenticated with npm. Run: npm login");
      process.exit(1);
    }
  }

  private runTests(): void {
    console.log("🧪 Running tests...");
    this.exec("npm test");
  }

  private runBuild(): void {
    console.log("🔨 Building SDK...");
    this.exec("npm run build");
  }

  private runLint(): void {
    console.log("🔍 Type checking...");
    this.exec("npm run lint");
  }

  private runBundleSizeCheck(): void {
    console.log("📦 Checking bundle size...");
    try {
      this.exec("npm run bundle:check");
    } catch {
      console.warn("⚠️  Bundle size check failed");
    }
  }

  private generateChangelog(): void {
    console.log("📝 Generating changelog...");
    this.exec("npm run changelog");
  }

  private updateVersion(newVersion: Version): void {
    this.packageJson.version = this.formatVersion(newVersion);
    this.writePackageJson(this.packageJson);
    console.log(`✓ Updated package.json to ${this.packageJson.version}`);
  }

  private commitChanges(version: string, message?: string): void {
    const commitMsg = message || `chore: release v${version}`;
    this.exec(`git add package.json CHANGELOG.md`);
    this.exec(`git commit -m "${commitMsg}"`);
    console.log(`✓ Committed changes: ${commitMsg}`);
  }

  private createTag(version: string, tagName?: string): void {
    const tag = tagName || `v${version}`;
    const tagMsg = `Release ${tag}`;
    this.exec(`git tag -a ${tag} -m "${tagMsg}"`);
    console.log(`✓ Created tag: ${tag}`);
  }

  private pushChanges(version: string): void {
    console.log("⬆️  Pushing to remote...");
    this.exec("git push");
    this.exec(`git push origin v${version}`);
    console.log("✓ Pushed commits and tags");
  }

  private generateReleaseNotes(version: string): string {
    console.log("📋 Generating release notes...");
    
    // Extract changelog section for this version
    const changelogPath = resolve(this.cwd, "CHANGELOG.md");
    if (!existsSync(changelogPath)) {
      return `Release ${version}`;
    }

    const changelog = readFileSync(changelogPath, "utf8");
    const versionHeader = `## ${version}`;
    const startIdx = changelog.indexOf(versionHeader);
    
    if (startIdx === -1) {
      return `Release ${version}`;
    }

    const afterHeader = changelog.slice(startIdx + versionHeader.length);
    const nextVersionIdx = afterHeader.indexOf("\n## ");
    const notes = nextVersionIdx === -1 
      ? afterHeader 
      : afterHeader.slice(0, nextVersionIdx);

    return notes.trim();
  }

  private printReleaseNotes(version: string): void {
    const notes = this.generateReleaseNotes(version);
    console.log("\n" + "=".repeat(60));
    console.log(`Release Notes for v${version}`);
    console.log("=".repeat(60));
    console.log(notes);
    console.log("=".repeat(60) + "\n");
  }

  private verifyPublishedVersion(version: string): boolean {
    try {
      const latestVersion = this.exec(
        `npm view ${this.packageJson.name} version`,
        { silent: true }
      );
      return latestVersion === version;
    } catch {
      return false;
    }
  }

  public async release(options: ReleaseOptions): Promise<void> {
    const newVersion = this.bumpVersion(options.type, options.preId);
    const versionString = this.formatVersion(newVersion);

    console.log("\n🚀 Release Manager");
    console.log("=".repeat(60));
    console.log(`Current version: ${this.formatVersion(this.currentVersion)}`);
    console.log(`New version:     ${versionString}`);
    console.log(`Release type:    ${options.type}`);
    if (options.dryRun) {
      console.log("⚠️  DRY RUN MODE - No changes will be made");
    }
    console.log("=".repeat(60) + "\n");

    if (options.dryRun) {
      console.log("Would perform the following steps:");
      console.log("  1. Run pre-release checks");
      console.log("  2. Update version in package.json");
      console.log("  3. Generate changelog");
      console.log("  4. Commit changes");
      console.log("  5. Create git tag");
      console.log("  6. Push to remote");
      console.log("  7. Publish to npm");
      this.printReleaseNotes(versionString);
      return;
    }

    // Pre-release checks
    if (!options.skipChecks) {
      console.log("🔍 Running pre-release checks...\n");
      
      if (!options.force) {
        this.checkGitStatus();
        this.checkBranch();
        this.checkNpmAuth();
      }

      if (!options.skipTests) {
        this.runTests();
      }

      if (!options.skipBuild) {
        this.runBuild();
      }

      this.runLint();
      this.runBundleSizeCheck();
    }

    // Version bump and changelog
    console.log("\n📝 Preparing release...\n");
    this.updateVersion(newVersion);
    this.generateChangelog();

    // Git operations
    console.log("\n🔖 Creating release commit and tag...\n");
    this.commitChanges(versionString, options.message);
    this.createTag(versionString, options.tag);

    // Show release notes
    this.printReleaseNotes(versionString);

    // Push
    this.pushChanges(versionString);

    // Publish
    console.log("\n📦 Publishing to npm...\n");
    const publishCmd = options.type === "prerelease" 
      ? `npm publish --tag ${options.preId || "next"} --provenance --access public`
      : "npm publish --provenance --access public";
    
    this.exec(publishCmd);

    // Verify
    console.log("\n✅ Verifying publication...");
    setTimeout(() => {
      if (this.verifyPublishedVersion(versionString)) {
        console.log(`✓ Successfully published v${versionString} to npm`);
      } else {
        console.warn("⚠️  Could not verify publication (may take a few minutes)");
      }
    }, 5000);

    console.log("\n" + "=".repeat(60));
    console.log(`🎉 Release v${versionString} completed successfully!`);
    console.log("=".repeat(60));
    console.log("\nNext steps:");
    console.log(`  - Create GitHub release: https://github.com/${this.getRepoSlug()}/releases/new?tag=v${versionString}`);
    console.log(`  - Announce release on Discord/Twitter`);
    console.log(`  - Update documentation if needed`);
    console.log("");
  }

  private getRepoSlug(): string {
    try {
      const remote = this.exec("git remote get-url origin", { silent: true });
      const match = remote.match(/github\.com[:/](.+?)(?:\.git)?$/);
      return match ? match[1] : "owner/repo";
    } catch {
      return "owner/repo";
    }
  }
}

// CLI
function parseArgs(): ReleaseOptions {
  const args = process.argv.slice(2);
  
  if (args.length === 0 || args.includes("--help") || args.includes("-h")) {
    console.log(`
Usage: npm run release -- <type> [options]

Release Types:
  major       Bump major version (1.0.0 -> 2.0.0)
  minor       Bump minor version (1.0.0 -> 1.1.0)
  patch       Bump patch version (1.0.0 -> 1.0.1)
  prerelease  Create prerelease (1.0.0 -> 1.0.1-rc.0)

Options:
  --dry-run           Show what would happen without making changes
  --skip-tests        Skip test execution
  --skip-build        Skip build step
  --skip-checks       Skip all pre-release checks
  --pre-id <id>       Prerelease identifier (default: rc)
  --tag <name>        Custom git tag name
  --message <msg>     Custom commit message
  --force             Force release even with uncommitted changes
  --help, -h          Show this help message

Examples:
  npm run release -- patch
  npm run release -- minor --dry-run
  npm run release -- prerelease --pre-id beta
  npm run release -- major --skip-tests
    `);
    process.exit(0);
  }

  const type = args[0] as ReleaseType;
  if (!["major", "minor", "patch", "prerelease"].includes(type)) {
    console.error(`Invalid release type: ${type}`);
    process.exit(1);
  }

  const options: ReleaseOptions = {
    type,
    dryRun: args.includes("--dry-run"),
    skipTests: args.includes("--skip-tests"),
    skipBuild: args.includes("--skip-build"),
    skipChecks: args.includes("--skip-checks"),
    force: args.includes("--force"),
  };

  const preIdIdx = args.indexOf("--pre-id");
  if (preIdIdx !== -1 && args[preIdIdx + 1]) {
    options.preId = args[preIdIdx + 1];
  }

  const tagIdx = args.indexOf("--tag");
  if (tagIdx !== -1 && args[tagIdx + 1]) {
    options.tag = args[tagIdx + 1];
  }

  const msgIdx = args.indexOf("--message");
  if (msgIdx !== -1 && args[msgIdx + 1]) {
    options.message = args[msgIdx + 1];
  }

  return options;
}

async function main() {
  try {
    const options = parseArgs();
    const manager = new ReleaseManager();
    await manager.release(options);
  } catch (err: any) {
    console.error("\n❌ Release failed:", err.message);
    if (err.stack) {
      console.error(err.stack);
    }
    process.exit(1);
  }
}

main();
