export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

const LEVEL_ORDER: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context: Record<string, unknown>;
  metadata?: Record<string, unknown>;
}

export interface LogFilter {
  minLevel?: LogLevel;
  levels?: LogLevel[];
  context?: Record<string, unknown>;
  messageIncludes?: string;
  since?: string;
  until?: string;
}

export interface LogAnalytics {
  total: number;
  byLevel: Record<LogLevel, number>;
  firstTimestamp: string | null;
  lastTimestamp: string | null;
}

export interface LoggerOptions {
  minLevel?: LogLevel;
  context?: Record<string, unknown>;
  sink?: (entry: LogEntry) => void;
  bufferSize?: number;
}

function matchesContext(entryContext: Record<string, unknown>, filter: Record<string, unknown>): boolean {
  return Object.keys(filter).every((key) => entryContext[key] === filter[key]);
}

export class LogAggregator {
  private entries: LogEntry[] = [];
  private readonly bufferSize: number;

  constructor(bufferSize = 1000) {
    this.bufferSize = bufferSize;
  }

  add(entry: LogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.bufferSize) {
      this.entries.splice(0, this.entries.length - this.bufferSize);
    }
  }

  all(): LogEntry[] {
    return [...this.entries];
  }

  filter(criteria: LogFilter): LogEntry[] {
    return this.entries.filter((entry) => {
      if (criteria.minLevel && LEVEL_ORDER[entry.level] < LEVEL_ORDER[criteria.minLevel]) {
        return false;
      }
      if (criteria.levels && !criteria.levels.includes(entry.level)) {
        return false;
      }
      if (criteria.context && !matchesContext(entry.context, criteria.context)) {
        return false;
      }
      if (criteria.messageIncludes && !entry.message.includes(criteria.messageIncludes)) {
        return false;
      }
      if (criteria.since && entry.timestamp < criteria.since) {
        return false;
      }
      if (criteria.until && entry.timestamp > criteria.until) {
        return false;
      }
      return true;
    });
  }

  analytics(): LogAnalytics {
    const byLevel: Record<LogLevel, number> = { debug: 0, info: 0, warn: 0, error: 0 };
    for (const entry of this.entries) {
      byLevel[entry.level] += 1;
    }
    return {
      total: this.entries.length,
      byLevel,
      firstTimestamp: this.entries.length > 0 ? this.entries[0]!.timestamp : null,
      lastTimestamp: this.entries.length > 0 ? this.entries[this.entries.length - 1]!.timestamp : null,
    };
  }

  clear(): void {
    this.entries = [];
  }
}

export class Logger {
  private readonly minLevel: LogLevel;
  private readonly context: Record<string, unknown>;
  private readonly sink?: (entry: LogEntry) => void;
  private readonly aggregator: LogAggregator;

  constructor(options: LoggerOptions = {}) {
    this.minLevel = options.minLevel ?? 'info';
    this.context = options.context ?? {};
    this.sink = options.sink;
    this.aggregator = new LogAggregator(options.bufferSize);
  }

  withContext(context: Record<string, unknown>): Logger {
    return new Logger({
      minLevel: this.minLevel,
      context: { ...this.context, ...context },
      sink: this.sink,
    });
  }

  getAggregator(): LogAggregator {
    return this.aggregator;
  }

  private log(level: LogLevel, message: string, metadata?: Record<string, unknown>): void {
    if (LEVEL_ORDER[level] < LEVEL_ORDER[this.minLevel]) {
      return;
    }
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context: { ...this.context },
      metadata,
    };
    this.aggregator.add(entry);
    if (this.sink) {
      this.sink(entry);
    }
  }

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.log('debug', message, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.log('info', message, metadata);
  }

  warn(message: string, metadata?: Record<string, unknown>): void {
    this.log('warn', message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    this.log('error', message, metadata);
  }
}

export function createLogger(options?: LoggerOptions): Logger {
  return new Logger(options);
}
