/**
 * TransactionSimulator — Pre-execution transaction simulation and error detection.
 *
 * Simulates Stellar and Soroban transactions prior to network submission to detect
 * errors early, inspect resource consumption (CPU instructions, memory, fees),
 * detect contract panics / authorization failures, and produce actionable reports.
 */

import { StellarSplitError } from "./errors.js";

// ---------------------------------------------------------------------------
// Structs & Interfaces
// ---------------------------------------------------------------------------

export type SimulationStatus = "success" | "failed" | "error";

export type SimulationErrorCode =
  | "AUTH_FAILED"
  | "INSUFFICIENT_FUNDS"
  | "RESOURCE_EXHAUSTED"
  | "CONTRACT_ERROR"
  | "SEQUENCE_ERROR"
  | "STORAGE_ERROR"
  | "DEADLINE_EXPIRED"
  | "INVALID_TRANSACTION"
  | "UNKNOWN_ERROR";

export interface SimulationErrorDetail {
  code: SimulationErrorCode;
  message: string;
  phase: "preflight" | "execution" | "validation";
  suggestion?: string;
  raw?: unknown;
}

export interface SimulationResourceUsage {
  cpuInstructions: bigint;
  memoryBytes: bigint;
  minResourceFee: bigint;
  readBytes?: bigint;
  writeBytes?: bigint;
}

export interface SimulationEvent {
  topic: string[];
  data: unknown;
}

export interface SimulationRequest {
  /** Base64-encoded transaction XDR or identifier. */
  txXdr: string;
  /** Optional transaction identifier. */
  id?: string;
  /** Network passphrase (e.g. Public Global Stellar Network, Testnet). */
  networkPassphrase?: string;
  /** Source / fee-payer account address. */
  sourceAccount?: string;
  /** Optional metadata associated with the request. */
  metadata?: Record<string, unknown>;
}

export interface SimulationReport {
  /** Unique simulation report identifier. */
  simulationId: string;
  /** Timestamp when simulation was executed. */
  timestamp: number;
  /** Overall simulation status. */
  status: SimulationStatus;
  /** Execution / simulation latency in milliseconds. */
  executionTimeMs: number;
  /** Resource consumption details. */
  resourceUsage: SimulationResourceUsage;
  /** Structured errors detected during simulation. */
  errors: SimulationErrorDetail[];
  /** Warnings (e.g. high resource usage, near limits). */
  warnings: string[];
  /** Diagnostic events emitted during simulation. */
  events: SimulationEvent[];
  /** Actionable recommendations for resolving detected issues. */
  recommendations: string[];
  /** Human-readable executive summary. */
  summary: string;
  /** Raw simulation payload from RPC or backend. */
  rawResponse?: unknown;
}

export interface TransactionSimulatorOptions {
  /**
   * Custom RPC simulator hook or Soroban RPC server instance.
   * Receives `txXdr` and returns the simulation response.
   */
  simulateFn?: (txXdr: string) => Promise<unknown>;
  /** Whether to cache simulation results for identical transaction XDRs. Defaults to true. */
  enableCache?: boolean;
  /** Cache time-to-live in milliseconds. Defaults to 30_000 ms. */
  cacheTtlMs?: number;
  /** CPU instructions threshold above which a warning is issued (default: 80,000,000n). */
  cpuInstructionWarningThreshold?: bigint;
  /** Memory bytes threshold above which a warning is issued (default: 20,000,000n). */
  memoryByteWarningThreshold?: bigint;
}

/**
 * Options for the unified `simulateTransaction` entry point.
 */
export interface SimulateTransactionOptions {
  /** Optional transaction identifier. */
  id?: string;
  /** Network passphrase. */
  networkPassphrase?: string;
  /** Source / fee-payer account address. */
  sourceAccount?: string;
  /** Optional metadata associated with the request. */
  metadata?: Record<string, unknown>;
  /** Optional baseline report to diff the new simulation against. */
  baseline?: SimulationReport | SimulationPreview;
  /** Optional custom RPC simulator hook overriding the instance default. */
  simulateFn?: (txXdr: string) => Promise<unknown>;
  /** Whether to bypass the cache for this call. Defaults to false. */
  skipCache?: boolean;
}

/**
 * A predicted error with a stable code and actionable suggestion.
 */
export interface PredictedError {
  code: SimulationErrorCode;
  message: string;
  phase: "preflight" | "execution" | "validation";
  suggestion?: string;
}

/**
 * Difference between two simulation previews / reports.
 */
export interface SimulationDiff {
  /** True when the two simulations are considered equivalent. */
  identical: boolean;
  statusChanged: boolean;
  previousStatus?: SimulationStatus;
  currentStatus: SimulationStatus;
  /** Resource deltas (current - previous). */
  cpuInstructionsDelta: bigint;
  memoryBytesDelta: bigint;
  minResourceFeeDelta: bigint;
  /** Error codes present in current but not previous. */
  newErrorCodes: SimulationErrorCode[];
  /** Error codes present in previous but not current. */
  resolvedErrorCodes: SimulationErrorCode[];
  /** Human-readable summary of the diff. */
  summary: string;
}

/**
 * Result preview returned by `simulateTransaction`.
 */
export interface SimulationPreview {
  simulationId: string;
  timestamp: number;
  status: SimulationStatus;
  executionTimeMs: number;
  resourceUsage: SimulationResourceUsage;
  events: SimulationEvent[];
  warnings: string[];
  /** Predicted errors with codes and suggestions. */
  predictedErrors: PredictedError[];
  recommendations: string[];
  summary: string;
  /** Diff against the optional baseline, if provided. */
  diff?: SimulationDiff;
  /** Full underlying report for advanced consumers. */
  report: SimulationReport;
}

/**
 * Aggregated simulation statistics.
 */
export interface SimulationStats {
  totalSimulations: number;
  successCount: number;
  failedCount: number;
  errorCount: number;
  averageLatencyMs: number;
  /** Histogram of detected error codes across all simulations. */
  errorCodeHistogram: Record<string, number>;
}

/**
 * Side-effect-free execution sandbox for simulation.
 *
 * The sandbox never submits transactions or mutates inputs; it only invokes the
 * provided simulation hook (or the default in-memory evaluator) and returns the
 * raw response for parsing.
 */
export class SimulationSandbox {
  private readonly simulateFn?: (txXdr: string) => Promise<unknown>;

  constructor(simulateFn?: (txXdr: string) => Promise<unknown>) {
    this.simulateFn = simulateFn;
  }

  /**
   * Execute a simulation in an isolated, side-effect-free manner.
   * The input XDR string is treated as immutable.
   */
  async execute(txXdr: string): Promise<unknown> {
    if (this.simulateFn) {
      return this.simulateFn(txXdr);
    }
    return defaultSimulate(txXdr);
  }
}

/**
 * Compute the difference between a baseline and a current simulation.
 */
export function diffSimulations(
  baseline: SimulationReport | SimulationPreview,
  current: SimulationReport | SimulationPreview
): SimulationDiff {
  const prevReport = "report" in baseline ? baseline.report : baseline;
  const currReport = "report" in current ? current.report : current;

  const prevCodes = new Set(prevReport.errors.map((e) => e.code));
  const currCodes = new Set(currReport.errors.map((e) => e.code));

  const newErrorCodes = [...currCodes].filter((c) => !prevCodes.has(c));
  const resolvedErrorCodes = [...prevCodes].filter((c) => !currCodes.has(c));

  const cpuInstructionsDelta =
    currReport.resourceUsage.cpuInstructions - prevReport.resourceUsage.cpuInstructions;
  const memoryBytesDelta = currReport.resourceUsage.memoryBytes - prevReport.resourceUsage.memoryBytes;
  const minResourceFeeDelta =
    currReport.resourceUsage.minResourceFee - prevReport.resourceUsage.minResourceFee;

  const statusChanged = prevReport.status !== currReport.status;
  const identical =
    !statusChanged &&
    newErrorCodes.length === 0 &&
    resolvedErrorCodes.length === 0 &&
    cpuInstructionsDelta === 0n &&
    memoryBytesDelta === 0n &&
    minResourceFeeDelta === 0n;

  const parts: string[] = [];
  if (statusChanged) parts.push(`status ${prevReport.status} -> ${currReport.status}`);
  if (newErrorCodes.length > 0) parts.push(`new errors: ${newErrorCodes.join(", ")}`);
  if (resolvedErrorCodes.length > 0) parts.push(`resolved errors: ${resolvedErrorCodes.join(", ")}`);
  if (cpuInstructionsDelta !== 0n) parts.push(`cpu ${cpuInstructionsDelta > 0n ? "+" : ""}${cpuInstructionsDelta}`);
  if (memoryBytesDelta !== 0n) parts.push(`memory ${memoryBytesDelta > 0n ? "+" : ""}${memoryBytesDelta}`);
  if (minResourceFeeDelta !== 0n) parts.push(`fee ${minResourceFeeDelta > 0n ? "+" : ""}${minResourceFeeDelta}`);

  return {
    identical,
    statusChanged,
    previousStatus: prevReport.status,
    currentStatus: currReport.status,
    cpuInstructionsDelta,
    memoryBytesDelta,
    minResourceFeeDelta,
    newErrorCodes,
    resolvedErrorCodes,
    summary: identical ? "No differences detected." : parts.join("; "),
  };
}

function defaultSimulate(txXdr: string): unknown {
  // If string is obviously malformed or contains trigger markers
  if (txXdr.includes("fail_auth")) {
    return { error: "HostError: Error(Auth, require_auth failed)" };
  }
  if (txXdr.includes("fail_balance")) {
    return { error: "tx_insufficient_balance: account lacks required funds" };
  }
  if (txXdr.includes("fail_budget")) {
    return { error: "HostError: Error(Budget, CPU limit exceeded)" };
  }
  if (txXdr.includes("fail_sequence")) {
    return { error: "tx_bad_seq: sequence number too old" };
  }
  if (txXdr.includes("fail_contract")) {
    return { error: "HostError: Error(Contract, #123)" };
  }

  // Default successful simulation stub
  return {
    minResourceFee: "150",
    cost: {
      cpuInsns: "125000",
      memBytes: "45000",
    },
    events: [{ topic: ["transfer"], data: { amount: 1000n } }],
  };
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class TransactionSimulationError extends StellarSplitError {
  readonly report: SimulationReport;

  constructor(message: string, report: SimulationReport) {
    super(message, "TRANSACTION_SIMULATION_FAILED", {
      simulationId: report.simulationId,
      errors: report.errors,
      status: report.status,
    });
    this.name = "TransactionSimulationError";
    this.report = report;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// TransactionSimulator Implementation
// ---------------------------------------------------------------------------

export class TransactionSimulator {
  private readonly simulateFn?: (txXdr: string) => Promise<unknown>;
  private readonly enableCache: boolean;
  private readonly cacheTtlMs: number;
  private readonly cpuWarningLimit: bigint;
  private readonly memWarningLimit: bigint;

  /** Cache of recent simulation reports keyed by txXdr */
  private readonly cache = new Map<string, { report: SimulationReport; expiresAt: number }>();

  /** Aggregated simulation statistics. */
  private stats: SimulationStats = {
    totalSimulations: 0,
    successCount: 0,
    failedCount: 0,
    errorCount: 0,
    averageLatencyMs: 0,
    errorCodeHistogram: {},
  };

  constructor(options: TransactionSimulatorOptions = {}) {
    this.simulateFn = options.simulateFn;
    this.enableCache = options.enableCache ?? true;
    this.cacheTtlMs = options.cacheTtlMs ?? 30_000;
    this.cpuWarningLimit = options.cpuInstructionWarningThreshold ?? 80_000_000n;
    this.memWarningLimit = options.memoryByteWarningThreshold ?? 20_000_000n;
  }

  /**
   * Unified transaction simulation entry point.
   *
   * Returns a `SimulationPreview` with status, resource usage, events, predicted
   * errors (with codes and suggestions), and an optional diff against a baseline.
   * Execution happens in a side-effect-free sandbox: inputs are never mutated and
   * no transaction is ever submitted.
   *
   * @param tx - Base64-encoded transaction XDR string.
   * @param options - Optional simulation options.
   */
  async simulateTransaction(
    tx: string,
    options: SimulateTransactionOptions = {}
  ): Promise<SimulationPreview> {
    const request: SimulationRequest = {
      txXdr: tx,
      id: options.id,
      networkPassphrase: options.networkPassphrase,
      sourceAccount: options.sourceAccount,
      metadata: options.metadata,
    };

    let report: SimulationReport;

    if (options.skipCache || options.simulateFn) {
      // Bypass instance cache when a per-call hook or explicit skip is requested.
      report = await this.runSimulation(request, options.simulateFn);
    } else {
      report = await this.simulate(request);
    }

    this.recordStats(report);

    const predictedErrors: PredictedError[] = report.errors.map((e) => ({
      code: e.code,
      message: e.message,
      phase: e.phase,
      suggestion: e.suggestion,
    }));

    const preview: SimulationPreview = {
      simulationId: report.simulationId,
      timestamp: report.timestamp,
      status: report.status,
      executionTimeMs: report.executionTimeMs,
      resourceUsage: { ...report.resourceUsage },
      events: report.events.map((ev) => ({ topic: [...ev.topic], data: ev.data })),
      warnings: [...report.warnings],
      predictedErrors,
      recommendations: [...report.recommendations],
      summary: report.summary,
      report,
    };

    if (options.baseline) {
      preview.diff = diffSimulations(options.baseline, preview);
    }

    return preview;
  }

  /**
   * Retrieve aggregated simulation statistics.
   */
  getSimulationStats(): SimulationStats {
    return {
      ...this.stats,
      errorCodeHistogram: { ...this.stats.errorCodeHistogram },
    };
  }

  /**
   * Reset aggregated simulation statistics.
   */
  resetSimulationStats(): void {
    this.stats = {
      totalSimulations: 0,
      successCount: 0,
      failedCount: 0,
      errorCount: 0,
      averageLatencyMs: 0,
      errorCodeHistogram: {},
    };
  }

  private async runSimulation(
    request: SimulationRequest,
    simulateFn?: (txXdr: string) => Promise<unknown>
  ): Promise<SimulationReport> {
    if (!request.txXdr || typeof request.txXdr !== "string") {
      return this.createInvalidReport("Invalid transaction: txXdr must be a non-empty string.");
    }

    const startTime = Date.now();
    const simulationId = request.id ?? `sim_${Math.random().toString(36).substring(2, 10)}`;

    try {
      const sandbox = new SimulationSandbox(simulateFn ?? this.simulateFn);
      const rawResult = await sandbox.execute(request.txXdr);
      const executionTimeMs = Date.now() - startTime;
      return this.parseSimulationResult(simulationId, rawResult, executionTimeMs);
    } catch (err) {
      const executionTimeMs = Date.now() - startTime;
      return this.createErrorReport(simulationId, err, executionTimeMs);
    }
  }

  private recordStats(report: SimulationReport): void {
    const prevTotal = this.stats.totalSimulations;
    const newTotal = prevTotal + 1;

    // Incremental average latency.
    const averageLatencyMs =
      (this.stats.averageLatencyMs * prevTotal + report.executionTimeMs) / newTotal;

    const histogram = { ...this.stats.errorCodeHistogram };
    for (const err of report.errors) {
      histogram[err.code] = (histogram[err.code] ?? 0) + 1;
    }

    this.stats = {
      totalSimulations: newTotal,
      successCount: this.stats.successCount + (report.status === "success" ? 1 : 0),
      failedCount: this.stats.failedCount + (report.status === "failed" ? 1 : 0),
      errorCount: this.stats.errorCount + (report.status === "error" ? 1 : 0),
      averageLatencyMs,
      errorCodeHistogram: histogram,
    };
  }

  /**
   * Simulate a transaction before execution.
   *
   * @param input - SimulationRequest object or raw base64 XDR string.
   * @returns Detailed SimulationReport with detected errors, resources, and recommendations.
   */
  async simulate(input: SimulationRequest | string): Promise<SimulationReport> {
    const request: SimulationRequest = typeof input === "string" ? { txXdr: input } : input;

    if (!request.txXdr || typeof request.txXdr !== "string") {
      return this.createInvalidReport("Invalid transaction: txXdr must be a non-empty string.");
    }

    // Check cache
    if (this.enableCache) {
      const cached = this.cache.get(request.txXdr);
      if (cached && cached.expiresAt > Date.now()) {
        return cached.report;
      }
    }

    const startTime = Date.now();
    const simulationId = request.id ?? `sim_${Math.random().toString(36).substring(2, 10)}`;

    try {
      let rawResult: unknown;

      if (this.simulateFn) {
        rawResult = await this.simulateFn(request.txXdr);
      } else {
        // Default in-memory simulation evaluation
        rawResult = this.defaultSimulate(request.txXdr);
      }

      const executionTimeMs = Date.now() - startTime;
      const report = this.parseSimulationResult(simulationId, rawResult, executionTimeMs);

      if (this.enableCache) {
        this.cache.set(request.txXdr, {
          report,
          expiresAt: Date.now() + this.cacheTtlMs,
        });
      }

      return report;
    } catch (err) {
      const executionTimeMs = Date.now() - startTime;
      return this.createErrorReport(simulationId, err, executionTimeMs);
    }
  }

  /**
   * Simulate multiple transactions concurrently.
   */
  async simulateBatch(inputs: Array<SimulationRequest | string>): Promise<SimulationReport[]> {
    return Promise.all(inputs.map((req) => this.simulate(req)));
  }

  /**
   * Clear the simulation cache.
   */
  clearCache(): void {
    this.cache.clear();
  }

  // -------------------------------------------------------------------------
  // Reporting & Formatting
  // -------------------------------------------------------------------------

  /**
   * Generate a formatted, human-readable report string.
   */
  formatReport(report: SimulationReport, format: "markdown" | "text" | "json" = "markdown"): string {
    if (format === "json") {
      return JSON.stringify(
        report,
        (_key, val) => (typeof val === "bigint" ? val.toString() : val),
        2
      );
    }

    const lines: string[] = [];

    if (format === "markdown") {
      lines.push(`## Transaction Simulation Report (${report.simulationId})`);
      lines.push(`- **Status**: ${report.status.toUpperCase()}`);
      lines.push(`- **Execution Latency**: ${report.executionTimeMs} ms`);
      lines.push(`- **Estimated Resource Fee**: ${report.resourceUsage.minResourceFee} stroops`);
      lines.push(`- **CPU Instructions**: ${report.resourceUsage.cpuInstructions.toLocaleString()}`);
      lines.push(`- **Memory**: ${report.resourceUsage.memoryBytes.toLocaleString()} bytes`);

      if (report.warnings.length > 0) {
        lines.push(`\n### Warnings`);
        for (const warning of report.warnings) {
          lines.push(`- ⚠️ ${warning}`);
        }
      }

      if (report.errors.length > 0) {
        lines.push(`\n### Errors Detected`);
        for (const err of report.errors) {
          lines.push(`- **[${err.code}]** (${err.phase}): ${err.message}`);
          if (err.suggestion) {
            lines.push(`  - *Suggestion*: ${err.suggestion}`);
          }
        }
      }

      if (report.recommendations.length > 0) {
        lines.push(`\n### Recommendations`);
        for (const rec of report.recommendations) {
          lines.push(`- ${rec}`);
        }
      }
    } else {
      lines.push(`TRANSACTION SIMULATION REPORT [${report.simulationId}]`);
      lines.push(`Status: ${report.status.toUpperCase()}`);
      lines.push(`Latency: ${report.executionTimeMs} ms`);
      lines.push(`Fee: ${report.resourceUsage.minResourceFee} stroops`);
      lines.push(`CPU: ${report.resourceUsage.cpuInstructions}`);
      lines.push(`Memory: ${report.resourceUsage.memoryBytes}`);

      if (report.errors.length > 0) {
        lines.push(`Errors:`);
        for (const err of report.errors) {
          lines.push(`  [${err.code}] ${err.message}`);
          if (err.suggestion) lines.push(`    Suggestion: ${err.suggestion}`);
        }
      }
    }

    return lines.join("\n");
  }

  // -------------------------------------------------------------------------
  // Error Detection & Result Parsing
  // -------------------------------------------------------------------------

  private parseSimulationResult(
    simulationId: string,
    rawResult: unknown,
    executionTimeMs: number
  ): SimulationReport {
    const errors: SimulationErrorDetail[] = [];
    const warnings: string[] = [];
    const recommendations: string[] = [];
    const events: SimulationEvent[] = [];

    let cpuInstructions = 0n;
    let memoryBytes = 0n;
    let minResourceFee = 100n;
    let readBytes: bigint | undefined;
    let writeBytes: bigint | undefined;

    if (rawResult && typeof rawResult === "object") {
      const obj = rawResult as Record<string, any>;

      // Check for explicit error field (e.g. from Soroban simulateTransaction)
      if (obj.error) {
        const detected = this.detectErrorFromMessage(String(obj.error), "execution", obj);
        errors.push(detected);
      }

      // Check for results array with errors
      if (Array.isArray(obj.results)) {
        for (const res of obj.results) {
          if (res.error) {
            errors.push(this.detectErrorFromMessage(String(res.error), "execution", res));
          }
        }
      }

      // Extract resource usage
      if (obj.minResourceFee !== undefined) {
        minResourceFee = BigInt(obj.minResourceFee);
      }
      if (obj.cost) {
        cpuInstructions = BigInt(obj.cost.cpuInsns ?? "0");
        memoryBytes = BigInt(obj.cost.memBytes ?? "0");
      } else if (obj.cpuInstructions || obj.memoryBytes) {
        cpuInstructions = BigInt(obj.cpuInstructions ?? "0");
        memoryBytes = BigInt(obj.memoryBytes ?? "0");
      }

      if (obj.readBytes !== undefined) readBytes = BigInt(obj.readBytes);
      if (obj.writeBytes !== undefined) writeBytes = BigInt(obj.writeBytes);

      // Extract events
      if (Array.isArray(obj.events)) {
        for (const ev of obj.events) {
          events.push({
            topic: Array.isArray(ev.topic) ? ev.topic.map(String) : [],
            data: ev.data ?? ev,
          });
        }
      }
    }

    // Check resource thresholds for warnings
    if (cpuInstructions > this.cpuWarningLimit) {
      warnings.push(`High CPU instruction count: ${cpuInstructions} exceeds limit of ${this.cpuWarningLimit}`);
      recommendations.push("Optimize contract logic or reduce loop iterations to avoid CPU budget exhaustion.");
    }
    if (memoryBytes > this.memWarningLimit) {
      warnings.push(`High memory usage: ${memoryBytes} bytes exceeds limit of ${this.memWarningLimit}`);
      recommendations.push("Reduce memory allocations or footprint footprint data size.");
    }

    // Compile recommendations from detected errors
    for (const err of errors) {
      if (err.suggestion && !recommendations.includes(err.suggestion)) {
        recommendations.push(err.suggestion);
      }
    }

    const status: SimulationStatus = errors.length > 0 ? "failed" : "success";
    const summary = this.generateSummary(status, errors, cpuInstructions, minResourceFee);

    return {
      simulationId,
      timestamp: Date.now(),
      status,
      executionTimeMs,
      resourceUsage: {
        cpuInstructions,
        memoryBytes,
        minResourceFee,
        readBytes,
        writeBytes,
      },
      errors,
      warnings,
      events,
      recommendations,
      summary,
      rawResponse: rawResult,
    };
  }

  /**
   * Intelligently classify simulation error messages into structured codes and actionable suggestions.
   */
  detectErrorFromMessage(
    rawMessage: string,
    phase: "preflight" | "execution" | "validation",
    rawObj?: unknown
  ): SimulationErrorDetail {
    const lower = rawMessage.toLowerCase();

    // 1. Authorization / Signature failures
    if (
      lower.includes("require_auth") ||
      lower.includes("unauthorized") ||
      lower.includes("missing signature") ||
      lower.includes("auth_failed") ||
      lower.includes("bad auth")
    ) {
      return {
        code: "AUTH_FAILED",
        message: rawMessage,
        phase,
        suggestion: "Ensure all required signers have signed the transaction envelope.",
        raw: rawObj,
      };
    }

    // 2. Insufficient Funds / Balance
    if (
      lower.includes("insufficient_balance") ||
      lower.includes("underfunded") ||
      lower.includes("not enough balance") ||
      lower.includes("tx_insufficient_fee") ||
      lower.includes("insufficient balance")
    ) {
      return {
        code: "INSUFFICIENT_FUNDS",
        message: rawMessage,
        phase,
        suggestion: "Verify that the source account has sufficient funds to cover the amount and fees.",
        raw: rawObj,
      };
    }

    // 3. Resource Exhaustion
    if (
      lower.includes("cpu limit") ||
      lower.includes("memory limit") ||
      lower.includes("budget exceeded") ||
      lower.includes("resource limit") ||
      lower.includes("exceeded instruction budget")
    ) {
      return {
        code: "RESOURCE_EXHAUSTED",
        message: rawMessage,
        phase,
        suggestion: "Contract execution exceeded Soroban CPU or memory instructions budget.",
        raw: rawObj,
      };
    }

    // 4. Sequence / Nonce error
    if (
      lower.includes("sequence") ||
      lower.includes("tx_bad_seq") ||
      lower.includes("bad sequence") ||
      lower.includes("nonce")
    ) {
      return {
        code: "SEQUENCE_ERROR",
        message: rawMessage,
        phase,
        suggestion: "Account sequence number or nonce is stale. Refresh account sequence and rebuild.",
        raw: rawObj,
      };
    }

    // 5. Storage / Footprint error
    if (
      lower.includes("footprint") ||
      lower.includes("entry expired") ||
      lower.includes("storage error") ||
      lower.includes("read-write conflict")
    ) {
      return {
        code: "STORAGE_ERROR",
        message: rawMessage,
        phase,
        suggestion: "Ensure contract storage ledger footprint includes all read-write keys.",
        raw: rawObj,
      };
    }

    // 6. Timebounds / Deadline
    if (
      lower.includes("timebound") ||
      lower.includes("expired") ||
      lower.includes("deadline") ||
      lower.includes("tx_too_late")
    ) {
      return {
        code: "DEADLINE_EXPIRED",
        message: rawMessage,
        phase,
        suggestion: "Transaction timebounds have expired. Extend timeout window and rebuild.",
        raw: rawObj,
      };
    }

    // 7. General Contract Revert / Error
    if (lower.includes("hosterror") || lower.includes("contract") || lower.includes("panic")) {
      return {
        code: "CONTRACT_ERROR",
        message: rawMessage,
        phase,
        suggestion: "Contract invocation failed or panicked. Inspect contract logic and parameters.",
        raw: rawObj,
      };
    }

    return {
      code: "UNKNOWN_ERROR",
      message: rawMessage,
      phase,
      suggestion: "Inspect raw simulation error for diagnostic details.",
      raw: rawObj,
    };
  }

  private generateSummary(
    status: SimulationStatus,
    errors: SimulationErrorDetail[],
    cpu: bigint,
    fee: bigint
  ): string {
    if (status === "success") {
      return `Simulation succeeded. Estimated fee: ${fee} stroops, CPU: ${cpu} instructions.`;
    }
    const errSummary = errors.map((e) => `[${e.code}] ${e.message}`).join("; ");
    return `Simulation failed with ${errors.length} error(s): ${errSummary}`;
  }

  private createInvalidReport(message: string): SimulationReport {
    const error: SimulationErrorDetail = {
      code: "INVALID_TRANSACTION",
      message,
      phase: "preflight",
      suggestion: "Ensure transaction XDR is a valid base64-encoded string.",
    };
    return {
      simulationId: `err_${Date.now()}`,
      timestamp: Date.now(),
      status: "error",
      executionTimeMs: 0,
      resourceUsage: {
        cpuInstructions: 0n,
        memoryBytes: 0n,
        minResourceFee: 0n,
      },
      errors: [error],
      warnings: [],
      events: [],
      recommendations: [error.suggestion!],
      summary: `Simulation aborted: ${message}`,
    };
  }

  private createErrorReport(simulationId: string, err: unknown, executionTimeMs: number): SimulationReport {
    const msg = err instanceof Error ? err.message : String(err);
    const detail = this.detectErrorFromMessage(msg, "execution", err);

    return {
      simulationId,
      timestamp: Date.now(),
      status: "error",
      executionTimeMs,
      resourceUsage: {
        cpuInstructions: 0n,
        memoryBytes: 0n,
        minResourceFee: 0n,
      },
      errors: [detail],
      warnings: [],
      events: [],
      recommendations: [detail.suggestion ?? "Check simulation backend connectivity."],
      summary: `Simulation RPC call encountered an error: ${msg}`,
    };
  }

  private defaultSimulate(txXdr: string): unknown {
    return defaultSimulate(txXdr);
  }
}
