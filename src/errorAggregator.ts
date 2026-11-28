/**
 * Error Aggregation and Diagnostics System for StellarSplit SDK.
 * Groups related errors logically, computes rates and patterns, and produces clear diagnostic reports.
 *
 * Issue #1072 — Implement error aggregation
 */

import { StellarSplitError } from "./errors.js";
import {
  type SerializedError,
  serializeError,
  getErrorContext,
} from "./errorContext.js";

/** Built-in grouping strategy types. */
export type GroupingStrategyType =
  | "code"
  | "message"
  | "fingerprint"
  | "type"
  | "component";

/** Custom grouping resolver function. */
export type CustomGroupingResolver = (
  error: unknown,
  context?: Record<string, unknown>
) => string;

/** Grouping strategy configuration: either a named preset or a custom function. */
export type ErrorGroupingStrategy = GroupingStrategyType | CustomGroupingResolver;

/** A single aggregated group of related errors. */
export interface AggregatedErrorGroup {
  /** Identifier key for the group. */
  groupKey: string;
  /** Strategy used to form this group. */
  strategy: string;
  /** Total count of errors in this group. */
  count: number;
  /** Timestamp of first occurrence (epoch ms). */
  firstSeen: number;
  /** Timestamp of most recent occurrence (epoch ms). */
  lastSeen: number;
  /** Recent sample error instances. */
  sampleErrors: SerializedError[];
  /** Unique error codes observed within this group. */
  errorCodes: string[];
  /** Unique invoice IDs affected by this error group. */
  affectedInvoices: string[];
  /** Unique Stellar account addresses affected. */
  affectedAccounts: string[];
  /** Unique operations during which this error was encountered. */
  affectedOperations: string[];
  /** Context keys and values identical across all occurrences in this group. */
  commonContext: Record<string, unknown>;
  /** Estimated rate of errors per minute over its active span. */
  ratePerMinute: number;
}

/** Pattern detected within aggregated errors. */
export interface ErrorPattern {
  /** Nature of the detected pattern. */
  type: "spike" | "high_frequency" | "recurring_entity" | "cascading_failure";
  /** Severity rating. */
  severity: "info" | "low" | "medium" | "high" | "critical";
  /** Descriptive explanation of the pattern. */
  description: string;
  /** Group key involved if group-specific. */
  groupKey?: string;
  /** Entity identifier (e.g. invoiceId or accountId) if entity-specific. */
  entityId?: string;
  /** Count or measurement associated with the pattern. */
  count: number;
  /** Additional diagnostic metrics. */
  details: Record<string, unknown>;
}

/** Options for generating aggregation reports. */
export interface ReportOptions {
  /** Filter errors on or after this timestamp. */
  since?: number;
  /** Filter errors on or before this timestamp. */
  until?: number;
  /** Minimum error count to include in report groups. */
  minCount?: number;
  /** Maximum number of groups to report. */
  limit?: number;
}

/** Comprehensive aggregation report structure. */
export interface ErrorAggregationReport {
  generatedAt: number;
  timeRange: {
    start: number;
    end: number;
    durationMs: number;
  };
  totalErrors: number;
  uniqueGroups: number;
  groups: AggregatedErrorGroup[];
  topErrors: {
    groupKey: string;
    count: number;
    percentage: number;
  }[];
  patterns: ErrorPattern[];
  summary: {
    totalRecorded: number;
    criticalPatternsCount: number;
    mostFrequentCode: string | null;
    mostAffectedInvoice: string | null;
    mostAffectedAccount: string | null;
  };
  formatAsText(): string;
  formatAsMarkdown(): string;
  toJSON(): string;
}

/** Configuration options for ErrorAggregator. */
export interface ErrorAggregatorOptions {
  /** Strategy for grouping errors. Defaults to 'fingerprint'. */
  strategy?: ErrorGroupingStrategy;
  /** Maximum number of groups to track before evicting oldest. Defaults to 500. */
  maxGroups?: number;
  /** Maximum sample errors to retain per group. Defaults to 5. */
  maxSamplesPerGroup?: number;
  /** Rolling time window in ms (e.g. 3600000 for 1h). If omitted, retains indefinitely until evicted. */
  windowMs?: number;
}

/**
 * Normalizes dynamic identifiers (Stellar addresses, hashes, UUIDs, numbers)
 * in error messages to reveal underlying message templates.
 */
export function normalizeErrorMessage(message: string): string {
  if (!message) return "<empty>";

  return message
    .replace(/\bS[A-Z0-9]{55}\b/g, "<STELLAR_SECRET>")
    .replace(/\bG[A-Z0-9]{55}\b/g, "<STELLAR_ADDRESS>")
    .replace(/\bC[A-Z0-9]{55}\b/g, "<CONTRACT_ADDRESS>")
    .replace(/0x[0-9a-fA-F]{8,}/g, "<HEX_HASH>")
    .replace(/\b[0-9a-fA-F]{64}\b/g, "<TX_HASH>")
    .replace(
      /\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b/g,
      "<UUID>"
    )
    .replace(/\binv-[a-zA-Z0-9_-]+\b/g, "<INVOICE_ID>")
    .replace(/\b\d+(\.\d+)?\b/g, "<N>")
    .trim();
}

/**
 * ErrorAggregator collects, groups, analyzes, and reports error occurrences.
 */
export class ErrorAggregator {
  private readonly strategy: ErrorGroupingStrategy;
  private readonly maxGroups: number;
  private readonly maxSamplesPerGroup: number;
  private readonly windowMs?: number;

  private groups = new Map<
    string,
    {
      groupKey: string;
      strategyName: string;
      count: number;
      firstSeen: number;
      lastSeen: number;
      sampleErrors: SerializedError[];
      errorCodes: Set<string>;
      affectedInvoices: Set<string>;
      affectedAccounts: Set<string>;
      affectedOperations: Set<string>;
      timestamps: number[];
      contextCounts: Map<string, Map<unknown, number>>;
    }
  >();

  private totalErrorsRecorded = 0;

  constructor(options: ErrorAggregatorOptions = {}) {
    this.strategy = options.strategy ?? "fingerprint";
    this.maxGroups = Math.max(1, options.maxGroups ?? 500);
    this.maxSamplesPerGroup = Math.max(1, options.maxSamplesPerGroup ?? 5);
    this.windowMs = options.windowMs;
  }

  /**
   * Computes the grouping key for an error using the configured strategy.
   */
  resolveGroupKey(error: unknown, context?: Record<string, unknown>): string {
    if (typeof this.strategy === "function") {
      return this.strategy(error, context);
    }

    const serialized = serializeError(error);
    const code = serialized.code || serialized.name || "UNKNOWN_ERROR";
    const normalizedMsg = normalizeErrorMessage(serialized.message);

    switch (this.strategy) {
      case "code":
        return code;
      case "message":
        return normalizedMsg || serialized.name;
      case "type":
        return serialized.name || "Error";
      case "component": {
        const comp =
          context?.component ||
          context?.operation ||
          serialized.context?.component ||
          serialized.context?.operation ||
          "general";
        return `${String(comp)}:${code}`;
      }
      case "fingerprint":
      default:
        return `${serialized.name}::${code}::${normalizedMsg}`;
    }
  }

  /**
   * Ingests and aggregates an error.
   */
  record(error: unknown, explicitContext?: Record<string, unknown>): AggregatedErrorGroup {
    const now = Date.now();
    this.totalErrorsRecorded++;

    // Merge error-level context with explicit context
    const attachedCtx = getErrorContext(error);
    const combinedContext: Record<string, unknown> = {
      ...(attachedCtx || {}),
      ...(explicitContext || {}),
    };

    const groupKey = this.resolveGroupKey(error, combinedContext);
    const serialized = serializeError(error);

    // Evict oldest group if capacity reached and group is new
    if (!this.groups.has(groupKey) && this.groups.size >= this.maxGroups) {
      let oldestKey: string | null = null;
      let oldestTime = Infinity;
      for (const [key, grp] of this.groups.entries()) {
        if (grp.lastSeen < oldestTime) {
          oldestTime = grp.lastSeen;
          oldestKey = key;
        }
      }
      if (oldestKey) {
        this.groups.delete(oldestKey);
      }
    }

    let grp = this.groups.get(groupKey);
    const strategyName = typeof this.strategy === "string" ? this.strategy : "custom";

    if (!grp) {
      grp = {
        groupKey,
        strategyName,
        count: 0,
        firstSeen: now,
        lastSeen: now,
        sampleErrors: [],
        errorCodes: new Set<string>(),
        affectedInvoices: new Set<string>(),
        affectedAccounts: new Set<string>(),
        affectedOperations: new Set<string>(),
        timestamps: [],
        contextCounts: new Map<string, Map<unknown, number>>(),
      };
      this.groups.set(groupKey, grp);
    }

    grp.count++;
    grp.lastSeen = now;
    grp.timestamps.push(now);

    // Track error code
    if (serialized.code) {
      grp.errorCodes.add(serialized.code);
    }

    // Track entity IDs from context
    const invoiceId = combinedContext.invoiceId || serialized.context?.invoiceId;
    if (invoiceId && typeof invoiceId === "string") {
      grp.affectedInvoices.add(invoiceId);
    }

    const accountId = combinedContext.accountId || serialized.context?.accountId;
    if (accountId && typeof accountId === "string") {
      grp.affectedAccounts.add(accountId);
    }

    const operation = combinedContext.operation || serialized.context?.operation;
    if (operation && typeof operation === "string") {
      grp.affectedOperations.add(operation);
    }

    // Track sample errors
    if (grp.sampleErrors.length < this.maxSamplesPerGroup) {
      grp.sampleErrors.push(serialized);
    } else {
      // Keep most recent samples
      grp.sampleErrors.shift();
      grp.sampleErrors.push(serialized);
    }

    // Track context frequencies to compute common context
    for (const [k, v] of Object.entries(combinedContext)) {
      if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") {
        if (!grp.contextCounts.has(k)) {
          grp.contextCounts.set(k, new Map());
        }
        const valMap = grp.contextCounts.get(k)!;
        valMap.set(v, (valMap.get(v) || 0) + 1);
      }
    }

    return this.buildAggregatedGroup(grp);
  }

  /**
   * Ingests a batch of errors.
   */
  recordBatch(errors: unknown[], context?: Record<string, unknown>): AggregatedErrorGroup[] {
    return errors.map((err) => this.record(err, context));
  }

  /**
   * Helper to construct AggregatedErrorGroup from internal group state.
   */
  private buildAggregatedGroup(grp: {
    groupKey: string;
    strategyName: string;
    count: number;
    firstSeen: number;
    lastSeen: number;
    sampleErrors: SerializedError[];
    errorCodes: Set<string>;
    affectedInvoices: Set<string>;
    affectedAccounts: Set<string>;
    affectedOperations: Set<string>;
    timestamps: number[];
    contextCounts: Map<string, Map<unknown, number>>;
  }): AggregatedErrorGroup {
    const spanMinutes = Math.max(0.1, (grp.lastSeen - grp.firstSeen) / 60000);
    const ratePerMinute = parseFloat((grp.count / spanMinutes).toFixed(2));

    // Calculate common context (values that appeared in 100% of the occurrences)
    const commonContext: Record<string, unknown> = {};
    for (const [k, valMap] of grp.contextCounts.entries()) {
      for (const [val, count] of valMap.entries()) {
        if (count === grp.count) {
          commonContext[k] = val;
        }
      }
    }

    return {
      groupKey: grp.groupKey,
      strategy: grp.strategyName,
      count: grp.count,
      firstSeen: grp.firstSeen,
      lastSeen: grp.lastSeen,
      sampleErrors: [...grp.sampleErrors],
      errorCodes: Array.from(grp.errorCodes),
      affectedInvoices: Array.from(grp.affectedInvoices),
      affectedAccounts: Array.from(grp.affectedAccounts),
      affectedOperations: Array.from(grp.affectedOperations),
      commonContext,
      ratePerMinute,
    };
  }

  /**
   * Returns all current aggregated groups.
   */
  getGroups(options?: ReportOptions): AggregatedErrorGroup[] {
    let list: AggregatedErrorGroup[] = [];

    const now = Date.now();
    for (const grp of this.groups.values()) {
      if (this.windowMs && now - grp.lastSeen > this.windowMs) {
        continue;
      }
      if (options?.since && grp.lastSeen < options.since) {
        continue;
      }
      if (options?.until && grp.firstSeen > options.until) {
        continue;
      }
      if (options?.minCount && grp.count < options.minCount) {
        continue;
      }
      list.push(this.buildAggregatedGroup(grp));
    }

    // Sort by count descending
    list.sort((a, b) => b.count - a.count);

    if (options?.limit && options.limit > 0) {
      list = list.slice(0, options.limit);
    }

    return list;
  }

  /**
   * Detects patterns across the aggregated errors to make trends and anomalies visible.
   */
  detectPatterns(): ErrorPattern[] {
    const patterns: ErrorPattern[] = [];
    const now = Date.now();

    // 1. Spike Detection: >= 5 errors in the last 60 seconds within a group
    for (const grp of this.groups.values()) {
      const recentTimestamps = grp.timestamps.filter((t) => now - t <= 60000);
      if (recentTimestamps.length >= 5) {
        patterns.push({
          type: "spike",
          severity: recentTimestamps.length >= 20 ? "critical" : "high",
          description: `Spike detected: ${recentTimestamps.length} errors occurred in the last 60 seconds for "${grp.groupKey}"`,
          groupKey: grp.groupKey,
          count: recentTimestamps.length,
          details: {
            timeWindowMs: 60000,
            recentCount: recentTimestamps.length,
            totalGroupCount: grp.count,
          },
        });
      }
    }

    // 2. High Frequency Detection: group accounts for > 40% of total errors (if total >= 10)
    if (this.totalErrorsRecorded >= 10) {
      for (const grp of this.groups.values()) {
        const proportion = grp.count / this.totalErrorsRecorded;
        if (proportion >= 0.4) {
          patterns.push({
            type: "high_frequency",
            severity: proportion >= 0.7 ? "high" : "medium",
            description: `Dominant error pattern: group "${grp.groupKey}" accounts for ${(proportion * 100).toFixed(1)}% of all recorded errors`,
            groupKey: grp.groupKey,
            count: grp.count,
            details: {
              proportion: parseFloat(proportion.toFixed(3)),
              totalErrors: this.totalErrorsRecorded,
            },
          });
        }
      }
    }

    // 3. Recurring Entity Failures: invoice or account appearing across multiple groups or >= 3 failures
    const invoiceCounts = new Map<string, number>();
    const accountCounts = new Map<string, number>();

    for (const grp of this.groups.values()) {
      for (const inv of grp.affectedInvoices) {
        invoiceCounts.set(inv, (invoiceCounts.get(inv) || 0) + grp.count);
      }
      for (const acc of grp.affectedAccounts) {
        accountCounts.set(acc, (accountCounts.get(acc) || 0) + grp.count);
      }
    }

    for (const [inv, count] of invoiceCounts.entries()) {
      if (count >= 3) {
        patterns.push({
          type: "recurring_entity",
          severity: count >= 10 ? "high" : "medium",
          description: `Recurring invoice failure: Invoice "${inv}" has failed ${count} times`,
          entityId: inv,
          count,
          details: { entityType: "invoice", invoiceId: inv },
        });
      }
    }

    for (const [acc, count] of accountCounts.entries()) {
      if (count >= 5) {
        patterns.push({
          type: "recurring_entity",
          severity: count >= 15 ? "high" : "medium",
          description: `Recurring account failure: Account "${acc}" has failed ${count} times`,
          entityId: acc,
          count,
          details: { entityType: "account", accountId: acc },
        });
      }
    }

    // 4. Cascading Failure: 3 or more distinct error groups within a tight 30-second window
    const recentWindowMs = 30000;
    const distinctGroupsRecent = new Set<string>();
    for (const grp of this.groups.values()) {
      if (grp.timestamps.some((t) => now - t <= recentWindowMs)) {
        distinctGroupsRecent.add(grp.groupKey);
      }
    }

    if (distinctGroupsRecent.size >= 3) {
      patterns.push({
        type: "cascading_failure",
        severity: "critical",
        description: `Cascading system failure: ${distinctGroupsRecent.size} distinct error groups triggered in the last 30 seconds`,
        count: distinctGroupsRecent.size,
        details: {
          groups: Array.from(distinctGroupsRecent),
          windowMs: recentWindowMs,
        },
      });
    }

    return patterns;
  }

  /**
   * Generates a comprehensive, human-readable and structured ErrorAggregationReport.
   */
  generateReport(options?: ReportOptions): ErrorAggregationReport {
    const groups = this.getGroups(options);
    const patterns = this.detectPatterns();
    const now = Date.now();

    let earliestTime = now;
    let latestTime = 0;
    let totalErrors = 0;

    const invoiceCounts = new Map<string, number>();
    const accountCounts = new Map<string, number>();
    const codeCounts = new Map<string, number>();

    for (const g of groups) {
      totalErrors += g.count;
      if (g.firstSeen < earliestTime) earliestTime = g.firstSeen;
      if (g.lastSeen > latestTime) latestTime = g.lastSeen;

      for (const inv of g.affectedInvoices) {
        invoiceCounts.set(inv, (invoiceCounts.get(inv) || 0) + g.count);
      }
      for (const acc of g.affectedAccounts) {
        accountCounts.set(acc, (accountCounts.get(acc) || 0) + g.count);
      }
      for (const code of g.errorCodes) {
        codeCounts.set(code, (codeCounts.get(code) || 0) + g.count);
      }
    }

    if (latestTime === 0) latestTime = now;
    if (earliestTime === now && groups.length === 0) earliestTime = now;

    // Top errors ranked
    const topErrors = groups.slice(0, 5).map((g) => ({
      groupKey: g.groupKey,
      count: g.count,
      percentage: totalErrors > 0 ? parseFloat(((g.count / totalErrors) * 100).toFixed(1)) : 0,
    }));

    // Find most affected entities
    let mostFrequentCode: string | null = null;
    let maxCodeCount = 0;
    for (const [code, count] of codeCounts.entries()) {
      if (count > maxCodeCount) {
        maxCodeCount = count;
        mostFrequentCode = code;
      }
    }

    let mostAffectedInvoice: string | null = null;
    let maxInvoiceCount = 0;
    for (const [inv, count] of invoiceCounts.entries()) {
      if (count > maxInvoiceCount) {
        maxInvoiceCount = count;
        mostAffectedInvoice = inv;
      }
    }

    let mostAffectedAccount: string | null = null;
    let maxAccountCount = 0;
    for (const [acc, count] of accountCounts.entries()) {
      if (count > maxAccountCount) {
        maxAccountCount = count;
        mostAffectedAccount = acc;
      }
    }

    const criticalPatternsCount = patterns.filter(
      (p) => p.severity === "critical" || p.severity === "high"
    ).length;

    const report: ErrorAggregationReport = {
      generatedAt: now,
      timeRange: {
        start: earliestTime,
        end: latestTime,
        durationMs: Math.max(0, latestTime - earliestTime),
      },
      totalErrors,
      uniqueGroups: groups.length,
      groups,
      topErrors,
      patterns,
      summary: {
        totalRecorded: this.totalErrorsRecorded,
        criticalPatternsCount,
        mostFrequentCode,
        mostAffectedInvoice,
        mostAffectedAccount,
      },

      formatAsText(): string {
        const lines: string[] = [];
        lines.push("==================================================");
        lines.push("           STELLARSPLIT ERROR REPORT              ");
        lines.push("==================================================");
        lines.push(`Generated: ${new Date(now).toISOString()}`);
        lines.push(`Total Errors: ${totalErrors} across ${groups.length} distinct group(s)`);
        lines.push(`Span: ${((latestTime - earliestTime) / 1000).toFixed(1)}s`);
        lines.push("");

        if (patterns.length > 0) {
          lines.push("--- DETECTED PATTERNS & ANOMALIES ---");
          for (const p of patterns) {
            lines.push(`[${p.severity.toUpperCase()}] [${p.type}] ${p.description}`);
          }
          lines.push("");
        }

        lines.push("--- TOP ERROR GROUPS ---");
        for (const [idx, item] of topErrors.entries()) {
          lines.push(`${idx + 1}. [${item.count} hits / ${item.percentage}%] ${item.groupKey}`);
        }
        lines.push("");

        lines.push("--- GROUP DETAILS ---");
        for (const g of groups) {
          lines.push(`Group: ${g.groupKey}`);
          lines.push(`  Hits: ${g.count} | Rate: ${g.ratePerMinute}/min | Codes: ${g.errorCodes.join(", ") || "none"}`);
          if (g.affectedInvoices.length > 0) {
            lines.push(`  Invoices: ${g.affectedInvoices.join(", ")}`);
          }
          if (g.affectedAccounts.length > 0) {
            lines.push(`  Accounts: ${g.affectedAccounts.join(", ")}`);
          }
          if (g.sampleErrors.length > 0) {
            lines.push(`  Latest sample: ${g.sampleErrors[g.sampleErrors.length - 1]!.message}`);
          }
        }
        lines.push("==================================================");
        return lines.join("\n");
      },

      formatAsMarkdown(): string {
        const md: string[] = [];
        md.push("# StellarSplit Error Aggregation Report");
        md.push(`**Generated At:** ${new Date(now).toISOString()}  `);
        md.push(`**Total Errors:** ${totalErrors} | **Unique Groups:** ${groups.length}  `);
        md.push("");

        if (patterns.length > 0) {
          md.push("## Patterns & Anomalies");
          for (const p of patterns) {
            md.push(`- **[${p.severity.toUpperCase()}]** \`${p.type}\`: ${p.description}`);
          }
          md.push("");
        }

        md.push("## Top Errors");
        md.push("| Rank | Group | Count | Percentage |");
        md.push("| --- | --- | --- | --- |");
        topErrors.forEach((t, i) => {
          md.push(`| ${i + 1} | \`${t.groupKey}\` | ${t.count} | ${t.percentage}% |`);
        });
        md.push("");

        md.push("## Error Groups Breakdown");
        for (const g of groups) {
          md.push(`### \`${g.groupKey}\``);
          md.push(`- **Occurrences:** ${g.count} (${g.ratePerMinute}/min)`);
          md.push(`- **First Seen:** ${new Date(g.firstSeen).toISOString()}`);
          md.push(`- **Last Seen:** ${new Date(g.lastSeen).toISOString()}`);
          if (g.affectedInvoices.length > 0) {
            md.push(`- **Affected Invoices:** ${g.affectedInvoices.map((id) => `\`${id}\``).join(", ")}`);
          }
          if (g.sampleErrors.length > 0) {
            md.push(`- **Sample Error:** \`${g.sampleErrors[g.sampleErrors.length - 1]!.message}\``);
          }
          md.push("");
        }

        return md.join("\n");
      },

      toJSON(): string {
        return JSON.stringify(
          {
            generatedAt: this.generatedAt,
            timeRange: this.timeRange,
            totalErrors: this.totalErrors,
            uniqueGroups: this.uniqueGroups,
            groups: this.groups,
            topErrors: this.topErrors,
            patterns: this.patterns,
            summary: this.summary,
          },
          null,
          2
        );
      },
    };

    return report;
  }

  /**
   * Resets all aggregation counters and clear memory.
   */
  clear(): void {
    this.groups.clear();
    this.totalErrorsRecorded = 0;
  }

  /**
   * Returns total error occurrences recorded across all groups.
   */
  totalCount(): number {
    return this.totalErrorsRecorded;
  }
}

// Global default aggregator singleton
let defaultErrorAggregator = new ErrorAggregator();

/** Gets the default global ErrorAggregator instance. */
export function getDefaultErrorAggregator(): ErrorAggregator {
  return defaultErrorAggregator;
}

/** Sets the default global ErrorAggregator instance. */
export function setDefaultErrorAggregator(aggregator: ErrorAggregator): void {
  defaultErrorAggregator = aggregator;
}

/** Resets the default global ErrorAggregator instance. */
export function resetDefaultErrorAggregator(): void {
  defaultErrorAggregator = new ErrorAggregator();
}

/** Convenience function to record an error in the default aggregator. */
export function aggregateError(
  error: unknown,
  context?: Record<string, unknown>
): AggregatedErrorGroup {
  return defaultErrorAggregator.record(error, context);
}
