import { describe, it, expect } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  BREAKING_CHANGES,
  MIGRATION_STEPS,
  TROUBLESHOOTING_CATALOG,
  getBreakingChangesForUpgrade,
  findTroubleshootingGuide,
  validateSdkMigration,
  MigrationProgressTracker,
} from "../src/migration/versionMigrationGuide.js";
import { parseAmount, formatAmount } from "../src/utils.js";
import {
  NetworkEnvironment,
  getNetworkPreset,
  isNetworkPreset,
} from "../src/config.js";
import { PluginRegistry, LoggingPlugin } from "../src/plugin.js";
import { migrate, VersionTracker } from "../src/versionManager.js";

describe("SDK Version Migration Guides, Validation & Progress Tracking (#1200)", () => {
  const repoRoot = path.resolve(__dirname, "..");
  const migrationMdPath = path.join(repoRoot, "docs", "MIGRATION.md");

  it("identifies breaking changes across v0.x -> v1.0.0 and v1.0.0 -> v2.0.0", () => {
    const v0ToV1 = getBreakingChangesForUpgrade("0.9.0", "1.0.0");
    expect(v0ToV1.map((c) => c.id)).toEqual(["BC-101", "BC-102"]);

    const v1ToV2 = getBreakingChangesForUpgrade("1.0.0", "2.0.0");
    expect(v1ToV2.map((c) => c.id)).toEqual([
      "BC-201",
      "BC-202",
      "BC-203",
      "BC-204",
      "BC-205",
    ]);

    const fullUpgrade = getBreakingChangesForUpgrade("0.9.0", "2.0.0");
    expect(fullUpgrade.length).toBe(BREAKING_CHANGES.length);
  });

  it("provides clear, ordered migration steps with before/after examples and verification commands", () => {
    const v1Steps = MIGRATION_STEPS.filter((s) => s.pathId === "v0-to-v1");
    const v2Steps = MIGRATION_STEPS.filter((s) => s.pathId === "v1-to-v2");

    expect(v1Steps.map((s) => s.order)).toEqual([1, 2]);
    expect(v2Steps.map((s) => s.order)).toEqual([1, 2, 3, 4, 5]);

    for (const step of MIGRATION_STEPS) {
      expect(step.beforeExample.length).toBeGreaterThan(10);
      expect(step.afterExample.length).toBeGreaterThan(10);
      expect(step.verificationCommand.length).toBeGreaterThan(3);
    }
  });

  it("executes the migrated v2 code examples (BigInt amounts, network presets, plugins, and state migration)", () => {
    // 1. BigInt stroop conversion example
    const stroops = parseAmount("2.5");
    expect(typeof stroops).toBe("bigint");
    expect(stroops).toBe(25_000_000n);
    expect(formatAmount(stroops)).toBe("2.5000000");

    // 2. NetworkEnvironment preset example
    const preset = getNetworkPreset(NetworkEnvironment.TESTNET);
    expect(isNetworkPreset(preset)).toBe(true);
    expect(preset.rpcUrl).toContain("soroban-testnet.stellar.org");

    // 3. PluginRegistry example
    const registry = new PluginRegistry();
    registry.use(LoggingPlugin);
    expect(registry.getPlugins()).toContain("LoggingPlugin");

    // 4. State migration & VersionTracker example
    const versionTracker = new VersionTracker("1.0.0");
    const migratedState = migrate(
      { amount: 1000000, legacyWallet: "FreighterConnector" },
      "1.0.0",
      "2.0.0",
      [
        {
          from: "1.0.0",
          to: "2.0.0",
          description: "Convert amount to BigInt string representation and upgrade wallet adapter",
          apply: (state) => ({
            ...state,
            amount: BigInt(state.amount as number),
            walletAdapter: "FreighterAdapter",
          }),
        },
      ],
    );
    versionTracker.update("2.0.0");
    expect(migratedState.amount).toBe(1000000n);
    expect(migratedState.walletAdapter).toBe("FreighterAdapter");
    expect(versionTracker.version).toBe("2.0.0");
    expect(versionTracker.transitions).toHaveLength(1);
  });

  it("provides searchable troubleshooting entries by error code, message, or symptom", () => {
    expect(TROUBLESHOOTING_CATALOG.length).toBeGreaterThanOrEqual(4);

    const bigIntHits = findTroubleshootingGuide("Cannot mix BigInt");
    expect(bigIntHits).toHaveLength(1);
    expect(bigIntHits[0].id).toBe("TS-001");
    expect(bigIntHits[0].resolutionSteps.length).toBeGreaterThanOrEqual(2);

    const walletHits = findTroubleshootingGuide("requestAccess");
    expect(walletHits).toHaveLength(1);
    expect(walletHits[0].id).toBe("TS-002");

    const exportHits = findTroubleshootingGuide("ERR_PACKAGE_PATH_NOT_EXPORTED");
    expect(exportHits).toHaveLength(1);
    expect(exportHits[0].id).toBe("TS-004");
  });

  it("accurately validates legacy vs. migrated configurations, payloads, and code snippets", () => {
    const legacyCheck = validateSdkMigration({
      targetVersion: "2.0.0",
      config: {
        onLog: () => {},
      },
      invoicePayload: {
        amount: 1000000,
      },
      codeSnippet: `
        import { parseAmount } from "split-sdk/dist/utils";
        const wallet = new FreighterConnector();
        await wallet.requestAccess();
      `,
    });

    expect(legacyCheck.valid).toBe(false);
    expect(legacyCheck.issues.map((i) => i.breakingChangeId)).toEqual(
      expect.arrayContaining(["BC-101", "BC-201", "BC-202", "BC-204", "BC-205"]),
    );

    const migratedCheck = validateSdkMigration({
      targetVersion: "2.0.0",
      config: {
        ...getNetworkPreset(NetworkEnvironment.TESTNET),
        contractId: "CCONTRACT1234567890ABCDEFGHIJKLMNOPQRSTUVWXYZ234567",
      },
      invoicePayload: {
        amount: 1000000n,
      },
      codeSnippet: `
        import { FreighterAdapter } from "@stellar-split/sdk";
        import { parseAmount } from "@stellar-split/sdk/utils";
        const wallet = new FreighterAdapter();
        const address = await wallet.connect();
      `,
    });

    expect(migratedCheck.valid).toBe(true);
    expect(migratedCheck.issues).toHaveLength(0);
    expect(migratedCheck.warnings).toHaveLength(0);
    expect(migratedCheck.score).toBe(100);
  });

  it("tracks migration progress across steps, blockers, and JSON persistence", () => {
    const tracker = new MigrationProgressTracker("v1-to-v2");
    expect(tracker.getSummary().totalSteps).toBe(5);
    expect(tracker.getSummary().percentComplete).toBe(0);
    expect(tracker.getSummary().isComplete).toBe(false);

    tracker.completeStep("step-v2-1-imports", "Replaced deep imports");
    tracker.completeStep("step-v2-2-network", "Added TESTNET preset");
    tracker.skipStep("step-v2-3-wallets", "Backend service uses keypair signer");

    // Validate step 4 with an invalid number amount first -> blocks step
    const failedStep = tracker.validateAndCompleteStep("step-v2-4-bigint", {
      invoicePayload: { amount: 5000 },
    });
    expect(failedStep.step.status).toBe("blocked");
    expect(tracker.getSummary().blockedSteps).toBe(1);

    // Fix payload to bigint and re-validate -> completes step
    const passedStep = tracker.validateAndCompleteStep("step-v2-4-bigint", {
      invoicePayload: { amount: 5000n },
    });
    expect(passedStep.step.status).toBe("completed");

    // Complete final step
    tracker.completeStep("step-v2-5-telemetry", "Enabled LoggingPlugin");

    const finalSummary = tracker.getSummary();
    expect(finalSummary.percentComplete).toBe(100);
    expect(finalSummary.isComplete).toBe(true);
    expect(finalSummary.completedSteps).toBe(4);
    expect(finalSummary.skippedSteps).toBe(1);

    // Round-trip JSON persistence
    const restored = MigrationProgressTracker.fromJSON(tracker.toJSON());
    expect(restored.getSummary().percentComplete).toBe(100);
    expect(restored.getSummary().isComplete).toBe(true);
  });

  it("verifies docs/MIGRATION.md contains all required sections", () => {
    expect(fs.existsSync(migrationMdPath)).toBe(true);
    const md = fs.readFileSync(migrationMdPath, "utf8");

    expect(md).toContain("## 1. Semantic Versioning & Compatibility Matrix");
    expect(md).toContain("## 2. Breaking Changes Catalog");
    expect(md).toContain("## 3. Step-by-Step Migration: v0.x to v1.x");
    expect(md).toContain("## 4. Step-by-Step Migration: v1.x to v2.x");
    expect(md).toContain("## 5. Working Code Examples (Before & After)");
    expect(md).toContain("## 6. Troubleshooting Guide");
    expect(md).toContain("## 7. Automated Migration Validation & Progress Tracking");
  });
});
