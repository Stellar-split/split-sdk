/**
 * Input sanitization helpers for {@link SplitClient}.
 *
 * Strips control characters and enforces a maximum length on free-form
 * strings, and records an audit trail of what was sanitized where.
 */

export interface SanitizationRuleSet {
  /** Maximum allowed length for a sanitized string. Defaults to 4096. */
  maxStringLength?: number;
  /** Regex of characters to strip from strings. Defaults to control chars. */
  stripPattern?: RegExp;
}

export interface SanitizationLogEntry {
  context: string;
  timestamp: number;
  truncated: boolean;
  stripped: boolean;
}

/** Bounded audit trail of sanitization actions. */
export class SanitizationTracker {
  private readonly entries: SanitizationLogEntry[] = [];
  private readonly maxEntries: number;

  constructor(maxEntries = 1000) {
    this.maxEntries = maxEntries;
  }

  record(entry: SanitizationLogEntry): void {
    this.entries.push(entry);
    if (this.entries.length > this.maxEntries) {
      this.entries.splice(0, this.entries.length - this.maxEntries);
    }
  }

  getEntries(): ReadonlyArray<SanitizationLogEntry> {
    return [...this.entries];
  }
}

const DEFAULT_MAX_STRING_LENGTH = 4096;
const DEFAULT_STRIP_PATTERN = /[\u0000-\u001f\u007f]/g;

export class InputSanitizer {
  private readonly maxStringLength: number;
  private readonly stripPattern: RegExp;
  private readonly tracker?: SanitizationTracker;

  constructor(ruleSet?: SanitizationRuleSet, tracker?: SanitizationTracker) {
    this.maxStringLength = ruleSet?.maxStringLength ?? DEFAULT_MAX_STRING_LENGTH;
    this.stripPattern = ruleSet?.stripPattern ?? DEFAULT_STRIP_PATTERN;
    this.tracker = tracker;
  }

  /** Strip control characters and enforce a max length on a string input. */
  sanitizeString(value: string, context: string): string {
    const stripped = value.replace(this.stripPattern, "");
    const truncated = stripped.length > this.maxStringLength;
    const result = truncated ? stripped.slice(0, this.maxStringLength) : stripped;

    this.tracker?.record({
      context,
      timestamp: Date.now(),
      truncated,
      stripped: stripped.length !== value.length,
    });

    return result;
  }

  /**
   * Sanitize an arbitrary transaction-shaped payload before it's sent to
   * the RPC: recursively sanitizes its string fields, leaving binary and
   * numeric data untouched.
   */
  sanitizeTransaction<T>(tx: T, context: string): T {
    return this._sanitizeValue(tx, context) as T;
  }

  private _sanitizeValue(value: unknown, context: string): unknown {
    if (typeof value === "string") {
      return this.sanitizeString(value, context);
    }
    if (Array.isArray(value)) {
      return value.map((item) => this._sanitizeValue(item, context));
    }
    if (value && typeof value === "object" && !(value instanceof Uint8Array)) {
      const out: Record<string, unknown> = {};
      for (const [key, val] of Object.entries(value)) {
        out[key] = this._sanitizeValue(val, context);
      }
      return out;
    }
    return value;
  }
}
