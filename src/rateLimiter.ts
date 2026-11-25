/**
 * Outbound request rate limiting (issue #1058).
 *
 * Guards the SDK's RPC/transaction submission paths against abuse and
 * self-inflicted DoS by enforcing:
 *
 * - **A global token bucket** — `maxRequestsPerSecond` requests are allowed
 *   per `windowMs` window across all callers.
 * - **Optional per-key limits** — a second, independent budget per caller id
 *   (`perKeyLimit`) so one noisy key cannot starve the shared budget.
 * - **Checks** — {@link RateLimiter.check} observes capacity without
 *   consuming it, {@link RateLimiter.tryAcquire} consumes a slot only when
 *   one is available (fail-fast, never blocks), and {@link RateLimiter.acquire}
 *   queues the caller until a slot frees (the original blocking behavior).
 * - **Storage** — per-key counters live in {@link RateLimitStore}, a
 *   fixed-window map with least-recently-used eviction (`maxTrackedKeys`) and
 *   expired-window pruning, so memory stays bounded no matter how many
 *   distinct keys appear.
 *
 * Configuration is a plain {@link RateLimiterConfig} object (validated at
 * construction) which the `StellarSplitClient` accepts via its `rateLimit`
 * option.
 *
 * Issue #1058
 */

import { computeBackoffDelay } from "./retry.js";

/** Configuration for {@link RateLimiter}. */
export interface RateLimiterConfig {
  /** Requests allowed per window, globally. Must be a positive finite number. */
  maxRequestsPerSecond: number;
  /** Optional per-key budget within each window. Integer ≥ 1. */
  perKeyLimit?: number;
  /** Window length in milliseconds (token refill + per-key counters). Defaults to 1000. */
  windowMs?: number;
  /** Maximum tracked keys before least-recently-used eviction. Defaults to 10 000. */
  maxTrackedKeys?: number;
  /**
   * Per-method overrides (issue #1252). Maps a method name to a budget of
   * requests allowed per window for that method. Methods not listed fall back
   * to the global/per-key budgets. Values must be positive integers.
   */
  perMethodLimits?: Record<string, number>;
  /**
   * Per-user budget within each window (issue #1252). When set, every request
   * carrying a resolved user identity is additionally constrained by this
   * budget, independent of the per-key budget.
   */
  perUserLimit?: number;
  /**
   * Resolves the caller identity for a request (issue #1252). Receives the
   * method name and its arguments. Returning `undefined` means "anonymous"
   * (only global/per-method limits apply). Defaults to no resolver.
   */
  resolveUser?: (method: string, args: unknown[]) => string | undefined;
  /**
   * Optional event sink invoked for every rate-limit decision (issue #1252).
   * Receives a {@link RateLimitEvent}. Used for logging/metrics.
   */
  onEvent?: (event: RateLimitEvent) => void;
  /**
   * Backoff applied by {@link RateLimiter.executeWithBackoff} when a request
   * is rejected (issue #1349).
   */
  backoff?: RateLimitBackoffConfig;
}

/** Backoff configuration for rejected requests (issue #1349). */
export interface RateLimitBackoffConfig {
  /** Delay before the first retry in milliseconds. Defaults to 100. */
  baseDelayMs?: number;
  /** Upper bound for a single delay in milliseconds. Defaults to 5000. */
  maxDelayMs?: number;
  /** Retries after the first rejection before giving up. Defaults to 3. */
  maxRetries?: number;
}

/** Cumulative rate-limit decision counters (issue #1349). */
export interface RateLimitStats {
  /** Requests admitted. */
  allowed: number;
  /** Requests rejected. */
  denied: number;
  /** Rejections broken down by the limit that produced them. */
  deniedByScope: Record<RateLimitEvent["scope"], number>;
  /** Backoff waits performed by {@link RateLimiter.executeWithBackoff}. */
  backoffRetries: number;
}

/** A rate-limit decision event (issue #1252). */
export interface RateLimitEvent {
  /** Method the request targeted. */
  method: string;
  /** Resolved user identity, when available. */
  user?: string;
  /** Whether the request was admitted. */
  allowed: boolean;
  /** Remaining slots after the decision. */
  remaining: number;
  /** Milliseconds until capacity is available (0 when allowed). */
  retryAfterMs: number;
  /** Which limit produced the decision. */
  scope: "global" | "method" | "user" | "key";
  /** Epoch milliseconds of the decision. */
  timestamp: number;
}

/** Error thrown when a request is rejected by the rate limiter (issue #1252). */
export class RateLimitExceededError extends Error {
  readonly retryAfterMs: number;
  readonly method: string;
  readonly user?: string;

  constructor(method: string, retryAfterMs: number, user?: string) {
    super(
      `Rate limit exceeded for ${method}` +
        (user ? ` (user ${user})` : "") +
        `; retry after ${retryAfterMs}ms`,
    );
    this.name = "RateLimitExceededError";
    this.method = method;
    this.retryAfterMs = retryAfterMs;
    this.user = user;
  }
}

/** Outcome of a rate-limit check or acquisition attempt. */
export interface RateLimitCheck {
  /** Whether the request may proceed. */
  allowed: boolean;
  /** Slots left for the current window when allowed; `0` when denied. */
  remaining: number;
  /** Milliseconds until capacity is available (0 when allowed). */
  retryAfterMs: number;
}

interface WindowEntry {
  /** Start of the window the count belongs to (epoch ms). */
  windowStart: number;
  /** Units consumed within the current window. */
  count: number;
}

/**
 * Bounded fixed-window counter storage for per-key rate limits.
 *
 * Each key owns an independent window that starts at its first use; when the
 * window elapses the counter rolls over automatically. Insertion order doubles
 * as a least-recently-used ranking: entries are re-inserted on access and the
 * oldest entry is evicted once `maxKeys` is reached, keeping storage O(1) and
 * memory bounded even under key-squatting floods.
 */
export class RateLimitStore {
  private readonly _entries = new Map<string, WindowEntry>();
  /** Hard cap on tracked keys (LRU-evicted above this). */
  readonly maxKeys: number;

  constructor(maxKeys: number = 10_000) {
    if (!Number.isInteger(maxKeys) || maxKeys < 1) {
      throw new RangeError("maxKeys must be an integer of at least 1");
    }
    this.maxKeys = maxKeys;
  }

  /** Number of keys currently tracked. */
  get size(): number {
    return this._entries.size;
  }

  /**
   * Observe consumption for `key` without consuming a unit.
   *
   * @returns A {@link RateLimitCheck} reflecting the key's current window.
   */
  peek(key: string, limit: number, windowMs: number, now: number = Date.now()): RateLimitCheck {
    return this._evaluate(key, limit, windowMs, now, false);
  }

  /**
   * Consume one unit for `key` when the budget allows it.
   *
   * @returns A {@link RateLimitCheck}; `allowed` is false when the key's
   *   budget for the current window is exhausted.
   */
  consume(key: string, limit: number, windowMs: number, now: number = Date.now()): RateLimitCheck {
    return this._evaluate(key, limit, windowMs, now, true);
  }

  /**
   * Drop every entry whose window has fully elapsed.
   *
   * @returns Number of entries removed.
   */
  prune(windowMs: number, now: number = Date.now()): number {
    let removed = 0;
    for (const [key, entry] of this._entries) {
      if (now - entry.windowStart >= windowMs) {
        this._entries.delete(key);
        removed++;
      }
    }
    return removed;
  }

  /** Forget every tracked key (e.g. when the limiter is reconfigured). */
  clear(): void {
    this._entries.clear();
  }

  private _evaluate(
    key: string,
    limit: number,
    windowMs: number,
    now: number,
    take: boolean,
  ): RateLimitCheck {
    const entry = this._touch(key, windowMs, now);
    const available = limit - entry.count;
    if (available <= 0) {
      return { allowed: false, remaining: 0, retryAfterMs: entry.windowStart + windowMs - now };
    }
    if (take) {
      entry.count++;
    }
    return {
      allowed: true,
      remaining: available - (take ? 1 : 0),
      retryAfterMs: 0,
    };
  }

  private _touch(key: string, windowMs: number, now: number): WindowEntry {
    let entry = this._entries.get(key);
    if (entry && now - entry.windowStart >= windowMs) {
      // Window elapsed: roll the counter over in place.
      entry.windowStart = now;
      entry.count = 0;
    }
    if (!entry) {
      while (this._entries.size >= this.maxKeys) {
        const oldest = this._entries.keys().next();
        if (oldest.done) break;
        this._entries.delete(oldest.value);
      }
      entry = { windowStart: now, count: 0 };
      this._entries.set(key, entry);
      return entry;
    }
    // Re-insert to mark the key as most recently used for LRU eviction.
    this._entries.delete(key);
    this._entries.set(key, entry);
    return entry;
  }
}

interface PendingAcquire {
  key?: string;
  resolve: () => void;
}

/**
 * Token-bucket rate limiter with optional per-key budgets.
 *
 * @example
 * const limiter = new RateLimiter({ maxRequestsPerSecond: 10, perKeyLimit: 5 });
 * await limiter.acquire("wallet-1");   // blocks until a slot is free
 * limiter.tryAcquire("wallet-1");      // fail-fast: { allowed, remaining, retryAfterMs }
 * limiter.check("wallet-1");           // observe without consuming
 */
export class RateLimiter {
  private _tokens: number;
  private readonly _maxTokens: number;
  private readonly _perKeyLimit: number | undefined;
  private readonly _windowMs: number;
  private readonly _store: RateLimitStore;
  private readonly _methodStore: RateLimitStore;
  private readonly _userStore: RateLimitStore;
  private readonly _perMethodLimits: Readonly<Record<string, number>>;
  private readonly _perUserLimit: number | undefined;
  private readonly _resolveUser: ((method: string, args: unknown[]) => string | undefined) | undefined;
  private readonly _onEvent: ((event: RateLimitEvent) => void) | undefined;
  private _lastRefillTime: number;
  private _queue: PendingAcquire[] = [];
  private _processing = false;
  private readonly _backoff: Required<RateLimitBackoffConfig>;
  private _stats: RateLimitStats = RateLimiter._emptyStats();

  constructor(config: RateLimiterConfig) {
    if (!config || typeof config !== "object") {
      throw new RangeError("RateLimiter requires a config object");
    }
    const {
      maxRequestsPerSecond,
      perKeyLimit,
      windowMs,
      maxTrackedKeys,
      perMethodLimits,
      perUserLimit,
      resolveUser,
      onEvent,
      backoff,
    } = config;
    if (
      typeof maxRequestsPerSecond !== "number" ||
      !Number.isFinite(maxRequestsPerSecond) ||
      maxRequestsPerSecond <= 0
    ) {
      throw new RangeError("maxRequestsPerSecond must be a positive finite number");
    }
    if (perKeyLimit !== undefined && (!Number.isInteger(perKeyLimit) || perKeyLimit < 1)) {
      throw new RangeError("perKeyLimit must be an integer of at least 1");
    }
    if (windowMs !== undefined && (!Number.isFinite(windowMs) || windowMs < 1)) {
      throw new RangeError("windowMs must be a finite number of at least 1");
    }
    if (perUserLimit !== undefined && (!Number.isInteger(perUserLimit) || perUserLimit < 1)) {
      throw new RangeError("perUserLimit must be an integer of at least 1");
    }
    if (perMethodLimits !== undefined) {
      if (typeof perMethodLimits !== "object" || perMethodLimits === null) {
        throw new RangeError("perMethodLimits must be an object");
      }
      for (const [method, limit] of Object.entries(perMethodLimits)) {
        if (!Number.isInteger(limit) || limit < 1) {
          throw new RangeError(`perMethodLimits["${method}"] must be an integer of at least 1`);
        }
      }
    }
    if (resolveUser !== undefined && typeof resolveUser !== "function") {
      throw new RangeError("resolveUser must be a function");
    }
    if (onEvent !== undefined && typeof onEvent !== "function") {
      throw new RangeError("onEvent must be a function");
    }
    if (backoff !== undefined) {
      if (typeof backoff !== "object" || backoff === null) {
        throw new RangeError("backoff must be an object");
      }
      for (const field of ["baseDelayMs", "maxDelayMs", "maxRetries"] as const) {
        const value = backoff[field];
        if (value !== undefined && (!Number.isFinite(value) || value < 0)) {
          throw new RangeError(`backoff.${field} must be a non-negative finite number`);
        }
      }
    }

    this._maxTokens = maxRequestsPerSecond;
    this._perKeyLimit = perKeyLimit;
    this._windowMs = windowMs ?? 1000;
    this._tokens = this._maxTokens;
    this._lastRefillTime = Date.now();
    this._store = new RateLimitStore(maxTrackedKeys);
    this._methodStore = new RateLimitStore(maxTrackedKeys);
    this._userStore = new RateLimitStore(maxTrackedKeys);
    this._perMethodLimits = Object.freeze({ ...(perMethodLimits ?? {}) });
    this._perUserLimit = perUserLimit;
    this._resolveUser = resolveUser;
    this._onEvent = onEvent;
    this._backoff = {
      baseDelayMs: backoff?.baseDelayMs ?? 100,
      maxDelayMs: backoff?.maxDelayMs ?? 5_000,
      maxRetries: Math.floor(backoff?.maxRetries ?? 3),
    };
  }

  /** Effective window length in milliseconds. */
  get windowMs(): number {
    return this._windowMs;
  }

  /** Per-key counter storage (exposed for inspection/metrics). */
  get store(): RateLimitStore {
    return this._store;
  }

  /** Per-method counter storage (exposed for inspection/metrics). */
  get methodStore(): RateLimitStore {
    return this._methodStore;
  }

  /** Per-user counter storage (exposed for inspection/metrics). */
  get userStore(): RateLimitStore {
    return this._userStore;
  }

  /**
   * Enforce the rate limit for a method invocation (issue #1252).
   *
   * This is the single choke point every SDK entry point must route through:
   * it resolves the caller identity, applies global, per-method, per-user and
   * per-key budgets, emits a {@link RateLimitEvent}, and throws
   * {@link RateLimitExceededError} when the request must be rejected.
   *
   * @param method - The method name being invoked.
   * @param args - The method arguments (used by the user resolver).
   * @param key - Optional per-key scope (e.g. wallet id).
   * @throws {RateLimitExceededError} When the request is not admitted.
   */
  enforce(method: string, args: unknown[] = [], key?: string): void {
    const result = this._evaluateScoped(method, args, key, true);
    if (!result.allowed) {
      throw new RateLimitExceededError(method, result.retryAfterMs, result.user);
    }
  }

  /**
   * Wrap a function so every invocation is rate limited (issue #1252).
   *
   * The returned function enforces the limit before delegating to `fn`, so
   * callers cannot bypass the limiter by calling the wrapped function
   * directly.
   *
   * @param method - The method name used for per-method limits and events.
   * @param fn - The function to guard.
   * @param key - Optional per-key scope.
   */
  guard<A extends unknown[], R>(
    method: string,
    fn: (...args: A) => R,
    key?: string,
  ): (...args: A) => R {
    return (...args: A): R => {
      this.enforce(method, args, key);
      return fn(...args);
    };
  }

  /**
   * Run `fn` once the rate limit admits the request, backing off
   * exponentially when it is rejected (issue #1349).
   *
   * Each wait is the larger of the limiter's `retryAfterMs` hint and the
   * exponential backoff delay for the attempt, capped by `backoff.maxDelayMs`.
   *
   * @param method - The method name used for per-method limits and events.
   * @param fn - The function to run once admitted.
   * @param key - Optional per-key scope.
   * @throws {RateLimitExceededError} When still rejected after `backoff.maxRetries` retries.
   */
  async executeWithBackoff<R>(method: string, fn: () => R | Promise<R>, key?: string): Promise<R> {
    for (let attempt = 1; ; attempt++) {
      try {
        this.enforce(method, [], key);
        break;
      } catch (err) {
        if (!(err instanceof RateLimitExceededError) || attempt > this._backoff.maxRetries) {
          throw err;
        }
        const delayMs = Math.max(
          err.retryAfterMs,
          computeBackoffDelay(attempt, {
            baseDelayMs: this._backoff.baseDelayMs,
            maxDelayMs: this._backoff.maxDelayMs,
          }),
        );
        this._stats.backoffRetries++;
        await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
      }
    }
    return fn();
  }

  /** Snapshot of cumulative rate-limit decisions (issue #1349). */
  getStats(): RateLimitStats {
    return { ...this._stats, deniedByScope: { ...this._stats.deniedByScope } };
  }

  /** Reset the decision counters returned by {@link getStats}. */
  resetStats(): void {
    this._stats = RateLimiter._emptyStats();
  }

  private static _emptyStats(): RateLimitStats {
    return {
      allowed: 0,
      denied: 0,
      deniedByScope: { global: 0, method: 0, user: 0, key: 0 },
      backoffRetries: 0,
    };
  }

  private _track(allowed: boolean, scope: RateLimitEvent["scope"]): void {
    if (allowed) {
      this._stats.allowed++;
    } else {
      this._stats.denied++;
      this._stats.deniedByScope[scope]++;
    }
  }

  private _evaluateScoped(
    method: string,
    args: unknown[],
    key: string | undefined,
    consume: boolean,
  ): RateLimitCheck & { user?: string } {
    const now = Date.now();
    this._refill(now);

    const user = this._resolveUser ? this._resolveUser(method, args) : undefined;

    const deny = (scope: RateLimitEvent["scope"], retryAfterMs: number): RateLimitCheck & { user?: string } => {
      if (consume) this._track(false, scope);
      this._emit({ method, user, allowed: false, remaining: 0, retryAfterMs, scope, timestamp: now });
      return { allowed: false, remaining: 0, retryAfterMs, user };
    };

    if (this._tokens <= 0) {
      return deny("global", this._msUntilRefill(now));
    }

    const methodLimit = this._perMethodLimits[method];
    if (methodLimit !== undefined) {
      const methodResult = consume
        ? this._methodStore.consume(method, methodLimit, this._windowMs, now)
        : this._methodStore.peek(method, methodLimit, this._windowMs, now);
      if (!methodResult.allowed) {
        return deny("method", methodResult.retryAfterMs);
      }
    }

    if (user && this._perUserLimit !== undefined) {
      const userResult = consume
        ? this._userStore.consume(user, this._perUserLimit, this._windowMs, now)
        : this._userStore.peek(user, this._perUserLimit, this._windowMs, now);
      if (!userResult.allowed) {
        return deny("user", userResult.retryAfterMs);
      }
    }

    if (key && this._perKeyLimit !== undefined) {
      const keyResult = consume
        ? this._store.consume(key, this._perKeyLimit, this._windowMs, now)
        : this._store.peek(key, this._perKeyLimit, this._windowMs, now);
      if (!keyResult.allowed) {
        return deny("key", keyResult.retryAfterMs);
      }
    }

    if (consume) {
      this._tokens--;
    }
    const remaining = Math.floor(this._tokens);
    if (consume) this._track(true, "global");
    this._emit({ method, user, allowed: true, remaining, retryAfterMs: 0, scope: "global", timestamp: now });
    return { allowed: true, remaining, retryAfterMs: 0, user };
  }

  private _emit(event: RateLimitEvent): void {
    if (!this._onEvent) return;
    try {
      this._onEvent(event);
    } catch {
      // Event sinks must never break enforcement.
    }
  }

  /**
   * Observe current capacity without consuming a slot.
   *
   * @param key - Optional per-key scope.
   * @returns Whether a request would be admitted, remaining slots, and the
   *   wait in milliseconds when denied.
   */
  check(key?: string): RateLimitCheck {
    return this._evaluate(key, false);
  }

  /**
   * Consume a slot when one is available — never blocks.
   *
   * @param key - Optional per-key scope.
   * @returns Admission result; when denied, `retryAfterMs` indicates when to
   *   retry.
   */
  tryAcquire(key?: string): RateLimitCheck {
    return this._evaluate(key, true);
  }

  /**
   * Acquire a slot, queueing until one frees (blocking behavior).
   *
   * @param key - Optional per-key scope.
   * @returns A promise that resolves once the slot has been granted.
   */
  acquire(key?: string): Promise<void> {
    if (this._evaluate(key, true).allowed) {
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => {
      this._queue.push({ key, resolve });
      if (!this._processing) {
        this._processQueue();
      }
    });
  }

  private _refill(now: number = Date.now()): void {
    const elapsed = now - this._lastRefillTime;
    if (elapsed >= this._windowMs) {
      const periods = Math.floor(elapsed / this._windowMs);
      this._tokens = Math.min(this._maxTokens, this._tokens + periods * this._maxTokens);
      this._lastRefillTime += periods * this._windowMs;
    }
  }

  private _msUntilRefill(now: number = Date.now()): number {
    return Math.max(0, this._windowMs - (now - this._lastRefillTime));
  }

  private _evaluate(key: string | undefined, consume: boolean, track: boolean = consume): RateLimitCheck {
    const now = Date.now();
    this._refill(now);

    if (this._tokens <= 0) {
      if (track) this._track(false, "global");
      return { allowed: false, remaining: 0, retryAfterMs: this._msUntilRefill(now) };
    }

    if (key && this._perKeyLimit !== undefined) {
      const keyResult = consume
        ? this._store.consume(key, this._perKeyLimit, this._windowMs, now)
        : this._store.peek(key, this._perKeyLimit, this._windowMs, now);
      if (!keyResult.allowed) {
        if (track) this._track(false, "key");
        return { allowed: false, remaining: 0, retryAfterMs: keyResult.retryAfterMs };
      }
      if (consume) {
        this._tokens--;
      }
      if (track) this._track(true, "global");
      return {
        allowed: true,
        remaining: Math.min(Math.floor(this._tokens), keyResult.remaining),
        retryAfterMs: 0,
      };
    }

    if (consume) {
      this._tokens--;
    }
    if (track) this._track(true, "global");
    return { allowed: true, remaining: Math.floor(this._tokens), retryAfterMs: 0 };
  }

  private _processQueue(): void {
    this._processing = true;
    const msUntilRefill = this._msUntilRefill();
    setTimeout(() => {
      const now = Date.now();
      this._refill(now);
      let index = 0;
      while (index < this._queue.length) {
        const next = this._queue[index];
        if (!next) {
          index++;
          continue;
        }
        // Queued callers were already counted as denied; only count the grant.
        if (this._evaluate(next.key, true, false).allowed) {
          this._track(true, "global");
          this._queue.splice(index, 1);
          next.resolve();
          continue;
        }
        index++;
      }
      if (this._queue.length > 0) {
        this._processQueue();
      } else {
        this._processing = false;
      }
    }, msUntilRefill);
  }
}

