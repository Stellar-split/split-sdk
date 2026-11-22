/**
 * Error Context Management System for StellarSplit SDK.
 * Attaches rich, structured, serializable metadata to errors with sanitization and helpers.
 *
 * Issue #1071 — Implement error context
 */

import { StellarSplitError } from "./errors.js";
import { type Breadcrumb, getDefaultBreadcrumbTracker } from "./breadcrumbTracker.js";

/** Symbol used to safely attach context to arbitrary Error objects. */
export const ERROR_CONTEXT_SYMBOL = Symbol.for("stellarsplit.errorContext");

/**
 * Structured contextual information attached to errors.
 */
export interface ErrorContext {
  /** High-level operation during which the error occurred (e.g. 'pay', 'createInvoice'). */
  operation?: string;
  /** On-chain invoice identifier if applicable. */
  invoiceId?: string;
  /** Stellar account public key (G-address) if applicable. */
  accountId?: string;
  /** Stellar network name (e.g. 'testnet', 'public', 'futurenet', 'standalone'). */
  network?: string;
  /** Contract address (C-address) if applicable. */
  contractId?: string;
  /** Transaction hash or XDR reference. */
  transactionHash?: string;
  /** Timestamp when the context was attached. */
  timestamp?: number;
  /** Categorical key-value tags. */
  tags?: Record<string, string>;
  /** Breadcrumb trail leading up to the error. */
  breadcrumbs?: Breadcrumb[];
  /** Arbitrary domain-specific metadata. */
  extra?: Record<string, unknown>;
  /** Additional dynamic properties. */
  [key: string]: unknown;
}

/** Plain JSON-serializable representation of an error. */
export interface SerializedError {
  /** Error class name. */
  name: string;
  /** Error message. */
  message: string;
  /** Machine-readable error code if present. */
  code?: string;
  /** Stack trace if available. */
  stack?: string;
  /** Soroban / RPC raw response if available. */
  raw?: string;
  /** Attached sanitized error context. */
  context?: Record<string, unknown>;
  /** Nested cause error if supported. */
  cause?: unknown;
  /** Timestamp of serialization. */
  timestamp: number;
}

/** Query options for the bounded in-memory context store. */
export interface ErrorContextQuery {
  operation?: string;
  invoiceId?: string;
  accountId?: string;
  since?: number;
  limit?: number;
}

/** A sanitized, serializable error captured for diagnostic queries. */
export interface StoredErrorContext {
  id: number;
  error: SerializedError;
  context: ErrorContext;
}

/** Regex matching Stellar secret seed keys (S-addresses, 56 characters). */
const STELLAR_SECRET_SEED_REGEX = /\bS[A-Z0-9]{55}\b/g;

/** Keys that typically hold secret or sensitive credential data. */
const SENSITIVE_KEY_PATTERNS = [
  /password/i,
  /secret/i,
  /seed/i,
  /private[_-]?key/i,
  /api[_-]?key/i,
  /token/i,
  /authorization/i,
  /auth[_-]?header/i,
  /bearer/i,
];

/**
 * Recursively sanitizes context data by masking secret keys, tokens, and passwords.
 * Handles circular references and converts BigInt values safely.
 */
export function sanitizeContext<T = Record<string, unknown>>(
  input: T,
  seen: WeakSet<object> = new WeakSet()
): T {
  if (input === null || input === undefined) {
    return input;
  }

  // Handle BigInt
  if (typeof input === "bigint") {
    return (input as bigint).toString() as unknown as T;
  }

  // Handle Strings with embedded secret seeds
  if (typeof input === "string") {
    return input.replace(STELLAR_SECRET_SEED_REGEX, "S***[MASKED]") as unknown as T;
  }

  // Handle Primitives
  if (typeof input !== "object") {
    return input;
  }

  // Prevent Circular Loops
  if (seen.has(input as object)) {
    return "[Circular]" as unknown as T;
  }
  seen.add(input as object);

  // Handle Arrays
  if (Array.isArray(input)) {
    return input.map((item) => sanitizeContext(item, seen)) as unknown as T;
  }

  // Handle Plain Objects
  const sanitizedObj: Record<string, unknown> = {};
  for (const [key, val] of Object.entries(input as Record<string, unknown>)) {
    const isSensitive = SENSITIVE_KEY_PATTERNS.some((pattern) => pattern.test(key));
    if (isSensitive) {
      sanitizedObj[key] = "***MASKED***";
    } else {
      sanitizedObj[key] = sanitizeContext(val, seen);
    }
  }

  return sanitizedObj as unknown as T;
}

/**
 * Merges two partial ErrorContext objects into a single cohesive ErrorContext.
 */
export function mergeContext(
  base: Partial<ErrorContext> = {},
  overlay: Partial<ErrorContext> = {}
): ErrorContext {
  const merged: ErrorContext = {
    ...base,
    ...overlay,
  };

  // Merge tags
  if (base.tags || overlay.tags) {
    merged.tags = {
      ...(base.tags || {}),
      ...(overlay.tags || {}),
    };
  }

  // Merge extra
  if (base.extra || overlay.extra) {
    merged.extra = {
      ...(base.extra || {}),
      ...(overlay.extra || {}),
    };
  }

  // Merge breadcrumbs deduplicating by ID
  if (base.breadcrumbs || overlay.breadcrumbs) {
    const baseCrumbs = base.breadcrumbs || [];
    const overlayCrumbs = overlay.breadcrumbs || [];
    const seenIds = new Set<string>();
    const combinedCrumbs: Breadcrumb[] = [];

    for (const c of [...baseCrumbs, ...overlayCrumbs]) {
      if (!seenIds.has(c.id)) {
        seenIds.add(c.id);
        combinedCrumbs.push(c);
      }
    }
    merged.breadcrumbs = combinedCrumbs;
  }

  return merged;
}

/**
 * Attaches contextual information to an error instance.
 * Merges with any existing context and sanitizes sensitive fields.
 */
export function attachErrorContext<T extends Error>(
  error: T,
  context: Partial<ErrorContext>
): T {
  if (!error || typeof error !== "object") {
    return error;
  }

  const existingContext = getErrorContext(error) || {};
  const merged = mergeContext(existingContext, {
    timestamp: Date.now(),
    ...context,
  });

  const sanitized = sanitizeContext(merged);

  // Attach to error.context (used by StellarSplitError and standard convention)
  try {
    Object.defineProperty(error, "context", {
      value: sanitized,
      writable: true,
      enumerable: true,
      configurable: true,
    });
  } catch {
    (error as unknown as { context: unknown }).context = sanitized;
  }

  // Also attach to symbol for safe reflection
  try {
    (error as unknown as Record<symbol, unknown>)[ERROR_CONTEXT_SYMBOL] = sanitized;
  } catch {
    // Ignore if object is frozen
  }

  return error;
}

/**
 * Extracts attached ErrorContext from an error or object.
 */
export function getErrorContext(error: unknown): ErrorContext | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const errObj = error as Record<symbol | string, unknown>;
  if (errObj[ERROR_CONTEXT_SYMBOL]) {
    return errObj[ERROR_CONTEXT_SYMBOL] as ErrorContext;
  }

  if (errObj.context && typeof errObj.context === "object") {
    return errObj.context as ErrorContext;
  }

  return undefined;
}

/**
 * Checks if an error has attached error context.
 */
export function hasErrorContext(error: unknown): boolean {
  return getErrorContext(error) !== undefined;
}

/**
 * Converts any Error or thrown object into a pure, JSON-safe SerializedError.
 * Converts BigInt to strings and handles circular references safely.
 */
export function serializeError(error: unknown): SerializedError {
  const timestamp = Date.now();

  if (error instanceof StellarSplitError) {
    return {
      name: error.name,
      message: error.message,
      code: error.code,
      stack: error.stack,
      raw: error.raw,
      context: error.context ? sanitizeContext(error.context) : undefined,
      timestamp,
    };
  }

  if (error instanceof Error) {
    const context = getErrorContext(error);
    const code = (error as { code?: string }).code;
    const cause = (error as { cause?: unknown }).cause;

    return {
      name: error.name || "Error",
      message: error.message || "",
      code,
      stack: error.stack,
      context: context ? sanitizeContext(context) : undefined,
      cause: cause ? String(cause) : undefined,
      timestamp,
    };
  }

  if (typeof error === "object" && error !== null) {
    const safeObj = sanitizeContext(error as Record<string, unknown>);
    return {
      name: "ObjectError",
      message: (error as { message?: string }).message || "Non-Error object thrown",
      context: safeObj,
      timestamp,
    };
  }

  return {
    name: "PrimitiveError",
    message: String(error),
    timestamp,
  };
}

/**
 * Serializes an ErrorContext safely to JSON string.
 */
export function serializeErrorContext(context: ErrorContext): string {
  const sanitized = sanitizeContext(context);
  const seen = new WeakSet();
  return JSON.stringify(sanitized, (_key, val) => {
    if (typeof val === "bigint") {
      return val.toString();
    }
    if (typeof val === "object" && val !== null) {
      if (seen.has(val)) return "[Circular]";
      seen.add(val);
    }
    return val;
  });
}

/**
 * Fluent builder for constructing and attaching rich error context.
 */
export class ErrorContextBuilder {
  private context: Partial<ErrorContext> = {};

  constructor(initial?: Partial<ErrorContext>) {
    if (initial) {
      this.context = { ...initial };
    }
  }

  withOperation(operation: string): this {
    this.context.operation = operation;
    return this;
  }

  withInvoiceId(invoiceId: string): this {
    this.context.invoiceId = invoiceId;
    return this;
  }

  withAccountId(accountId: string): this {
    this.context.accountId = accountId;
    return this;
  }

  withNetwork(network: string): this {
    this.context.network = network;
    return this;
  }

  withContractId(contractId: string): this {
    this.context.contractId = contractId;
    return this;
  }

  withTransactionHash(transactionHash: string): this {
    this.context.transactionHash = transactionHash;
    return this;
  }

  withTag(key: string, value: string): this {
    this.context.tags = {
      ...(this.context.tags || {}),
      [key]: value,
    };
    return this;
  }

  withTags(tags: Record<string, string>): this {
    this.context.tags = {
      ...(this.context.tags || {}),
      ...tags,
    };
    return this;
  }

  withExtra(key: string, value: unknown): this {
    this.context.extra = {
      ...(this.context.extra || {}),
      [key]: value,
    };
    return this;
  }

  withBreadcrumbs(breadcrumbs: Breadcrumb[]): this {
    this.context.breadcrumbs = [...breadcrumbs];
    return this;
  }

  /**
   * Automatically captures a snapshot of current breadcrumbs from the active tracker.
   */
  includeCurrentBreadcrumbs(limit: number = 20): this {
    const tracker = getDefaultBreadcrumbTracker();
    const crumbs = tracker.getBreadcrumbs({ limit });
    return this.withBreadcrumbs(crumbs);
  }

  /**
   * Builds the finalized ErrorContext object.
   */
  build(): ErrorContext {
    return {
      timestamp: Date.now(),
      ...this.context,
    };
  }

  /**
   * Directly attaches the built context to an Error instance.
   */
  attachTo<T extends Error>(error: T): T {
    return attachErrorContext(error, this.build());
  }

  /**
   * Wraps a function execution with this context.
   */
  wrap<T>(fn: () => T): T {
    return withErrorContext(this.build(), fn);
  }
}

/**
 * Creates a new ErrorContextBuilder instance.
 */
export function createErrorContext(initial?: Partial<ErrorContext>): ErrorContextBuilder {
  return new ErrorContextBuilder(initial);
}

/**
 * Executes a sync or async function, intercepting any errors to attach contextual metadata before rethrowing.
 */
export function withErrorContext<T>(
  context: Partial<ErrorContext>,
  fn: () => T
): T {
  try {
    const result = fn();
    if (result && typeof (result as unknown as Promise<unknown>).then === "function") {
      return (result as unknown as Promise<unknown>).catch((err: unknown) => {
        if (err instanceof Error) {
          attachErrorContext(err, context);
        }
        throw err;
      }) as unknown as T;
    }
    return result;
  } catch (err) {
    if (err instanceof Error) {
      attachErrorContext(err, context);
    }
    throw err;
  }
}

/**
 * Wraps an unknown error into a StellarSplitError with attached context and message.
 */
export function wrapError(
  error: unknown,
  message: string,
  context?: Partial<ErrorContext>
): StellarSplitError {
  const mergedContext = mergeContext(
    getErrorContext(error) || {},
    context || {}
  );

  const raw = error instanceof Error ? error.stack || error.message : String(error);
  const code = error instanceof StellarSplitError
    ? error.code
    : (error as { code?: string })?.code || "WRAPPED_ERROR";

  const wrapped = new StellarSplitError(
    `${message}: ${error instanceof Error ? error.message : String(error)}`,
    code,
    sanitizeContext(mergedContext),
    raw
  );

  return attachErrorContext(wrapped, mergedContext);
}

/**
 * Bounded in-memory index of sanitized error contexts. It indexes common
 * query dimensions so callers can inspect a failing operation or invoice
 * without retaining raw errors, private keys, or arbitrary object graphs.
 */
export class ErrorContextStore {
  private readonly entries: StoredErrorContext[] = [];
  private readonly byOperation = new Map<string, Set<number>>();
  private readonly byInvoiceId = new Map<string, Set<number>>();
  private nextId = 1;

  constructor(private readonly maxEntries: number = 500) {}

  capture(error: unknown, additionalContext: Partial<ErrorContext> = {}): StoredErrorContext {
    const serialized = serializeError(error);
    const context = sanitizeContext(mergeContext(getErrorContext(error) ?? {}, additionalContext));
    const entry: StoredErrorContext = { id: this.nextId++, error: { ...serialized, context }, context };
    this.entries.push(entry);
    this.index(entry);

    while (this.entries.length > this.maxEntries) {
      this.removeFromIndex(this.entries.shift()!);
    }
    return entry;
  }

  query(query: ErrorContextQuery = {}): StoredErrorContext[] {
    const indexed = query.operation
      ? this.byOperation.get(query.operation)
      : query.invoiceId
        ? this.byInvoiceId.get(query.invoiceId)
        : undefined;
    const candidates = indexed
      ? this.entries.filter((entry) => indexed.has(entry.id))
      : this.entries;
    const result = candidates.filter((entry) =>
      (!query.operation || entry.context.operation === query.operation) &&
      (!query.invoiceId || entry.context.invoiceId === query.invoiceId) &&
      (!query.accountId || entry.context.accountId === query.accountId) &&
      (!query.since || (entry.context.timestamp ?? entry.error.timestamp) >= query.since!),
    );
    const limit = query.limit && query.limit > 0 ? query.limit : result.length;
    return result.slice(-limit).reverse();
  }

  size(): number {
    return this.entries.length;
  }

  clear(): void {
    this.entries.length = 0;
    this.byOperation.clear();
    this.byInvoiceId.clear();
  }

  private index(entry: StoredErrorContext): void {
    this.addIndex(this.byOperation, entry.context.operation, entry.id);
    this.addIndex(this.byInvoiceId, entry.context.invoiceId, entry.id);
  }

  private removeFromIndex(entry: StoredErrorContext): void {
    this.deleteIndex(this.byOperation, entry.context.operation, entry.id);
    this.deleteIndex(this.byInvoiceId, entry.context.invoiceId, entry.id);
  }

  private addIndex(index: Map<string, Set<number>>, key: string | undefined, id: number): void {
    if (!key) return;
    const entries = index.get(key) ?? new Set<number>();
    entries.add(id);
    index.set(key, entries);
  }

  private deleteIndex(index: Map<string, Set<number>>, key: string | undefined, id: number): void {
    if (!key) return;
    const entries = index.get(key);
    if (!entries) return;
    entries.delete(id);
    if (entries.size === 0) index.delete(key);
  }
}
