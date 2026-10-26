/**
 * SDK Version Migration Guide, Validator & Progress Tracker (#1200).
 *
 * Provides structured breaking-change definitions, step-by-step migration plans,
 * executable code examples, troubleshooting playbooks, configuration/code
 * migration validation, and stateful progress tracking across SDK versions.
 */

import { compareVersions, parseVersion } from "../versionManager.js";

export type MigrationPathId = "v0-to-v1" | "v1-to-v2" | "v0-to-v2";

export type BreakingChangeCategory =
  | "client-initialization"
  | "wallet-adapter"
  | "numeric-precision"
  | "network-config"
  | "error-handling"
  | "telemetry-plugins"
  | "webhook-security"
  | "subpath-exports";

export interface BreakingChangeDescriptor {
  id: string;
  fromVersion: string;
  toVersion: string;
  category: BreakingChangeCategory;
  title: string;
  summary: string;
  impact: "high" | "medium" | "low";
  beforeCode: string;
  afterCode: string;
  detectionPattern?: RegExp;
}

export interface MigrationStepDescriptor {
  id: string;
  order: number;
  pathId: "v0-to-v1" | "v1-to-v2";
  title: string;
  description: string;
  breakingChangeIds: string[];
  beforeExample: string;
  afterExample: string;
  verificationCommand: string;
}

export interface TroubleshootingEntry {
  id: string;
  symptom: string;
  errorCodeOrMessage: string;
  affectedVersions: string;
  rootCause: string;
  resolutionSteps: string[];
  fixSnippet: string;
}

export interface MigrationValidationInput {
  targetVersion?: string;
  config?: Record<string, unknown>;
  invoicePayload?: Record<string, unknown>;
  codeSnippet?: string;
}

export interface MigrationValidationIssue {
  id: string;
  severity: "error" | "warning";
  breakingChangeId: string;
  fieldOrPattern: string;
  message: string;
  remediation: string;
}

export interface MigrationValidationResult {
  valid: boolean;
  targetVersion: string;
  score: number;
  issues: MigrationValidationIssue[];
  warnings: MigrationValidationIssue[];
}

export type MigrationStepStatus =
  | "pending"
  | "in_progress"
  | "completed"
  | "skipped"
  | "blocked";

export interface MigrationStepProgress {
  stepId: string;
  title: string;
  order: number;
  status: MigrationStepStatus;
  startedAt?: number;
  completedAt?: number;
  notes?: string;
  blockerReason?: string;
}

export interface MigrationProgressSummary {
  pathId: MigrationPathId;
  fromVersion: string;
  toVersion: string;
  totalSteps: number;
  completedSteps: number;
  inProgressSteps: number;
  pendingSteps: number;
  skippedSteps: number;
  blockedSteps: number;
  percentComplete: number;
  isComplete: boolean;
  nextStep?: MigrationStepProgress;
  steps: MigrationStepProgress[];
}

export const BREAKING_CHANGES: readonly BreakingChangeDescriptor[] = [
  {
    id: "BC-101",
    fromVersion: "0.9.0",
    toVersion: "1.0.0",
    category: "client-initialization",
    title: "Replaced `createLegacySplitClient` with `StellarSplitClient` class",
    summary:
      "In v1.0.0, factory helpers `createLegacySplitClient` and `legacyClient` were replaced by the unified `StellarSplitClient` class constructor.",
    impact: "high",
    beforeCode: `import { legacyClient } from "@stellar-split/sdk";\nconst client = legacyClient("https://soroban-testnet.stellar.org");`,
    afterCode: `import { StellarSplitClient, NetworkEnvironment, getNetworkPreset } from "@stellar-split/sdk";\nconst client = new StellarSplitClient({\n  ...getNetworkPreset(NetworkEnvironment.TESTNET),\n  contractId: "CCONTRACT...",\n});`,
    detectionPattern: /\b(legacyClient|createLegacySplitClient)\b/,
  },
  {
    id: "BC-102",
    fromVersion: "0.9.0",
    toVersion: "1.0.0",
    category: "error-handling",
    title: "Structured `StellarSplitError` hierarchy replaces generic `Error`",
    summary:
      "All SDK errors now extend `StellarSplitError` with machine-readable `code` properties and type-guard helpers (`isInvoiceNotFoundError`, `isDeadlinePassedError`).",
    impact: "medium",
    beforeCode: `try {\n  await client.pay(params);\n} catch (err: any) {\n  if (err.message.includes("not found")) { /* ... */ }\n}`,
    afterCode: `import { isInvoiceNotFoundError } from "@stellar-split/sdk";\ntry {\n  await client.pay(params);\n} catch (err) {\n  if (isInvoiceNotFoundError(err)) { /* ... */ }\n}`,
    detectionPattern: /err\.message\.includes\(["']not found["']\)/,
  },
  {
    id: "BC-201",
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    category: "wallet-adapter",
    title: "Unified `WalletAdapter` and `Signer` Interface",
    summary:
      "In v1.x, each wallet connector used a proprietary method (`requestAccess()`, `enable()`). In v2.0.0, all connectors implement `WalletAdapter.connect()` and `Signer.signTransaction()`.",
    impact: "high",
    beforeCode: `import { FreighterConnector } from "split-sdk";\nconst wallet = new FreighterConnector();\nawait wallet.requestAccess();`,
    afterCode: `import { FreighterAdapter } from "@stellar-split/sdk";\nconst wallet = new FreighterAdapter();\nconst address = await wallet.connect();`,
    detectionPattern: /\b(FreighterConnector|requestAccess)\s*\(/,
  },
  {
    id: "BC-202",
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    category: "numeric-precision",
    title: "Strict `bigint` Requirement for Stroop & Token Amounts",
    summary:
      "All stroop/amount fields (`amount`, `totalAmount`, `feeCeiling`) moved from `number` to `bigint` in v2.0.0 to eliminate IEEE-754 floating-point precision loss.",
    impact: "high",
    beforeCode: `await client.createInvoice({\n  amount: 1000000,\n  recipients: [{ address: "G...", shareBps: 10000 }],\n});`,
    afterCode: `import { parseAmount } from "@stellar-split/sdk/utils";\nawait client.createInvoice({\n  amount: parseAmount("0.1"), // 1000000n\n  recipients: [{ address: "G...", shareBps: 10000 }],\n});`,
    detectionPattern: /\b(amount|totalAmount)\s*:\s*\d+(?!n)\b/,
  },
  {
    id: "BC-203",
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    category: "network-config",
    title: "Explicit `NetworkEnvironment` Presets and Passphrase Enforcement",
    summary:
      "v2.0.0 requires a complete `NetworkPreset` (`horizonUrl`, `rpcUrl`, `networkPassphrase`) or a built-in `NetworkEnvironment` preset instead of an implicit testnet fallback.",
    impact: "medium",
    beforeCode: `const client = new StellarSplitClient({ contractId: "C..." });`,
    afterCode: `import { StellarSplitClient, NetworkEnvironment, getNetworkPreset } from "@stellar-split/sdk";\nconst client = new StellarSplitClient({\n  ...getNetworkPreset(NetworkEnvironment.TESTNET),\n  contractId: "C...",\n});`,
  },
  {
    id: "BC-204",
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    category: "telemetry-plugins",
    title: "Migrated Inline `onLog` Callback to `PluginRegistry` & `TelemetryHooks`",
    summary:
      "The deprecated `onLog` client option was replaced by `client.use(LoggingPlugin)` and structured `telemetryHooks` (`onCallStart`, `onCallEnd`, `onError`, `onProfile`).",
    impact: "medium",
    beforeCode: `const client = new StellarSplitClient({\n  contractId: "C...",\n  onLog: (msg) => console.log(msg),\n});`,
    afterCode: `import { StellarSplitClient, LoggingPlugin } from "@stellar-split/sdk";\nconst client = new StellarSplitClient({\n  contractId: "C...",\n  telemetryHooks: {\n    onCallEnd: ({ method, durationMs }) => console.log(method, durationMs),\n  },\n});\nclient.use(LoggingPlugin);`,
    detectionPattern: /\bonLog\s*:/,
  },
  {
    id: "BC-205",
    fromVersion: "1.0.0",
    toVersion: "2.0.0",
    category: "subpath-exports",
    title: "Scoped Package Name `@stellar-split/sdk` & Explicit Subpath Exports",
    summary:
      "Deep imports into `dist/` or `src/` are blocked by package `exports`. Consumers must import from `@stellar-split/sdk` or official subpaths (`/ui`, `/react`, `/testing`, `/mock`, `/telemetry`, `/utils`, `/lazy`).",
    impact: "medium",
    beforeCode: `import { parseAmount } from "split-sdk/dist/utils";`,
    afterCode: `import { parseAmount } from "@stellar-split/sdk/utils";`,
    detectionPattern: /from\s+["'](?:@stellar-split\/sdk|split-sdk)\/(?:dist|src)\//,
  },
];

export const MIGRATION_STEPS: readonly MigrationStepDescriptor[] = [
  {
    id: "step-v1-1-client",
    order: 1,
    pathId: "v0-to-v1",
    title: "Replace legacy factory functions with `StellarSplitClient`",
    description:
      "Update package imports from `legacyClient` / `createLegacySplitClient` to instantiate `new StellarSplitClient(config)` with explicit contract and network configuration.",
    breakingChangeIds: ["BC-101"],
    beforeExample: `import { legacyClient } from "@stellar-split/sdk";\nconst sdk = legacyClient("https://soroban-testnet.stellar.org");`,
    afterExample: `import { StellarSplitClient, NetworkEnvironment, getNetworkPreset } from "@stellar-split/sdk";\nconst sdk = new StellarSplitClient({\n  ...getNetworkPreset(NetworkEnvironment.TESTNET),\n  contractId: process.env.STELLAR_SPLIT_CONTRACT_ID!,\n});`,
    verificationCommand: "npx tsc --noEmit",
  },
  {
    id: "step-v1-2-errors",
    order: 2,
    pathId: "v0-to-v1",
    title: "Adopt typed `StellarSplitError` subclasses and type guards",
    description:
      "Replace fragile string matching on `error.message` with `StellarSplitError` `code` checks or built-in type guards (`isInvoiceNotFoundError`, `isDeadlinePassedError`).",
    breakingChangeIds: ["BC-102"],
    beforeExample: `catch (e: any) { if (e.message.includes("expired")) handleExpired(); }`,
    afterExample: `import { isDeadlinePassedError } from "@stellar-split/sdk";\ncatch (e) { if (isDeadlinePassedError(e)) handleExpired(); }`,
    verificationCommand: "npm test",
  },
  {
    id: "step-v2-1-imports",
    order: 1,
    pathId: "v1-to-v2",
    title: "Update package imports to `@stellar-split/sdk` subpath exports",
    description:
      "Replace `split-sdk` or internal `/dist/*` deep imports with `@stellar-split/sdk` and its documented subpaths (`/utils`, `/ui`, `/react`, `/testing`, `/mock`, `/telemetry`, `/lazy`).",
    breakingChangeIds: ["BC-205"],
    beforeExample: `import { parseAmount } from "split-sdk/dist/utils";`,
    afterExample: `import { parseAmount } from "@stellar-split/sdk/utils";`,
    verificationCommand: "npx tsc --noEmit",
  },
  {
    id: "step-v2-2-network",
    order: 2,
    pathId: "v1-to-v2",
    title: "Configure explicit `NetworkEnvironment` presets",
    description:
      "Supply `horizonUrl`, `rpcUrl`, and `networkPassphrase` via `getNetworkPreset(NetworkEnvironment.TESTNET | MAINNET | FUTURENET)` when constructing `StellarSplitClient`.",
    breakingChangeIds: ["BC-203"],
    beforeExample: `const client = new StellarSplitClient({ contractId });`,
    afterExample: `const client = new StellarSplitClient({\n  ...getNetworkPreset(NetworkEnvironment.TESTNET),\n  contractId,\n});`,
    verificationCommand: "npx vitest run test/network-environment.test.ts",
  },
  {
    id: "step-v2-3-wallets",
    order: 3,
    pathId: "v1-to-v2",
    title: "Migrate wallet connectors to unified `WalletAdapter` interface",
    description:
      "Replace `FreighterConnector.requestAccess()` and wallet-specific calls with `FreighterAdapter.connect()` and the common `Signer` interface.",
    breakingChangeIds: ["BC-201"],
    beforeExample: `const wallet = new FreighterConnector();\nawait wallet.requestAccess();`,
    afterExample: `const wallet = new FreighterAdapter();\nconst publicKey = await wallet.connect();`,
    verificationCommand: "npx vitest run test/freighterAdapter.test.ts",
  },
  {
    id: "step-v2-4-bigint",
    order: 4,
    pathId: "v1-to-v2",
    title: "Convert numerical stroop amounts to `bigint`",
    description:
      "Convert all `number` token amounts in `createInvoice`, `pay`, and fee configurations to `bigint` literals (`1000000n`) or `parseAmount(\"0.1\")`.",
    breakingChangeIds: ["BC-202"],
    beforeExample: `await client.createInvoice({ amount: 1000000 });`,
    afterExample: `await client.createInvoice({ amount: 1000000n });`,
    verificationCommand: "npx vitest run test/parseAmount.test.ts",
  },
  {
    id: "step-v2-5-telemetry",
    order: 5,
    pathId: "v1-to-v2",
    title: "Migrate `onLog` callbacks to `PluginRegistry` and `TelemetryHooks`",
    description:
      "Register `LoggingPlugin` / `MetricsPlugin` via `client.use()` and move APM instrumentation to `telemetryHooks`.",
    breakingChangeIds: ["BC-204"],
    beforeExample: `new StellarSplitClient({ contractId, onLog: console.log });`,
    afterExample: `const client = new StellarSplitClient({ contractId, ...getNetworkPreset(NetworkEnvironment.TESTNET), telemetryHooks: { onCallEnd: console.debug } });\nclient.use(LoggingPlugin);`,
    verificationCommand: "npx vitest run test/telemetryHooks.test.ts test/plugin.test.ts",
  },
];

export const TROUBLESHOOTING_CATALOG: readonly TroubleshootingEntry[] = [
  {
    id: "TS-001",
    symptom: "TypeError: Cannot mix BigInt and other types, use explicit conversions",
    errorCodeOrMessage: "Cannot mix BigInt and other types",
    affectedVersions: ">=2.0.0",
    rootCause:
      "Invoice `amount`, `paidAmount`, and `fee` values are returned as `bigint` in v2.x, whereas application code is performing arithmetic with JS `number`.",
    resolutionSteps: [
      "Use `parseAmount(displayString)` from `@stellar-split/sdk/utils` when converting user input to stroops.",
      "Use `formatAmount(stroopBigInt)` when rendering amounts in the UI.",
      "Perform all basis-point math using `bigint` literals (e.g., `(amount * 250n) / 10000n`).",
    ],
    fixSnippet: `import { parseAmount, formatAmount } from "@stellar-split/sdk/utils";\nconst raw = parseAmount("25.50"); // 255000000n\nconst fee = (raw * 100n) / 10000n;\nconst label = formatAmount(raw - fee);`,
  },
  {
    id: "TS-002",
    symptom: "Property 'requestAccess' does not exist on type 'FreighterAdapter'",
    errorCodeOrMessage: "requestAccess is not a function",
    affectedVersions: ">=2.0.0",
    rootCause:
      "Wallet connectors were unified under the `WalletAdapter` contract in v2.0.0.",
    resolutionSteps: [
      "Replace `FreighterConnector` with `FreighterAdapter`.",
      "Call `await wallet.connect()` instead of `await wallet.requestAccess()`.",
    ],
    fixSnippet: `const wallet = new FreighterAdapter();\nconst publicKey = await wallet.connect();`,
  },
  {
    id: "TS-003",
    symptom: "UnknownNetworkError thrown during client initialization or network switch",
    errorCodeOrMessage: "UnknownNetworkError",
    affectedVersions: ">=1.1.0",
    rootCause:
      "An invalid network environment string or incomplete custom `NetworkPreset` (missing `horizonUrl`, `rpcUrl`, or `networkPassphrase`) was passed.",
    resolutionSteps: [
      "Use `getNetworkPreset(NetworkEnvironment.TESTNET)` or `NetworkEnvironment.MAINNET` for standard networks.",
      "When using `NetworkEnvironment.CUSTOM`, provide all three fields (`horizonUrl`, `rpcUrl`, `networkPassphrase`) and verify with `isNetworkPreset(preset)`.",
    ],
    fixSnippet: `import { NetworkEnvironment, getNetworkPreset } from "@stellar-split/sdk";\nconst preset = getNetworkPreset(NetworkEnvironment.TESTNET);`,
  },
  {
    id: "TS-004",
    symptom: "ERR_PACKAGE_PATH_NOT_EXPORTED when importing internal SDK modules",
    errorCodeOrMessage: "ERR_PACKAGE_PATH_NOT_EXPORTED",
    affectedVersions: ">=2.0.0",
    rootCause:
      "`package.json` enforces strict `exports` subpaths and blocks deep imports into `/dist/*` or `/src/*`.",
    resolutionSteps: [
      "Import core symbols from `@stellar-split/sdk`.",
      "Import utilities from `@stellar-split/sdk/utils`, React hooks from `@stellar-split/sdk/react`, and mocks from `@stellar-split/sdk/mock`.",
    ],
    fixSnippet: `import { StellarSplitClient } from "@stellar-split/sdk";\nimport { parseAmount } from "@stellar-split/sdk/utils";`,
  },
];

/**
 * Returns breaking changes applicable when upgrading between `fromVersion` and `toVersion`.
 */
export function getBreakingChangesForUpgrade(
  fromVersion: string,
  toVersion: string,
): BreakingChangeDescriptor[] {
  parseVersion(fromVersion);
  parseVersion(toVersion);
  return BREAKING_CHANGES.filter(
    (bc) =>
      compareVersions(bc.fromVersion, fromVersion) >= 0 &&
      compareVersions(bc.toVersion, toVersion) <= 0,
  );
}

/**
 * Looks up troubleshooting guidance matching an error message, code, or symptom keyword.
 */
export function findTroubleshootingGuide(query: string): TroubleshootingEntry[] {
  const q = query.trim().toLowerCase();
  if (!q) return [...TROUBLESHOOTING_CATALOG];
  return TROUBLESHOOTING_CATALOG.filter(
    (entry) =>
      entry.id.toLowerCase() === q ||
      entry.symptom.toLowerCase().includes(q) ||
      entry.errorCodeOrMessage.toLowerCase().includes(q) ||
      entry.rootCause.toLowerCase().includes(q),
  );
}

/**
 * Validates consumer configuration, invoice payloads, and/or code snippets
 * against the target SDK version's migration requirements.
 */
export function validateSdkMigration(
  input: MigrationValidationInput,
): MigrationValidationResult {
  const targetVersion = input.targetVersion ?? "2.0.0";
  parseVersion(targetVersion);

  const issues: MigrationValidationIssue[] = [];
  const warnings: MigrationValidationIssue[] = [];

  if (input.config) {
    const cfg = input.config;
    if ("onLog" in cfg) {
      issues.push({
        id: "VAL-CFG-ONLOG",
        severity: "error",
        breakingChangeId: "BC-204",
        fieldOrPattern: "config.onLog",
        message: "`config.onLog` was removed in v2.0.0. Use `client.use(LoggingPlugin)` or `config.telemetryHooks`.",
        remediation: "Replace `onLog` with `telemetryHooks: { onCallEnd, onError }` or `client.use(LoggingPlugin)`.",
      });
    }

    if (!cfg.contractId || typeof cfg.contractId !== "string") {
      issues.push({
        id: "VAL-CFG-CONTRACT",
        severity: "error",
        breakingChangeId: "BC-101",
        fieldOrPattern: "config.contractId",
        message: "`config.contractId` is required by `StellarSplitClient`.",
        remediation: "Provide a valid Soroban contract address in `config.contractId`.",
      });
    }

    const hasPresetFields =
      typeof cfg.rpcUrl === "string" &&
      typeof cfg.horizonUrl === "string" &&
      typeof cfg.networkPassphrase === "string";
    if (!hasPresetFields && !cfg.network) {
      warnings.push({
        id: "VAL-CFG-NETWORK",
        severity: "warning",
        breakingChangeId: "BC-203",
        fieldOrPattern: "config.rpcUrl / config.networkPassphrase",
        message:
          "Incomplete network configuration; spread `getNetworkPreset(NetworkEnvironment.TESTNET)` into client config.",
        remediation:
          "Spread `...getNetworkPreset(NetworkEnvironment.TESTNET)` into `new StellarSplitClient({ ... })`.",
      });
    }
  }

  if (input.invoicePayload) {
    const payload = input.invoicePayload;
    for (const amountField of ["amount", "totalAmount", "feeCeiling"] as const) {
      if (amountField in payload && typeof payload[amountField] === "number") {
        issues.push({
          id: `VAL-PAYLOAD-${amountField.toUpperCase()}`,
          severity: "error",
          breakingChangeId: "BC-202",
          fieldOrPattern: `invoicePayload.${amountField}`,
          message: `Field \`${amountField}\` must be a \`bigint\` in v2.0.0, received \`number\` (${String(payload[amountField])}).`,
          remediation: `Use \`BigInt(${String(payload[amountField])})\` or \`parseAmount()\` from \`@stellar-split/sdk/utils\`.`,
        });
      }
    }
  }

  if (input.codeSnippet) {
    for (const bc of BREAKING_CHANGES) {
      if (bc.detectionPattern && bc.detectionPattern.test(input.codeSnippet)) {
        issues.push({
          id: `VAL-CODE-${bc.id}`,
          severity: "error",
          breakingChangeId: bc.id,
          fieldOrPattern: bc.title,
          message: bc.summary,
          remediation: bc.afterCode,
        });
      }
    }
  }

  const deduction = issues.length * 25 + warnings.length * 10;
  const score = Math.max(0, 100 - deduction);

  return {
    valid: issues.length === 0,
    targetVersion,
    score,
    issues,
    warnings,
  };
}

/**
 * Tracks step-by-step migration execution, blockers, and completion percentage.
 */
export class MigrationProgressTracker {
  private readonly pathId: MigrationPathId;
  private readonly fromVersion: string;
  private readonly toVersion: string;
  private readonly steps: Map<string, MigrationStepProgress> = new Map();

  constructor(pathId: MigrationPathId = "v1-to-v2") {
    this.pathId = pathId;
    if (pathId === "v0-to-v1") {
      this.fromVersion = "0.9.0";
      this.toVersion = "1.0.0";
    } else if (pathId === "v1-to-v2") {
      this.fromVersion = "1.0.0";
      this.toVersion = "2.0.0";
    } else {
      this.fromVersion = "0.9.0";
      this.toVersion = "2.0.0";
    }

    const applicableSteps = MIGRATION_STEPS.filter((s) =>
      pathId === "v0-to-v2" ? true : s.pathId === pathId,
    );

    applicableSteps.forEach((step, idx) => {
      this.steps.set(step.id, {
        stepId: step.id,
        title: step.title,
        order: idx + 1,
        status: "pending",
      });
    });
  }

  startStep(stepId: string): MigrationStepProgress {
    const step = this.getStepOrThrow(stepId);
    step.status = "in_progress";
    step.startedAt = Date.now();
    step.blockerReason = undefined;
    return { ...step };
  }

  completeStep(stepId: string, notes?: string): MigrationStepProgress {
    const step = this.getStepOrThrow(stepId);
    if (!step.startedAt) step.startedAt = Date.now();
    step.status = "completed";
    step.completedAt = Date.now();
    step.blockerReason = undefined;
    if (notes !== undefined) step.notes = notes;
    return { ...step };
  }

  skipStep(stepId: string, notes: string): MigrationStepProgress {
    const step = this.getStepOrThrow(stepId);
    step.status = "skipped";
    step.completedAt = Date.now();
    step.notes = notes;
    return { ...step };
  }

  blockStep(stepId: string, blockerReason: string): MigrationStepProgress {
    const step = this.getStepOrThrow(stepId);
    step.status = "blocked";
    step.blockerReason = blockerReason;
    return { ...step };
  }

  validateAndCompleteStep(
    stepId: string,
    input: MigrationValidationInput,
  ): { step: MigrationStepProgress; validation: MigrationValidationResult } {
    this.startStep(stepId);
    const validation = validateSdkMigration(input);
    if (validation.valid) {
      const completed = this.completeStep(
        stepId,
        `Validated cleanly (score=${validation.score})`,
      );
      return { step: completed, validation };
    }
    const blocked = this.blockStep(
      stepId,
      validation.issues.map((i) => i.message).join("; "),
    );
    return { step: blocked, validation };
  }

  getSummary(): MigrationProgressSummary {
    const allSteps = Array.from(this.steps.values()).sort((a, b) => a.order - b.order);
    const totalSteps = allSteps.length;
    const completedSteps = allSteps.filter((s) => s.status === "completed").length;
    const skippedSteps = allSteps.filter((s) => s.status === "skipped").length;
    const inProgressSteps = allSteps.filter((s) => s.status === "in_progress").length;
    const blockedSteps = allSteps.filter((s) => s.status === "blocked").length;
    const pendingSteps = allSteps.filter((s) => s.status === "pending").length;

    const doneCount = completedSteps + skippedSteps;
    const percentComplete =
      totalSteps === 0 ? 100 : Math.round((doneCount / totalSteps) * 100);
    const nextStep = allSteps.find(
      (s) => s.status === "in_progress" || s.status === "pending" || s.status === "blocked",
    );

    return {
      pathId: this.pathId,
      fromVersion: this.fromVersion,
      toVersion: this.toVersion,
      totalSteps,
      completedSteps,
      inProgressSteps,
      pendingSteps,
      skippedSteps,
      blockedSteps,
      percentComplete,
      isComplete: doneCount === totalSteps && totalSteps > 0,
      nextStep: nextStep ? { ...nextStep } : undefined,
      steps: allSteps.map((s) => ({ ...s })),
    };
  }

  toJSON(): string {
    return JSON.stringify(this.getSummary(), null, 2);
  }

  static fromJSON(serialized: string): MigrationProgressTracker {
    const parsed = JSON.parse(serialized) as MigrationProgressSummary;
    const tracker = new MigrationProgressTracker(parsed.pathId);
    for (const saved of parsed.steps) {
      const target = tracker.steps.get(saved.stepId);
      if (target) {
        target.status = saved.status;
        target.startedAt = saved.startedAt;
        target.completedAt = saved.completedAt;
        target.notes = saved.notes;
        target.blockerReason = saved.blockerReason;
      }
    }
    return tracker;
  }

  private getStepOrThrow(stepId: string): MigrationStepProgress {
    const step = this.steps.get(stepId);
    if (!step) {
      throw new Error(`Unknown migration step ID: ${stepId}`);
    }
    return step;
  }
}
