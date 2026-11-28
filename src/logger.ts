/**
 * Configurable structured debug logging for the StellarSplit SDK.
 *
 * Provides granular log levels, contextual metadata, sensitive data redaction,
 * pluggable formatters, custom sinks, and dynamic runtime control.
 */

/**
 * Log level severity hierarchy. Lower numerical values correspond to more verbose output.
 */
export enum LogLevel {
  /** Detailed tracing and debug diagnostics. */
  DEBUG = 0,
  /** General informational events regarding operational state. */
  INFO = 1,
  /** Potential issues, recoverable fallbacks, or degraded states. */
  WARN = 2,
  /** Critical failures, unrecoverable RPC errors, or contract exceptions. */
  ERROR = 3,
  /** Disables all log output. */
  NONE = 4,
}

/** String representation of supported log levels. */
export type LogLevelString = "debug" | "info" | "warn" | "error" | "none";

/**
 * Parses a numeric {@link LogLevel} or lowercase {@link LogLevelString} into a canonical LogLevel enum.
 *
 * @param level - The log level enum or string representation.
 * @returns The resolved {@link LogLevel}.
 *
 * @example
 * ```typescript
 * parseLogLevel("debug"); // LogLevel.DEBUG
 * parseLogLevel(LogLevel.WARN); // LogLevel.WARN
 * ```
 */
export function parseLogLevel(level: LogLevel | LogLevelString): LogLevel {
  if (typeof level === "number") {
    if (level >= LogLevel.DEBUG && level <= LogLevel.NONE) {
      return level;
    }
    return LogLevel.NONE;
  }

  switch (level?.toLowerCase()?.trim()) {
    case "debug":
      return LogLevel.DEBUG;
    case "info":
      return LogLevel.INFO;
    case "warn":
    case "warning":
      return LogLevel.WARN;
    case "error":
      return LogLevel.ERROR;
    case "none":
    case "silent":
    case "off":
      return LogLevel.NONE;
    default:
      return LogLevel.NONE;
  }
}

/**
 * Maps a {@link LogLevel} enum value to its canonical uppercase string label.
 *
 * @param level - The numeric log level.
 * @returns The string label (e.g. "DEBUG", "INFO").
 */
export function logLevelToString(level: LogLevel): "DEBUG" | "INFO" | "WARN" | "ERROR" | "NONE" {
  switch (level) {
    case LogLevel.DEBUG:
      return "DEBUG";
    case LogLevel.INFO:
      return "INFO";
    case LogLevel.WARN:
      return "WARN";
    case LogLevel.ERROR:
      return "ERROR";
    case LogLevel.NONE:
    default:
      return "NONE";
  }
}

/**
 * Structured log record emitted for each logged message.
 */
export interface LogEntry {
  /** Unix timestamp in milliseconds when the log entry was generated. */
  timestamp: number;
  /** ISO 8601 string representation of the timestamp. */
  isoTime: string;
  /** Severity level enum of this entry. */
  level: LogLevel;
  /** Canonical uppercase name of the log level. */
  levelName: "DEBUG" | "INFO" | "WARN" | "ERROR";
  /** Namespace or component name emitting this entry (e.g. "StellarSplitClient"). */
  namespace: string;
  /** Human-readable log message. */
  message: string;
  /** Optional contextual metadata and key-value attributes. */
  context?: Record<string, unknown>;
  /** Optional trace ID correlating this entry with a top-level SDK operation. */
  traceId?: TraceId;
}

/**
 * Function signature for converting a {@link LogEntry} into a formatted string.
 */
export type LogFormatter = (entry: LogEntry) => string;

/**
 * Function signature for receiving and persisting or transmitting formatted log entries.
 */
export type LogSink = (entry: LogEntry, formattedMessage: string) => void;

/** Optional predicate for suppressing selected structured log entries. */
export type LogFilter = (entry: LogEntry) => boolean;

/** Bounded counters describing logger activity without retaining log payloads. */
export interface LogStats {
  attempted: number;
  emitted: number;
  suppressedByLevel: number;
  suppressedByFilter: number;
  emittedByLevel: Record<"DEBUG" | "INFO" | "WARN" | "ERROR", number>;
}

/**
 * Configuration options for initializing an {@link SdkLogger}.
 */
export interface LoggerOptions {
  /**
   * Minimum active severity level. Entries below this level are ignored.
   * Defaults to {@link LogLevel.NONE} unless explicitly enabled or configured via environment.
   */
  level?: LogLevel | LogLevelString;
  /**
   * Component namespace prefix. Defaults to "StellarSplit".
   */
  namespace?: string;
  /**
   * Custom sink for outputting logs. Defaults to console methods.
   */
  sink?: LogSink;
  /**
   * Optional predicate to suppress entries even when their level passes.
   */
  filter?: LogFilter;
  /**
   * Custom formatter for transforming log entries into strings.
   */
  formatter?: LogFormatter;
  /**
   * Whether to automatically sanitize and redact secret keys, private seeds, and credentials.
   * Defaults to true.
   */
  redactSensitive?: boolean;
  /**
   * Initial active enabled flag. If false, behaves as LogLevel.NONE.
   */
  enabled?: boolean;
  /**
   * Trace ID automatically attached to every entry emitted by this logger.
   * Used to scope a logger to a single top-level SDK operation.
   */
  traceId?: TraceId;
}

/**
 * Optional trace correlation ID attached to log entries emitted within a traced scope.
 * Populated by the SDK tracing layer (see src/tracing.ts) so that log lines can be
 * correlated across the steps of a single logical operation.
 */
export type TraceId = string;

/** Stellar secret key pattern (56 characters starting with 'S'). */
const STELLAR_SECRET_SEED_RE = /\bS[A-Z0-9]{55}\b/g;

/** Sensitive keys in context objects that should be redacted. */
const SENSITIVE_KEY_NAMES = new Set([
  "secret",
  "secretkey",
  "secret_key",
  "secretseed",
  "secret_seed",
  "privatekey",
  "private_key",
  "privkey",
  "password",
  "authorization",
  "auth_token",
  "token",
  "apikey",
  "api_key",
  "webhooksecret",
  "webhook_secret",
]);

/**
 * Redacts Stellar secret seeds and sensitive keys from log context.
 *
 * @param value - Any value to sanitize.
 * @returns The sanitized value safe for logging.
 */
export function sanitizeLogValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.replace(STELLAR_SECRET_SEED_RE, (match) => `${match.slice(0, 4)}...[REDACTED]`);
  }

  if (typeof value === "bigint") {
    return value.toString();
  }

  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message.replace(STELLAR_SECRET_SEED_RE, "S...[REDACTED]"),
      stack: value.stack?.replace(STELLAR_SECRET_SEED_RE, "S...[REDACTED]"),
    };
  }

  if (Array.isArray(value)) {
    return value.map((item) => sanitizeLogValue(item));
  }

  if (value !== null && typeof value === "object") {
    const sanitized: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (SENSITIVE_KEY_NAMES.has(k.toLowerCase())) {
        sanitized[k] = "[REDACTED]";
      } else {
        sanitized[k] = sanitizeLogValue(v);
      }
    }
    return sanitized;
  }

  return value;
}

/**
 * Default human-readable log formatter.
 *
 * Produces structured output:
 * `[2026-10-17T23:50:00.000Z] [DEBUG] [StellarSplitClient] Message {"foo":"bar"}`
 *
 * @param entry - The log entry to format.
 * @returns A formatted string.
 */
export function defaultLogFormatter(entry: LogEntry): string {
  let contextStr = "";
  if (entry.context && Object.keys(entry.context).length > 0) {
    try {
      contextStr = ` ${JSON.stringify(entry.context)}`;
    } catch {
      contextStr = " [Unserializable Context]";
    }
  }
  return `[${entry.isoTime}] [${entry.levelName}] [${entry.namespace}] ${entry.message}${contextStr}`;
}

/**
 * Default console sink that routes entries to standard console methods based on severity.
 *
 * @param entry - The log entry.
 * @param formattedMessage - Pre-formatted message string.
 */
export function defaultConsoleSink(entry: LogEntry, formattedMessage: string): void {
  switch (entry.level) {
    case LogLevel.DEBUG:
      if (typeof console.debug === "function") {
        console.debug(formattedMessage);
      } else {
        console.log(formattedMessage);
      }
      break;
    case LogLevel.INFO:
      if (typeof console.info === "function") {
        console.info(formattedMessage);
      } else {
        console.log(formattedMessage);
      }
      break;
    case LogLevel.WARN:
      console.warn(formattedMessage);
      break;
    case LogLevel.ERROR:
      console.error(formattedMessage);
      break;
    default:
      break;
  }
}

/**
 * Public logger contract implemented by {@link SdkLogger}.
 */
export interface Logger {
  /** Log a message at DEBUG severity. */
  debug(message: string, context?: Record<string, unknown>): void;
  /** Log a message at INFO severity. */
  info(message: string, context?: Record<string, unknown>): void;
  /** Log a message at WARN severity. */
  warn(message: string, context?: Record<string, unknown>): void;
  /** Log a message at ERROR severity. */
  error(message: string, context?: Record<string, unknown>): void;
  /** Update current minimum active severity level. */
  setLevel(level: LogLevel | LogLevelString): void;
  /** Retrieve the current active severity level. */
  getLevel(): LogLevel;
  /** Check if messages at the given level will be emitted. */
  isEnabled(level: LogLevel | LogLevelString): boolean;
  /** Create a child logger sharing the same configuration under an appended namespace. */
  child(subNamespace: string): Logger;
  /** Return counters for emitted and suppressed entries without retaining content. */
  getStats?(): LogStats;
  /** Reset counters collected by this logger. */
  resetStats?(): void;
}

/**
 * Primary logger implementation for the StellarSplit SDK.
 *
 * @example
 * ```typescript
 * const logger = new SdkLogger({
 *   level: LogLevel.DEBUG,
 *   namespace: "MySplitApp",
 * });
 *
 * logger.debug("Initializing payment", { invoiceId: "123" });
 * ```
 */
export class SdkLogger implements Logger {
  private level: LogLevel;
  private namespace: string;
  private sink: LogSink;
  private formatter: LogFormatter;
  private redactSensitive: boolean;
  private filter?: LogFilter;
  private stats: LogStats = {
    attempted: 0,
    emitted: 0,
    suppressedByLevel: 0,
    suppressedByFilter: 0,
    emittedByLevel: { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 },
  };

  constructor(options: LoggerOptions = {}) {
    let resolvedLevel = LogLevel.NONE;

    if (options.enabled === false) {
      resolvedLevel = LogLevel.NONE;
    } else if (options.level !== undefined) {
      resolvedLevel = parseLogLevel(options.level);
    } else if (typeof process !== "undefined" && process?.env) {
      const envLevel = process.env.SPLIT_SDK_LOG_LEVEL || (process.env.DEBUG?.includes("stellar-split") ? "debug" : undefined);
      if (envLevel) {
        resolvedLevel = parseLogLevel(envLevel as LogLevelString);
      }
    }

    this.level = resolvedLevel;
    this.namespace = options.namespace || "StellarSplit";
    this.sink = options.sink || defaultConsoleSink;
    this.formatter = options.formatter || defaultLogFormatter;
    this.redactSensitive = options.redactSensitive ?? true;
    this.filter = options.filter;
  }

  /**
   * Checks whether logging is enabled for the specified level.
   *
   * @param level - The level to test.
   * @returns True if the logger will emit for this level.
   */
  public isEnabled(level: LogLevel | LogLevelString): boolean {
    const numericLevel = parseLogLevel(level);
    if (numericLevel === LogLevel.NONE || this.level === LogLevel.NONE) {
      return false;
    }
    return numericLevel >= this.level;
  }

  /**
   * Retrieves the current logging level.
   *
   * @returns The active {@link LogLevel}.
   */
  public getLevel(): LogLevel {
    return this.level;
  }

  /**
   * Changes the minimum active logging level.
   *
   * @param level - The new level.
   */
  public setLevel(level: LogLevel | LogLevelString): void {
    this.level = parseLogLevel(level);
  }

  /**
   * Updates the output sink.
   *
   * @param sink - The new log sink function.
   */
  public setSink(sink: LogSink): void {
    this.sink = sink;
  }

  /**
   * Updates the log message formatter.
   *
   * @param formatter - The new formatter function.
   */
  public setFormatter(formatter: LogFormatter): void {
    this.formatter = formatter;
  }

  /**
   * Creates a child logger with an extended namespace.
   *
   * @param subNamespace - Additional namespace suffix to append.
   * @returns A new child {@link Logger}.
   */
  public child(subNamespace: string): Logger {
    return new SdkLogger({
      level: this.level,
      namespace: `${this.namespace}:${subNamespace}`,
      sink: this.sink,
      formatter: this.formatter,
      redactSensitive: this.redactSensitive,
      filter: this.filter,
    });
  }

  public getStats(): LogStats {
    return {
      ...this.stats,
      emittedByLevel: { ...this.stats.emittedByLevel },
    };
  }

  public resetStats(): void {
    this.stats = {
      attempted: 0,
      emitted: 0,
      suppressedByLevel: 0,
      suppressedByFilter: 0,
      emittedByLevel: { DEBUG: 0, INFO: 0, WARN: 0, ERROR: 0 },
    };
  }

  /**
   * Emits a message at {@link LogLevel.DEBUG}.
   *
   * @param message - The log message.
   * @param context - Optional context properties.
   */
  public debug(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.DEBUG, message, context);
  }

  /**
   * Emits a message at {@link LogLevel.INFO}.
   *
   * @param message - The log message.
   * @param context - Optional context properties.
   */
  public info(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.INFO, message, context);
  }

  /**
   * Emits a message at {@link LogLevel.WARN}.
   *
   * @param message - The log message.
   * @param context - Optional context properties.
   */
  public warn(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.WARN, message, context);
  }

  /**
   * Emits a message at {@link LogLevel.ERROR}.
   *
   * @param message - The log message.
   * @param context - Optional context properties.
   */
  public error(message: string, context?: Record<string, unknown>): void {
    this.log(LogLevel.ERROR, message, context);
  }

  /**
   * Internal dispatcher for logging an entry.
   */
  private log(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    this.stats.attempted++;
    if (!this.isEnabled(level)) {
      this.stats.suppressedByLevel++;
      return;
    }

    const now = Date.now();
    const sanitizedContext = context && this.redactSensitive
      ? (sanitizeLogValue(context) as Record<string, unknown>)
      : context;

    const entry: LogEntry = {
      timestamp: now,
      isoTime: new Date(now).toISOString(),
      level,
      levelName: logLevelToString(level) as "DEBUG" | "INFO" | "WARN" | "ERROR",
      namespace: this.namespace,
      message: this.redactSensitive && typeof message === "string"
        ? (sanitizeLogValue(message) as string)
        : message,
      context: sanitizedContext,
    };

    if (this.filter && !this.filter(entry)) {
      this.stats.suppressedByFilter++;
      return;
    }

    this.stats.emitted++;
    this.stats.emittedByLevel[entry.levelName]++;

    try {
      const formatted = this.formatter(entry);
      this.sink(entry, formatted);
    } catch {
      // Sinks or formatters must never throw into business logic.
    }
  }
}
