/**
 * Breadcrumb tracking system for recording event history leading up to errors.
 * Provides storage-efficient bounded ring buffers and fast retrieval with rich context.
 *
 * Issue #1070 — Add breadcrumb tracking
 */

/** Category of breadcrumb event. */
export type BreadcrumbCategory =
  | "http"
  | "rpc"
  | "transaction"
  | "auth"
  | "ui"
  | "state"
  | "navigation"
  | "error"
  | "custom"
  | (string & {});

/** Severity level for breadcrumb. */
export type BreadcrumbLevel = "debug" | "info" | "warn" | "error" | "fatal";

/** Individual breadcrumb item representing a discreet event. */
export interface Breadcrumb {
  /** Unique sequential or UUID identifier. */
  id: string;
  /** Timestamp in milliseconds since Unix epoch. */
  timestamp: number;
  /** Category classifying the breadcrumb. */
  category: BreadcrumbCategory;
  /** Human-readable event description. */
  message: string;
  /** Optional severity level. */
  level?: BreadcrumbLevel;
  /** Rich contextual payload associated with the event. */
  data?: Record<string, unknown>;
}

/** Storage backend contract for breadcrumb items. */
export interface BreadcrumbStorage {
  /** Appends a breadcrumb to storage. */
  add(crumb: Breadcrumb): void;
  /** Returns all stored breadcrumbs in chronological order. */
  getAll(): Breadcrumb[];
  /** Clears all stored breadcrumbs. */
  clear(): void;
  /** Returns the current count of stored breadcrumbs. */
  size(): number;
}

/**
 * Storage-efficient circular ring buffer for breadcrumbs.
 * Fixed maximum capacity prevents unbounded memory growth in long-running processes.
 */
export class RingBufferBreadcrumbStorage implements BreadcrumbStorage {
  private readonly capacity: number;
  private buffer: (Breadcrumb | undefined)[];
  private head: number = 0; // insertion pointer
  private length: number = 0;

  constructor(capacity: number = 100) {
    this.capacity = Math.max(1, capacity);
    this.buffer = new Array<Breadcrumb | undefined>(this.capacity);
  }

  add(crumb: Breadcrumb): void {
    this.buffer[this.head] = crumb;
    this.head = (this.head + 1) % this.capacity;
    if (this.length < this.capacity) {
      this.length++;
    }
  }

  getAll(): Breadcrumb[] {
    const result = new Array<Breadcrumb>(this.length);
    if (this.length < this.capacity) {
      // Buffer hasn't wrapped yet: items are from 0 to length - 1
      for (let i = 0; i < this.length; i++) {
        result[i] = this.buffer[i]!;
      }
    } else {
      // Buffer has wrapped: oldest item is at head
      for (let i = 0; i < this.capacity; i++) {
        const index = (this.head + i) % this.capacity;
        result[i] = this.buffer[index]!;
      }
    }
    return result;
  }

  clear(): void {
    this.buffer = new Array<Breadcrumb | undefined>(this.capacity);
    this.head = 0;
    this.length = 0;
  }

  size(): number {
    return this.length;
  }
}

/**
 * Aggregate statistics over all stored breadcrumbs.
 * Useful for dashboards and debugging summaries.
 */
export interface BreadcrumbStats {
  /** Total number of breadcrumbs currently stored. */
  total: number;
  /** Count of breadcrumbs per category. */
  byCategory: Record<string, number>;
  /** Count of breadcrumbs per level. */
  byLevel: Record<BreadcrumbLevel, number>;
  /** Timestamp of the oldest breadcrumb, or undefined when empty. */
  oldestTimestamp: number | undefined;
  /** Timestamp of the newest breadcrumb, or undefined when empty. */
  newestTimestamp: number | undefined;
  /** Time span in milliseconds between oldest and newest, or 0 when fewer than two items. */
  spanMs: number;
}

/** Filter criteria for retrieving breadcrumbs. */
export interface BreadcrumbFilter {
  /** Filter by category or array of categories. */
  category?: BreadcrumbCategory | BreadcrumbCategory[];
  /** Filter by specific level. */
  level?: BreadcrumbLevel;
  /** Filter events on or after timestamp. */
  since?: number;
  /** Filter events on or before timestamp. */
  until?: number;
  /** Maximum number of latest breadcrumbs to return. */
  limit?: number;
}

/** Configuration options for BreadcrumbTracker. */
export interface BreadcrumbTrackerOptions {
  /** Maximum number of breadcrumbs to retain. Defaults to 100. */
  maxBreadcrumbs?: number;
  /** Custom storage backend. Defaults to RingBufferBreadcrumbStorage. */
  storage?: BreadcrumbStorage;
  /** Optional pre-insert sanitizer/filter hook. Return null to discard breadcrumb. */
  beforeAddBreadcrumb?: (crumb: Breadcrumb) => Breadcrumb | null;
}

/**
 * BreadcrumbTracker manages and retains an event trail leading up to errors.
 */
export class BreadcrumbTracker {
  private readonly storage: BreadcrumbStorage;
  private readonly beforeAddBreadcrumb?: (crumb: Breadcrumb) => Breadcrumb | null;
  private counter: number = 0;

  constructor(options: BreadcrumbTrackerOptions = {}) {
    const maxBreadcrumbs = options.maxBreadcrumbs ?? 100;
    this.storage = options.storage ?? new RingBufferBreadcrumbStorage(maxBreadcrumbs);
    this.beforeAddBreadcrumb = options.beforeAddBreadcrumb;
  }

  /**
   * Adds a new breadcrumb.
   */
  addBreadcrumb(crumb: {
    category?: BreadcrumbCategory;
    message: string;
    level?: BreadcrumbLevel;
    data?: Record<string, unknown>;
    timestamp?: number;
    id?: string;
  }): Breadcrumb | null {
    this.counter++;
    const fullCrumb: Breadcrumb = {
      id: crumb.id ?? `bc-${Date.now()}-${this.counter}`,
      timestamp: crumb.timestamp ?? Date.now(),
      category: crumb.category ?? "custom",
      message: crumb.message,
      level: crumb.level ?? "info",
      data: crumb.data ? { ...crumb.data } : undefined,
    };

    const finalCrumb = this.beforeAddBreadcrumb ? this.beforeAddBreadcrumb(fullCrumb) : fullCrumb;
    if (!finalCrumb) {
      return null;
    }

    this.storage.add(finalCrumb);
    return finalCrumb;
  }

  /** Helper to track HTTP requests and responses. */
  trackHttp(
    method: string,
    url: string,
    status?: number,
    durationMs?: number,
    extra?: Record<string, unknown>
  ): Breadcrumb | null {
    return this.addBreadcrumb({
      category: "http",
      message: `${method.toUpperCase()} ${url} ${status !== undefined ? `[${status}]` : ""}`.trim(),
      level: status && status >= 400 ? "warn" : "info",
      data: {
        method,
        url,
        status,
        durationMs,
        ...extra,
      },
    });
  }

  /** Helper to track Stellar transactions. */
  trackTransaction(
    txHashOrXdr: string,
    operation: string,
    status: "pending" | "submitted" | "success" | "failed",
    extra?: Record<string, unknown>
  ): Breadcrumb | null {
    return this.addBreadcrumb({
      category: "transaction",
      message: `Transaction ${operation}: ${status}`,
      level: status === "failed" ? "error" : "info",
      data: {
        txHashOrXdr,
        operation,
        status,
        ...extra,
      },
    });
  }

  /** Helper to track Soroban / Horizon RPC calls. */
  trackRpc(
    method: string,
    endpoint?: string,
    status?: "pending" | "success" | "failed",
    durationMs?: number,
    extra?: Record<string, unknown>
  ): Breadcrumb | null {
    return this.addBreadcrumb({
      category: "rpc",
      message: `RPC ${method} ${status ? `(${status})` : ""}`.trim(),
      level: status === "failed" ? "warn" : "info",
      data: {
        method,
        endpoint,
        status,
        durationMs,
        ...extra,
      },
    });
  }

  /** Helper to track state changes in invoices or contracts. */
  trackStateChange(
    fromState: string,
    toState: string,
    entityId?: string,
    extra?: Record<string, unknown>
  ): Breadcrumb | null {
    return this.addBreadcrumb({
      category: "state",
      message: `State changed: ${fromState} -> ${toState}${entityId ? ` (${entityId})` : ""}`,
      level: "info",
      data: {
        fromState,
        toState,
        entityId,
        ...extra,
      },
    });
  }

  /** Helper to track UI or caller user actions. */
  trackUserAction(action: string, extra?: Record<string, unknown>): Breadcrumb | null {
    return this.addBreadcrumb({
      category: "ui",
      message: `User action: ${action}`,
      level: "info",
      data: { action, ...extra },
    });
  }

  /** Helper to record caught or handled errors as breadcrumbs. */
  trackError(error: unknown, extra?: Record<string, unknown>): Breadcrumb | null {
    const message = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
    return this.addBreadcrumb({
      category: "error",
      message: `Handled error: ${message}`,
      level: "error",
      data: {
        errorType: error instanceof Error ? error.name : typeof error,
        ...extra,
      },
    });
  }

  /**
   * Retrieves stored breadcrumbs, optionally applying filters.
   * Retrieval is fast and returns a fresh copy of the array.
   */
  getBreadcrumbs(filter?: BreadcrumbFilter): Breadcrumb[] {
    let crumbs = this.storage.getAll();

    if (!filter) {
      return crumbs;
    }

    if (filter.category) {
      if (Array.isArray(filter.category)) {
        const catSet = new Set(filter.category);
        crumbs = crumbs.filter((c) => catSet.has(c.category));
      } else {
        crumbs = crumbs.filter((c) => c.category === filter.category);
      }
    }

    if (filter.level) {
      crumbs = crumbs.filter((c) => c.level === filter.level);
    }

    if (filter.since !== undefined) {
      crumbs = crumbs.filter((c) => c.timestamp >= filter.since!);
    }

    if (filter.until !== undefined) {
      crumbs = crumbs.filter((c) => c.timestamp <= filter.until!);
    }

    if (filter.limit !== undefined && filter.limit >= 0 && crumbs.length > filter.limit) {
      crumbs = crumbs.slice(crumbs.length - filter.limit);
    }

    return crumbs;
  }

  /** Gets the most recent breadcrumb, if any. */
  getLastBreadcrumb(): Breadcrumb | undefined {
    const all = this.storage.getAll();
    return all.length > 0 ? all[all.length - 1] : undefined;
  }

  /** Returns an immutable snapshot copy of current breadcrumbs. */
  snapshot(): Breadcrumb[] {
    return this.storage.getAll();
  }

  /**
   * Returns aggregate statistics over the currently stored breadcrumbs.
   * Useful for dashboards and debugging reports.
   */
  getStats(): BreadcrumbStats {
    const crumbs = this.storage.getAll();
    const byCategory: Record<string, number> = {};
    const byLevel: Record<BreadcrumbLevel, number> = {
      debug: 0,
      info: 0,
      warn: 0,
      error: 0,
      fatal: 0,
    };

    let oldestTimestamp: number | undefined;
    let newestTimestamp: number | undefined;

    for (const crumb of crumbs) {
      byCategory[crumb.category] = (byCategory[crumb.category] ?? 0) + 1;
      if (crumb.level && crumb.level in byLevel) {
        byLevel[crumb.level as BreadcrumbLevel]++;
      }
      if (oldestTimestamp === undefined || crumb.timestamp < oldestTimestamp) {
        oldestTimestamp = crumb.timestamp;
      }
      if (newestTimestamp === undefined || crumb.timestamp > newestTimestamp) {
        newestTimestamp = crumb.timestamp;
      }
    }

    return {
      total: crumbs.length,
      byCategory,
      byLevel,
      oldestTimestamp,
      newestTimestamp,
      spanMs:
        oldestTimestamp !== undefined && newestTimestamp !== undefined && crumbs.length >= 2
          ? newestTimestamp - oldestTimestamp
          : 0,
    };
  }

  /** Clears all stored breadcrumbs. */
  clear(): void {
    this.storage.clear();
  }

  /** Returns the current number of breadcrumbs stored. */
  count(): number {
    return this.storage.size();
  }
}

// Global default tracker singleton
let defaultBreadcrumbTracker = new BreadcrumbTracker();

/** Gets the default global BreadcrumbTracker instance. */
export function getDefaultBreadcrumbTracker(): BreadcrumbTracker {
  return defaultBreadcrumbTracker;
}

/** Sets the default global BreadcrumbTracker instance. */
export function setDefaultBreadcrumbTracker(tracker: BreadcrumbTracker): void {
  defaultBreadcrumbTracker = tracker;
}

/** Resets the default BreadcrumbTracker instance to empty state. */
export function resetDefaultBreadcrumbTracker(): void {
  defaultBreadcrumbTracker = new BreadcrumbTracker();
}

/** Convenience function to append a breadcrumb to the default tracker. */
export function addBreadcrumb(crumb: {
  category?: BreadcrumbCategory;
  message: string;
  level?: BreadcrumbLevel;
  data?: Record<string, unknown>;
}): Breadcrumb | null {
  return defaultBreadcrumbTracker.addBreadcrumb(crumb);
}

/** Convenience function to get breadcrumbs from the default tracker. */
export function getBreadcrumbs(filter?: BreadcrumbFilter): Breadcrumb[] {
  return defaultBreadcrumbTracker.getBreadcrumbs(filter);
}

/** Convenience function to clear breadcrumbs in the default tracker. */
export function clearBreadcrumbs(): void {
  defaultBreadcrumbTracker.clear();
}

/** Convenience function to get aggregate stats from the default tracker. */
export function getBreadcrumbStats(): BreadcrumbStats {
  return defaultBreadcrumbTracker.getStats();
}
