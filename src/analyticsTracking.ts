/**
 * Optional analytics tracking for SDK usage metrics with privacy controls and reporting.
 *
 * Designed to provide privacy-preserving usage metrics for SDK consumers.
 * Strictly opt-in (enabled: false by default).
 */

import { createHash, randomBytes } from "crypto";

export type PrivacyLevel = "strict" | "anonymized" | "standard";

// ---------------------------------------------------------------------------
// Debug Mode
// ---------------------------------------------------------------------------

export type DebugLevel = "off" | "error" | "warn" | "info" | "debug" | "trace";

const DEBUG_LEVEL_ORDER: Record<DebugLevel, number> = {
  off: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
  trace: 5,
};

export interface DebugConfig {
  /** Active debug level threshold. Default: "off". */
  level?: DebugLevel;
  /** Sink for formatted debug lines. Default: console. */
  logger?: (line: string) => void;
  /** Named breakpoints that should pause/flag execution. */
  breakpoints?: string[];
  /** Callback invoked when a breakpoint is hit. */
  onBreakpoint?: (name: string, context?: Record<string, unknown>) => void;
}

/**
 * Debug utilities: level gating, verbose logging, breakpoints, and state inspection.
 */
export class DebugController {
  private level: DebugLevel;
  private readonly logger: (line: string) => void;
  private readonly breakpoints = new Set<string>();
  private readonly onBreakpoint?: (name: string, context?: Record<string, unknown>) => void;
  private readonly hits = new Map<string, number>();

  constructor(config?: DebugConfig) {
    this.level = config?.level ?? "off";
    this.logger = config?.logger ?? ((line) => console.log(line));
    this.onBreakpoint = config?.onBreakpoint;
    for (const bp of config?.breakpoints ?? []) {
      this.breakpoints.add(bp);
    }
  }

  get currentLevel(): DebugLevel {
    return this.level;
  }

  setLevel(level: DebugLevel): void {
    this.level = level;
  }

  enable(level: DebugLevel = "debug"): void {
    this.level = level;
  }

  disable(): void {
    this.level = "off";
  }

  isEnabled(level: DebugLevel = "debug"): boolean {
    return DEBUG_LEVEL_ORDER[this.level] >= DEBUG_LEVEL_ORDER[level];
  }

  /** Emit a verbose log line gated by the active debug level. */
  log(level: Exclude<DebugLevel, "off">, message: string, context?: Record<string, unknown>): void {
    if (!this.isEnabled(level)) return;
    const ts = new Date().toISOString();
    const suffix = context ? ` ${this.format(context)}` : "";
    this.logger(`[${ts}] [${level.toUpperCase()}] ${message}${suffix}`);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.log("error", message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.log("warn", message, context);
  }

  info(message: string, context?: Record<string, unknown>): void {
    this.log("info", message, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.log("debug", message, context);
  }

  trace(message: string, context?: Record<string, unknown>): void {
    this.log("trace", message, context);
  }

  addBreakpoint(name: string): void {
    this.breakpoints.add(name);
  }

  removeBreakpoint(name: string): void {
    this.breakpoints.delete(name);
  }

  /**
   * Flag execution at a named breakpoint when debug mode is enabled.
   * Returns true when the breakpoint is active and was hit.
   */
  breakpoint(name: string, context?: Record<string, unknown>): boolean {
    if (!this.isEnabled("debug") || !this.breakpoints.has(name)) return false;
    this.hits.set(name, (this.hits.get(name) ?? 0) + 1);
    this.log("debug", `breakpoint hit: ${name}`, context);
    this.onBreakpoint?.(name, context);
    return true;
  }

  getBreakpointHits(): Record<string, number> {
    return Object.fromEntries(this.hits.entries());
  }

  /** Format a value for debug output (safe against circular references). */
  format(value: unknown): string {
    const seen = new WeakSet<object>();
    try {
      return JSON.stringify(value, (_key, val) => {
        if (typeof val === "object" && val !== null) {
          if (seen.has(val as object)) return "[Circular]";
          seen.add(val as object);
        }
        if (typeof val === "bigint") return val.toString();
        return val;
      });
    } catch {
      return String(value);
    }
  }

  /** Inspect arbitrary state for debugging. */
  inspect(label: string, state: unknown): void {
    this.log("debug", `inspect ${label}`, { state });
  }
}

export interface AnalyticsPrivacyConfig {
  /**
   * Overall privacy level:
   * - "strict": completely drops all addresses, metadata, and custom properties.
   * - "anonymized": hashes/masks Stellar public keys and scrubs sensitive data (default).
   * - "standard": allows public keys but scrubs secret keys and credentials.
   */
  level?: PrivacyLevel;
  /** Whether to anonymize Stellar public keys (G...). Default: true. */
  anonymizeAddresses?: boolean;
  /** Whether to strip secret keys (S...) and credentials. Default: true. */
  stripSecrets?: boolean;
  /** Whether to strip PII (email, IP, names). Default: true. */
  allowPII?: boolean;
  /** Respect browser / environment Do Not Track headers or flags. Default: true. */
  respectDoNotTrack?: boolean;
}

export interface AnalyticsEventInput {
  name: string;
  category?: string;
  properties?: Record<string, unknown>;
  timestamp?: number;
}

export interface AnalyticsEvent {
  name: string;
  category: string;
  properties: Record<string, unknown>;
  timestamp: number;
}

export interface MethodMetric {
  calls: number;
  errors: number;
  errorRate: number;
  avgDurationMs: number;
  minDurationMs: number;
  maxDurationMs: number;
  p50DurationMs: number;
  p95DurationMs: number;
  p99DurationMs: number;
}

export interface CacheMetric {
  hits: number;
  misses: number;
  hitRate: number;
}

export interface BatchMetric {
  operations: number;
  failures: number;
  failureRate: number;
  totalItems: number;
  avgDurationMs: number;
  avgBatchSize: number;
  maxDurationMs: number;
}

export interface PerformanceMetricsSnapshot {
  generatedAt: number;
  uptimeMs: number;
  methods: Record<string, MethodMetric>;
  cache: CacheMetric;
  batch: BatchMetric;
  counters: Record<string, number>;
}

export interface AnalyticsReport {
  generatedAt: number;
  periodMs: number;
  privacyLevel: PrivacyLevel;
  totalEvents: number;
  totalMethodCalls: number;
  totalErrors: number;
  overallErrorRate: number;
  methods: Record<string, MethodMetric>;
  eventsByCategory: Record<string, number>;
  metrics: Record<string, number>;
  events: AnalyticsEvent[];
}

export interface AnalyticsTrackerOptions {
  /** Strictly opt-in: defaults to false. */
  enabled?: boolean;
  /** Privacy controls configuration. */
  privacy?: AnalyticsPrivacyConfig;
  /** Remote reporting endpoint URL for flush(). */
  endpoint?: string;
  /** Auto-flush interval in milliseconds (0 or undefined to disable auto-flush). */
  flushIntervalMs?: number;
  /** Maximum number of raw events retained in the collector buffer. Default: 1000. */
  maxQueueSize?: number;
  /** Custom reporter callback invoked on flush or report generation. */
  onReport?: (report: AnalyticsReport) => void;
  /** Optional custom fetch implementation for network reporting. */
  fetchFn?: typeof fetch;
  /** Debug mode configuration for verbose operation logging. */
  debug?: DebugConfig;
}

// ---------------------------------------------------------------------------
// Privacy Controller
// ---------------------------------------------------------------------------

const STELLAR_SECRET_PATTERN = /\bS[A-Z0-9]{55}\b/g;
const STELLAR_PUBLIC_PATTERN = /\bG[A-Z0-9]{55}\b/g;
const PII_KEYS = new Set([
  "ip",
  "ipaddress",
  "ip_address",
  "email",
  "emailaddress",
  "email_address",
  "phone",
  "phonenumber",
  "ssn",
  "password",
  "secret",
  "privatekey",
  "private_key",
  "authorization",
  "token",
]);

export class PrivacyController {
  private readonly config: Required<AnalyticsPrivacyConfig>;

  constructor(config?: AnalyticsPrivacyConfig) {
    this.config = {
      level: config?.level ?? "anonymized",
      anonymizeAddresses: config?.anonymizeAddresses ?? true,
      stripSecrets: config?.stripSecrets ?? true,
      allowPII: config?.allowPII ?? false,
      respectDoNotTrack: config?.respectDoNotTrack ?? true,
    };
  }

  get level(): PrivacyLevel {
    return this.config.level;
  }

  isDoNotTrackEnabled(): boolean {
    if (!this.config.respectDoNotTrack) return false;
    if (typeof navigator !== "undefined" && "doNotTrack" in navigator) {
      return (navigator as { doNotTrack?: string }).doNotTrack === "1";
    }
    if (typeof process !== "undefined" && process.env?.DO_NOT_TRACK === "1") {
      return true;
    }
    return false;
  }

  anonymizeAddress(address: string): string {
    if (this.config.level === "strict") {
      return "[REDACTED_ADDRESS]";
    }
    if (!this.config.anonymizeAddresses && this.config.level === "standard") {
      return address;
    }
    // Deterministic pseudonym: first 4, last 4 chars + 8-char sha256 hash
    const hash = createHash("sha256").update(address).digest("hex").slice(0, 8);
    return `${address.slice(0, 4)}...${hash}...${address.slice(-4)}`;
  }

  sanitizeString(val: string): string {
    let out = val;
    if (this.config.stripSecrets) {
      out = out.replace(STELLAR_SECRET_PATTERN, "[REDACTED_SECRET]");
    }
    if (this.config.anonymizeAddresses || this.config.level !== "standard") {
      out = out.replace(STELLAR_PUBLIC_PATTERN, (match) => this.anonymizeAddress(match));
    }
    return out;
  }

  sanitizeValue(key: string, value: unknown): unknown {
    if (value === null || value === undefined) return value;

    const lowerKey = key.toLowerCase();
    if (!this.config.allowPII && PII_KEYS.has(lowerKey)) {
      return "[REDACTED_PII]";
    }

    if (typeof value === "string") {
      return this.sanitizeString(value);
    }

    if (typeof value === "bigint" || typeof value === "number" || typeof value === "boolean") {
      return value;
    }

    if (Array.isArray(value)) {
      if (this.config.level === "strict") return [];
      return value.map((item, idx) => this.sanitizeValue(`${key}_${idx}`, item));
    }

    if (typeof value === "object") {
      if (this.config.level === "strict") return {};
      return this.sanitizeProperties(value as Record<string, unknown>);
    }

    return String(value);
  }

  sanitizeProperties(properties?: Record<string, unknown>): Record<string, unknown> {
    if (!properties) return {};
    if (this.config.level === "strict") return {};

    const sanitized: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(properties)) {
      sanitized[key] = this.sanitizeValue(key, val);
    }
    return sanitized;
  }
}

// ---------------------------------------------------------------------------
// Analytics Collector
// ---------------------------------------------------------------------------

interface MethodRecord {
  count: number;
  errors: number;
  durations: number[];
}

interface BatchRecord {
  operations: number;
  failures: number;
  totalItems: number;
  totalDurationMs: number;
  maxDurationMs: number;
}

export class AnalyticsCollector {
  private readonly maxQueueSize: number;
  private readonly events: AnalyticsEvent[] = [];
  private readonly methods = new Map<string, MethodRecord>();
  private readonly metrics = new Map<string, number>();
  private readonly categoryCounts = new Map<string, number>();
  private cacheHits = 0;
  private cacheMisses = 0;
  private readonly batch: BatchRecord = {
    operations: 0,
    failures: 0,
    totalItems: 0,
    totalDurationMs: 0,
    maxDurationMs: 0,
  };
  private startTime: number = Date.now();

  constructor(maxQueueSize = 1000) {
    this.maxQueueSize = maxQueueSize;
  }

  recordEvent(event: AnalyticsEvent): void {
    if (this.events.length >= this.maxQueueSize) {
      this.events.shift(); // Evict oldest event when queue is full
    }
    this.events.push(event);

    const cat = event.category || "general";
    this.categoryCounts.set(cat, (this.categoryCounts.get(cat) ?? 0) + 1);
  }

  recordMethod(method: string, durationMs: number, success: boolean): void {
    let rec = this.methods.get(method);
    if (!rec) {
      rec = { count: 0, errors: 0, durations: [] };
      this.methods.set(method, rec);
    }
    rec.count += 1;
    if (!success) {
      rec.errors += 1;
    }
    rec.durations.push(durationMs);
    // Keep max 500 duration samples per method to avoid unbounded memory
    if (rec.durations.length > 500) {
      rec.durations.shift();
    }
  }

  recordMetric(name: string, value: number): void {
    this.metrics.set(name, (this.metrics.get(name) ?? 0) + value);
  }

  getEvents(): AnalyticsEvent[] {
    return [...this.events];
  }

  getMetrics(): Record<string, number> {
    return Object.fromEntries(this.metrics.entries());
  }

  private calculatePercentile(sorted: number[], p: number): number {
    if (sorted.length === 0) return 0;
    const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
    return sorted[idx]!;
  }

  getMethodMetrics(): Record<string, MethodMetric> {
    const out: Record<string, MethodMetric> = {};
    for (const [method, rec] of this.methods.entries()) {
      const sorted = [...rec.durations].sort((a, b) => a - b);
      const total = rec.durations.reduce((sum, d) => sum + d, 0);
      out[method] = {
        calls: rec.count,
        errors: rec.errors,
        errorRate: rec.count === 0 ? 0 : rec.errors / rec.count,
        avgDurationMs: rec.durations.length === 0 ? 0 : total / rec.durations.length,
        minDurationMs: sorted.length === 0 ? 0 : sorted[0]!,
        maxDurationMs: sorted.length === 0 ? 0 : sorted[sorted.length - 1]!,
        p50DurationMs: this.calculatePercentile(sorted, 50),
        p95DurationMs: this.calculatePercentile(sorted, 95),
        p99DurationMs: this.calculatePercentile(sorted, 99),
      };
    }
    return out;
  }

  getTotalMethodCalls(): number {
    let total = 0;
    for (const rec of this.methods.values()) {
      total += rec.count;
    }
    return total;
  }

  getTotalErrors(): number {
    let total = 0;
    for (const rec of this.methods.values()) {
      total += rec.errors;
    }
    return total;
  }

  recordCacheHit(): void {
    this.cacheHits += 1;
  }

  recordCacheMiss(): void {
    this.cacheMisses += 1;
  }

  getCacheMetric(): CacheMetric {
    const total = this.cacheHits + this.cacheMisses;
    return {
      hits: this.cacheHits,
      misses: this.cacheMisses,
      hitRate: total === 0 ? 0 : this.cacheHits / total,
    };
  }

  recordBatch(operationCount: number, itemCount: number, durationMs: number, failed: boolean): void {
    this.batch.operations += operationCount;
    this.batch.totalItems += itemCount;
    this.batch.totalDurationMs += durationMs;
    if (durationMs > this.batch.maxDurationMs) {
      this.batch.maxDurationMs = durationMs;
    }
    if (failed) {
      this.batch.failures += 1;
    }
  }

  getBatchMetric(): BatchMetric {
    return {
      operations: this.batch.operations,
      failures: this.batch.failures,
      failureRate: this.batch.operations === 0 ? 0 : this.batch.failures / this.batch.operations,
      totalItems: this.batch.totalItems,
      avgDurationMs:
        this.batch.operations === 0 ? 0 : this.batch.totalDurationMs / this.batch.operations,
      avgBatchSize:
        this.batch.operations === 0 ? 0 : this.batch.totalItems / this.batch.operations,
      maxDurationMs: this.batch.maxDurationMs,
    };
  }

  getPerformanceSnapshot(): PerformanceMetricsSnapshot {
    return {
      generatedAt: Date.now(),
      uptimeMs: this.getPeriodMs(),
      methods: this.getMethodMetrics(),
      cache: this.getCacheMetric(),
      batch: this.getBatchMetric(),
      counters: this.getMetrics(),
    };
  }

  getCategoryCounts(): Record<string, number> {
    return Object.fromEntries(this.categoryCounts.entries());
  }

  getPeriodMs(): number {
    return Date.now() - this.startTime;
  }

  reset(): void {
    this.events.length = 0;
    this.methods.clear();
    this.metrics.clear();
    this.categoryCounts.clear();
    this.cacheHits = 0;
    this.cacheMisses = 0;
    this.batch.operations = 0;
    this.batch.failures = 0;
    this.batch.totalItems = 0;
    this.batch.totalDurationMs = 0;
    this.batch.maxDurationMs = 0;
    this.startTime = Date.now();
  }
}

// ---------------------------------------------------------------------------
// Analytics Tracker
// ---------------------------------------------------------------------------

/**
 * High-level analytics tracker. Strictly opt-in: when `enabled` is false (the
 * default) or `optOut` is true, no events or metrics are recorded and flushes
 * are no-ops.
 */
export class AnalyticsTracker {
  private enabled: boolean;
  private optedOut: boolean;
  private readonly privacy: PrivacyController;
  private readonly collector: AnalyticsCollector;
  private readonly endpoint?: string;
  private readonly onReport?: (report: AnalyticsReport) => void;
  private readonly fetchFn?: typeof fetch;
  private readonly debug: DebugController;
  private flushTimer?: ReturnType<typeof setInterval>;
  private readonly sessionId: string;

  constructor(options?: AnalyticsTrackerOptions) {
    this.enabled = options?.enabled ?? false;
    this.optedOut = false;
    this.privacy = new PrivacyController(options?.privacy);
    this.collector = new AnalyticsCollector(options?.maxQueueSize ?? 1000);
    this.endpoint = options?.endpoint;
    this.onReport = options?.onReport;
    this.fetchFn = options?.fetchFn;
    this.debug = new DebugController(options?.debug);
    this.sessionId = randomBytes(8).toString("hex");

    if (this.privacy.isDoNotTrackEnabled()) {
      this.enabled = false;
    }

    const interval = options?.flushIntervalMs ?? 0;
    if (interval > 0 && this.isActive()) {
      this.flushTimer = setInterval(() => {
        void this.flush();
      }, interval);
      if (typeof this.flushTimer === "object" && "unref" in this.flushTimer) {
        (this.flushTimer as { unref?: () => void }).unref?.();
      }
    }
  }

  /** Whether tracking is currently active (enabled and not opted out). */
  isActive(): boolean {
    return this.enabled && !this.optedOut;
  }

  isEnabled(): boolean {
    return this.enabled;
  }

  setEnabled(enabled: boolean): void {
    this.enabled = enabled;
    if (!enabled) {
      this.stopAutoFlush();
    }
  }

  /** Permanently opt out of all tracking for this tracker instance. */
  optOut(): void {
    this.optedOut = true;
    this.enabled = false;
    this.stopAutoFlush();
    this.collector.reset();
  }

  /** Re-enable tracking after an opt-out. */
  optIn(): void {
    this.optedOut = false;
    this.enabled = true;
  }

  isOptedOut(): boolean {
    return this.optedOut;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Track a usage event. No-op when tracking is inactive. */
  trackEvent(input: AnalyticsEventInput): void {
    if (!this.isActive()) return;
    const event: AnalyticsEvent = {
      name: input.name,
      category: input.category ?? "general",
      properties: this.privacy.sanitizeProperties(input.properties),
      timestamp: input.timestamp ?? Date.now(),
    };
    this.collector.recordEvent(event);
    this.debug.debug("event tracked", { name: event.name, category: event.category });
  }

  /** Record a numeric counter metric. No-op when tracking is inactive. */
  recordMetric(name: string, value: number): void {
    if (!this.isActive()) return;
    this.collector.recordMetric(name, value);
  }

  /** Record a method invocation with duration and outcome. No-op when inactive. */
  recordMethod(method: string, durationMs: number, success = true): void {
    if (!this.isActive()) return;
    this.collector.recordMethod(method, durationMs, success);
  }

  /** Time an async operation and record it as a method metric. */
  async timeMethod<T>(method: string, fn: () => Promise<T>): Promise<T> {
    const start = Date.now();
    try {
      const result = await fn();
      this.recordMethod(method, Date.now() - start, true);
      return result;
    } catch (err) {
      this.recordMethod(method, Date.now() - start, false);
      throw err;
    }
  }

  recordCacheHit(): void {
    if (!this.isActive()) return;
    this.collector.recordCacheHit();
  }

  recordCacheMiss(): void {
    if (!this.isActive()) return;
    this.collector.recordCacheMiss();
  }

  recordBatch(operationCount: number, itemCount: number, durationMs: number, failed = false): void {
    if (!this.isActive()) return;
    this.collector.recordBatch(operationCount, itemCount, durationMs, failed);
  }

  /** Build a usage report from collected data. */
  getReport(): AnalyticsReport {
    const methods = this.collector.getMethodMetrics();
    const totalMethodCalls = this.collector.getTotalMethodCalls();
    const totalErrors = this.collector.getTotalErrors();
    return {
      generatedAt: Date.now(),
      periodMs: this.collector.getPeriodMs(),
      privacyLevel: this.privacy.level,
      totalEvents: this.collector.getEvents().length,
      totalMethodCalls,
      totalErrors,
      overallErrorRate: totalMethodCalls === 0 ? 0 : totalErrors / totalMethodCalls,
      methods,
      eventsByCategory: this.collector.getCategoryCounts(),
      metrics: this.collector.getMetrics(),
      events: this.collector.getEvents(),
    };
  }

  /** Usage statistics snapshot (performance metrics). */
  getStats(): PerformanceMetricsSnapshot {
    return this.collector.getPerformanceSnapshot();
  }

  /**
   * Flush collected data to the configured reporter/endpoint.
   * Returns the report that was flushed, or null when tracking is inactive.
   */
  async flush(): Promise<AnalyticsReport | null> {
    if (!this.isActive()) return null;
    const report = this.getReport();
    this.onReport?.(report);

    if (this.endpoint) {
      const fetchImpl = this.fetchFn ?? (typeof fetch !== "undefined" ? fetch : undefined);
      if (fetchImpl) {
        try {
          await fetchImpl(this.endpoint, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(report),
          });
        } catch (err) {
          this.debug.warn("analytics flush failed", { error: String(err) });
        }
      }
    }

    this.collector.reset();
    return report;
  }

  /** Stop the auto-flush timer if running. */
  stopAutoFlush(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = undefined;
    }
  }

  /** Alias for {@link trackEvent}. */
  track(input: AnalyticsEventInput): void {
    this.trackEvent(input);
  }

  /** Alias for {@link recordMethod}. */
  trackMethod(method: string, durationMs: number, success = true): void {
    this.recordMethod(method, durationMs, success);
  }

  /** Alias for {@link recordMetric}. */
  trackMetric(name: string, value: number): void {
    this.recordMetric(name, value);
  }

  /** Records an error as both a metric counter and an "errors"-category event. */
  trackError(error: unknown, properties?: Record<string, unknown>): void {
    if (!this.isActive()) return;
    this.collector.recordMetric("error_count", 1);
    this.trackEvent({
      name: "error",
      category: "errors",
      properties: {
        message: error instanceof Error ? error.message : String(error),
        ...properties,
      },
    });
  }

  /** Alias for {@link getReport}. */
  generateReport(): AnalyticsReport {
    return this.getReport();
  }
}

/**
 * Wraps a client object so every method call is timed and recorded via
 * {@link AnalyticsTracker.trackMethod}. Returns the original client unchanged
 * when the tracker is inactive.
 */
export function wrapClientWithAnalytics<T extends object>(client: T, tracker: AnalyticsTracker): T {
  if (!tracker.isActive()) return client;

  return new Proxy(client, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== "function") return value;

      return async (...args: unknown[]) => {
        const start = Date.now();
        try {
          const result = await (value as (...a: unknown[]) => unknown).apply(target, args);
          tracker.trackMethod(String(prop), Date.now() - start, true);
          return result;
        } catch (err) {
          tracker.trackMethod(String(prop), Date.now() - start, false);
          throw err;
        }
      };
    },
  }) as T;
}
