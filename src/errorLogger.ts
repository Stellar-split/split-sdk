/**
 * Comprehensive error logging system for StellarSplit SDK.
 * Supports log levels, flexible formatting (Text, JSON), and reliable storage sinks.
 *
 * Issue #1069 — Implement error logging
 */

import { StellarSplitError } from "./errors.js";

/** Supported severity levels for logging. */
export type LogLevel = "debug" | "info" | "warn" | "error" | "fatal";

/** Numeric priority for log levels (higher is more severe). */
export const LogLevelPriority: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
  fatal: 4,
};

/** Checks whether a message at targetLevel should be logged given the active minLevel. */
export function isLogLevelEnabled(minLevel: LogLevel, targetLevel: LogLevel): boolean {
  return LogLevelPriority[targetLevel] >= LogLevelPriority[minLevel];
}

/** Normalizes a string to a valid LogLevel, falling back to defaultLevel. */
export function parseLogLevel(value: string | undefined | null, defaultLevel: LogLevel = "info"): LogLevel {
  if (!value) return defaultLevel;
  const lower = value.toLowerCase().trim();
  if (lower in LogLevelPriority) {
    return lower as LogLevel;
  }
  return defaultLevel;
}

/** Structured log entry. */
export interface LogEntry {
  /** Timestamp in milliseconds since Unix epoch. */
  timestamp: number;
  /** ISO 8601 formatted string timestamp. */
  isoTimestamp: string;
  /** Severity level. */
  level: LogLevel;
  /** Primary log message. */
  message: string;
  /** Optional error details. */
  error?: {
    name: string;
    message: string;
    code?: string;
    stack?: string;
    raw?: string;
    context?: Record<string, unknown>;
  };
  /** Additional structured metadata. */
  context?: Record<string, unknown>;
  /** Optional tags for classification. */
  tags?: string[];
  /** Distributed trace or operation identifier. */
  traceId?: string;
}

/** Formatter function contract for converting a LogEntry into a string. */
export type LogFormatter = (entry: LogEntry) => string;

/** Formats log entries as human-readable text. */
export const TextLogFormatter: LogFormatter = (entry: LogEntry): string => {
  const parts: string[] = [
    `[${entry.isoTimestamp}]`,
    `[${entry.level.toUpperCase()}]`,
  ];

  if (entry.traceId) {
    parts.push(`[${entry.traceId}]`);
  }

  if (entry.tags && entry.tags.length > 0) {
    parts.push(`[${entry.tags.join(",")}]`);
  }

  parts.push(entry.message);

  if (entry.error) {
    const errDetails: string[] = [];
    if (entry.error.code) errDetails.push(`code=${entry.error.code}`);
    errDetails.push(`error="${entry.error.name}: ${entry.error.message}"`);
    parts.push(`(${errDetails.join(", ")})`);
  }

  if (entry.context && Object.keys(entry.context).length > 0) {
    try {
      parts.push(`context=${safeStringify(entry.context)}`);
    } catch {
      parts.push(`context=[unserializable]`);
    }
  }

  return parts.join(" ");
};

/** Formats log entries as structured JSON strings. */
export const JsonLogFormatter: LogFormatter = (entry: LogEntry): string => {
  return safeStringify(entry);
};

/**
 * Safe JSON serializer handling BigInt and circular structures.
 */
function safeStringify(value: unknown): string {
  const seen = new WeakSet();
  return JSON.stringify(value, (_key, val) => {
    if (typeof val === "bigint") {
      return val.toString();
    }
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) {
        return "[Circular]";
      }
      seen.add(val);
    }
    return val;
  });
}

/**
 * Aggregate statistics over stored log entries.
 * Provides a quick debugging summary without iterating entries manually.
 */
export interface ErrorLogStats {
  /** Total number of log entries currently stored. */
  total: number;
  /** Count of entries per log level. */
  byLevel: Record<LogLevel, number>;
  /** Timestamp (ms) of the oldest stored entry, or undefined when empty. */
  oldestTimestamp: number | undefined;
  /** Timestamp (ms) of the newest stored entry, or undefined when empty. */
  newestTimestamp: number | undefined;
  /** Time span in milliseconds between oldest and newest; 0 when fewer than two entries. */
  spanMs: number;
}

/** Filter criteria for querying stored logs. */
export interface LogFilter {
  /** Exact level match. */
  level?: LogLevel;
  /** Minimum severity level match. */
  minLevel?: LogLevel;
  /** Include entries at or after this epoch timestamp. */
  since?: number;
  /** Include entries at or before this epoch timestamp. */
  until?: number;
  /** Substring search across message, error message, or error code. */
  search?: string;
  /** Must include at least one of these tags. */
  tags?: string[];
  /** Maximum number of records to return. */
  limit?: number;
  /** Number of matching records to skip (for pagination). */
  offset?: number;
}

/** Storage sink contract for error and operational logs. */
export interface LogStorage {
  /** Write a log entry to storage. */
  write(entry: LogEntry): void;
  /** Retrieve logs matching filter criteria. */
  getLogs(filter?: LogFilter): LogEntry[];
  /** Clear all stored logs. */
  clear(): void;
  /** Total count of stored logs. */
  count(): number;
  /** Aggregate statistics over stored entries. */
  getStats(): ErrorLogStats;
}

/**
 * Reliable bounded in-memory ring-buffer storage for logs.
 * When capacity is reached, the oldest entries are evicted first.
 */
export class MemoryLogStorage implements LogStorage {
  private readonly maxEntries: number;
  private entries: LogEntry[] = [];

  constructor(maxEntries: number = 1000) {
    this.maxEntries = Math.max(1, maxEntries);
  }

  write(entry: LogEntry): void {
    if (this.entries.length >= this.maxEntries) {
      this.entries.shift(); // Evict oldest
    }
    this.entries.push(entry);
  }

  getLogs(filter?: LogFilter): LogEntry[] {
    let result = this.entries;

    if (!filter) {
      return [...result];
    }

    if (filter.level) {
      result = result.filter((e) => e.level === filter.level);
    }

    if (filter.minLevel) {
      const minPri = LogLevelPriority[filter.minLevel];
      result = result.filter((e) => LogLevelPriority[e.level] >= minPri);
    }

    if (filter.since !== undefined) {
      result = result.filter((e) => e.timestamp >= filter.since!);
    }

    if (filter.until !== undefined) {
      result = result.filter((e) => e.timestamp <= filter.until!);
    }

    if (filter.search) {
      const query = filter.search.toLowerCase();
      result = result.filter((e) => {
        if (e.message.toLowerCase().includes(query)) return true;
        if (e.error?.message.toLowerCase().includes(query)) return true;
        if (e.error?.code?.toLowerCase().includes(query)) return true;
        return false;
      });
    }

    if (filter.tags && filter.tags.length > 0) {
      result = result.filter((e) =>
        e.tags ? filter.tags!.some((t) => e.tags!.includes(t)) : false
      );
    }

    if (filter.offset && filter.offset > 0) {
      result = result.slice(filter.offset);
    }

    if (filter.limit !== undefined && filter.limit >= 0) {
      result = result.slice(0, filter.limit);
    }

    return [...result];
  }

  clear(): void {
    this.entries = [];
  }

  count(): number {
    return this.entries.length;
  }

  getStats(): ErrorLogStats {
    const byLevel: Record<LogLevel, number> = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
      fatal: 0,
    };
    let oldestTimestamp: number | undefined;
    let newestTimestamp: number | undefined;

    for (const entry of this.entries) {
      byLevel[entry.level]++;
      if (oldestTimestamp === undefined || entry.timestamp < oldestTimestamp) {
        oldestTimestamp = entry.timestamp;
      }
      if (newestTimestamp === undefined || entry.timestamp > newestTimestamp) {
        newestTimestamp = entry.timestamp;
      }
    }

    return {
      total: this.entries.length,
      byLevel,
      oldestTimestamp,
      newestTimestamp,
      spanMs:
        oldestTimestamp !== undefined && newestTimestamp !== undefined && this.entries.length >= 2
          ? newestTimestamp - oldestTimestamp
          : 0,
    };
  }
}

/** Console storage sink that formats and logs to console. */
export class ConsoleLogStorage implements LogStorage {
  private readonly formatter: LogFormatter;
  private readonly enabled: boolean;
  private memoryFallback?: MemoryLogStorage;

  constructor(formatter: LogFormatter = TextLogFormatter, enabled: boolean = true, retainHistory: boolean = false) {
    this.formatter = formatter;
    this.enabled = enabled;
    if (retainHistory) {
      this.memoryFallback = new MemoryLogStorage(200);
    }
  }

  write(entry: LogEntry): void {
    if (this.memoryFallback) {
      this.memoryFallback.write(entry);
    }

    if (!this.enabled) return;

    const formatted = this.formatter(entry);
    switch (entry.level) {
      case "debug":
        console.debug(formatted);
        break;
      case "info":
        console.info(formatted);
        break;
      case "warn":
        console.warn(formatted);
        break;
      case "error":
      case "fatal":
        console.error(formatted);
        break;
    }
  }

  getLogs(filter?: LogFilter): LogEntry[] {
    return this.memoryFallback ? this.memoryFallback.getLogs(filter) : [];
  }

  clear(): void {
    this.memoryFallback?.clear();
  }

  count(): number {
    return this.memoryFallback ? this.memoryFallback.count() : 0;
  }

  getStats(): ErrorLogStats {
    return this.memoryFallback
      ? this.memoryFallback.getStats()
      : { total: 0, byLevel: { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 }, oldestTimestamp: undefined, newestTimestamp: undefined, spanMs: 0 };
  }
}

/** Multiplexes log entries to multiple storage sinks. */
export class MultiLogStorage implements LogStorage {
  private readonly sinks: LogStorage[];

  constructor(sinks: LogStorage[]) {
    this.sinks = sinks;
  }

  write(entry: LogEntry): void {
    for (const sink of this.sinks) {
      try {
        sink.write(entry);
      } catch {
        // Storage errors in one sink should not halt other sinks
      }
    }
  }

  getLogs(filter?: LogFilter): LogEntry[] {
    if (this.sinks.length === 0) return [];
    return this.sinks[0]!.getLogs(filter);
  }

  clear(): void {
    for (const sink of this.sinks) {
      sink.clear();
    }
  }

  count(): number {
    return this.sinks.length > 0 ? this.sinks[0]!.count() : 0;
  }

  getStats(): ErrorLogStats {
    return this.sinks.length > 0
      ? this.sinks[0]!.getStats()
      : { total: 0, byLevel: { debug: 0, info: 0, warn: 0, error: 0, fatal: 0 }, oldestTimestamp: undefined, newestTimestamp: undefined, spanMs: 0 };
  }
}

/** Configuration options for ErrorLogger. */
export interface ErrorLoggerOptions {
  /** Minimum log level to record. Defaults to 'info'. */
  minLevel?: LogLevel;
  /** Storage sink. Defaults to MemoryLogStorage with 1,000 max entries. */
  storage?: LogStorage;
  /** Formatting function for text/json representation. Defaults to TextLogFormatter. */
  formatter?: LogFormatter;
  /** Default metadata attached to all logs created by this instance. */
  defaultContext?: Record<string, unknown>;
  /** Default tags attached to all logs created by this instance. */
  defaultTags?: string[];
  /** Optional function returning active trace ID. */
  traceIdProvider?: () => string | undefined;
}

/**
 * ErrorLogger provides structured, level-aware error and operational logging.
 */
export class ErrorLogger {
  private minLevel: LogLevel;
  private storage: LogStorage;
  private formatter: LogFormatter;
  private defaultContext: Record<string, unknown>;
  private defaultTags: string[];
  private traceIdProvider?: () => string | undefined;

  constructor(options: ErrorLoggerOptions = {}) {
    this.minLevel = options.minLevel ?? "info";
    this.storage = options.storage ?? new MemoryLogStorage(1000);
    this.formatter = options.formatter ?? TextLogFormatter;
    this.defaultContext = options.defaultContext ? { ...options.defaultContext } : {};
    this.defaultTags = options.defaultTags ? [...options.defaultTags] : [];
    this.traceIdProvider = options.traceIdProvider;
  }

  /** Gets the active minimum log level. */
  getLevel(): LogLevel {
    return this.minLevel;
  }

  /** Sets the active minimum log level. */
  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  /** Sets a new storage sink. */
  setStorage(storage: LogStorage): void {
    this.storage = storage;
  }

  /** Gets the configured storage sink. */
  getStorage(): LogStorage {
    return this.storage;
  }

  /** Sets the log formatter. */
  setFormatter(formatter: LogFormatter): void {
    this.formatter = formatter;
  }

  /** Gets the current formatter. */
  getFormatter(): LogFormatter {
    return this.formatter;
  }

  /** Creates a child logger with inherited settings and merged context/tags. */
  child(childContext: Record<string, unknown> = {}, childTags: string[] = []): ErrorLogger {
    return new ErrorLogger({
      minLevel: this.minLevel,
      storage: this.storage,
      formatter: this.formatter,
      defaultContext: { ...this.defaultContext, ...childContext },
      defaultTags: Array.from(new Set([...this.defaultTags, ...childTags])),
      traceIdProvider: this.traceIdProvider,
    });
  }

  /** Primary logging method. Returns the created LogEntry or null if filtered out. */
  log(
    level: LogLevel,
    message: string,
    options?: {
      error?: unknown;
      context?: Record<string, unknown>;
      tags?: string[];
      traceId?: string;
    }
  ): LogEntry | null {
    if (!isLogLevelEnabled(this.minLevel, level)) {
      return null;
    }

    const now = Date.now();
    const traceId = options?.traceId ?? (this.traceIdProvider ? this.traceIdProvider() : undefined);

    let errorDetail: LogEntry["error"];
    if (options?.error) {
      const err = options.error;
      if (err instanceof StellarSplitError) {
        errorDetail = {
          name: err.name,
          message: err.message,
          code: err.code,
          stack: err.stack,
          raw: err.raw,
          context: err.context,
        };
      } else if (err instanceof Error) {
        errorDetail = {
          name: err.name,
          message: err.message,
          code: (err as { code?: string }).code,
          stack: err.stack,
        };
      } else {
        errorDetail = {
          name: "NonErrorThrown",
          message: String(err),
        };
      }
    }

    const mergedContext = {
      ...this.defaultContext,
      ...(options?.context || {}),
    };

    const mergedTags = Array.from(
      new Set([...this.defaultTags, ...(options?.tags || [])])
    );

    const entry: LogEntry = {
      timestamp: now,
      isoTimestamp: new Date(now).toISOString(),
      level,
      message,
      error: errorDetail,
      context: Object.keys(mergedContext).length > 0 ? mergedContext : undefined,
      tags: mergedTags.length > 0 ? mergedTags : undefined,
      traceId,
    };

    this.storage.write(entry);
    return entry;
  }

  /** Log at DEBUG level. */
  debug(message: string, context?: Record<string, unknown>, error?: unknown): LogEntry | null {
    return this.log("debug", message, { context, error });
  }

  /** Log at INFO level. */
  info(message: string, context?: Record<string, unknown>, error?: unknown): LogEntry | null {
    return this.log("info", message, { context, error });
  }

  /** Log at WARN level. */
  warn(message: string, context?: Record<string, unknown>, error?: unknown): LogEntry | null {
    return this.log("warn", message, { context, error });
  }

  /** Log at ERROR level. */
  error(message: string, error?: unknown, context?: Record<string, unknown>): LogEntry | null {
    return this.log("error", message, { error, context });
  }

  /** Log at FATAL level. */
  fatal(message: string, error?: unknown, context?: Record<string, unknown>): LogEntry | null {
    return this.log("fatal", message, { error, context });
  }

  /** Retrieve stored logs matching filter criteria. */
  getLogs(filter?: LogFilter): LogEntry[] {
    return this.storage.getLogs(filter);
  }

  /** Clear all stored logs. */
  clear(): void {
    this.storage.clear();
  }

  /** Total count of stored logs. */
  count(): number {
    return this.storage.count();
  }

  /**
   * Returns aggregate statistics over stored log entries.
   * Useful for dashboards and debugging summaries.
   */
  getStats(): ErrorLogStats {
    return this.storage.getStats();
  }

  /** Format a given log entry using the active formatter. */
  format(entry: LogEntry): string {
    return this.formatter(entry);
  }
}

// Global default logger singleton
let defaultErrorLogger = new ErrorLogger({ minLevel: "info" });

/** Gets the default global ErrorLogger instance. */
export function getDefaultErrorLogger(): ErrorLogger {
  return defaultErrorLogger;
}

/** Sets the default global ErrorLogger instance. */
export function setDefaultErrorLogger(logger: ErrorLogger): void {
  defaultErrorLogger = logger;
}

/** Resets the default ErrorLogger to initial state. */
export function resetDefaultErrorLogger(): void {
  defaultErrorLogger = new ErrorLogger({ minLevel: "info" });
}

/** Convenience function to log an error with the default logger. */
export function logError(
  error: unknown,
  message: string = "An error occurred",
  context?: Record<string, unknown>
): LogEntry | null {
  return defaultErrorLogger.error(message, error, context);
}

/** Convenience function to get aggregate stats from the default logger. */
export function getLogStats(): ErrorLogStats {
  return defaultErrorLogger.getStats();
}
