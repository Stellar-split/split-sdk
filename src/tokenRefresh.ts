/**
 * Token refresh strategy for SDK authentication.
 *
 * Provides preemptive, JWT-expiry-aware refresh with retry/backoff, a fallback
 * token source, concurrency de-duplication and bounded tracking. No tokens are
 * ever written to logs or tracking events.
 */

/** Response expected from the refresh endpoint. */
export interface TokenRefreshResponse {
  token: string;
  refreshToken?: string;
  expiresIn?: number;
}

/** Configuration for {@link TokenRefreshManager}. */
export interface TokenRefreshConfig {
  /** Endpoint that accepts a POST with the current/refresh token and returns a new token. */
  refreshEndpoint: string;
  /** Token used when every refresh attempt fails. Can be static or a supplier. */
  fallbackToken?: string | (() => string | Promise<string>);
  /** Refresh this many milliseconds before expiry. Defaults to 60 000. */
  refreshBufferMs?: number;
  /** Maximum refresh attempts per cycle. Defaults to 3. */
  maxRetries?: number;
  /** Initial retry delay in milliseconds. Defaults to 250. */
  retryBaseDelayMs?: number;
  /** Upper bound for retry delays. Defaults to 5 000. */
  retryMaxDelayMs?: number;
  /** Add random jitter to backoff delays. Defaults to true. */
  jitter?: boolean;
  /** Additional headers sent to the refresh endpoint. */
  headers?: Record<string, string> | (() => Record<string, string>);
  /** Injectable fetch implementation (useful for tests). */
  fetch?: typeof globalThis.fetch;
  /** Injectable clock. */
  now?: () => number;
  /** Maximum number of retained tracking events. Defaults to 100. */
  maxTrackedEvents?: number;
}

/** Successful refresh record. */
export interface TokenRefreshEvent {
  timestamp: number;
  durationMs: number;
  attempt: number;
}

/** Failed refresh record (error messages only, never tokens). */
export interface TokenRefreshFailureEvent {
  timestamp: number;
  attempt: number;
  message: string;
}

/** Counters describing refresh activity. */
export interface TokenRefreshStats {
  refreshes: number;
  successes: number;
  failures: number;
  fallbacks: number;
  scheduled: number;
  queued: number;
}

/** Error thrown when refresh fails and no fallback is available. */
export class TokenRefreshError extends Error {
  constructor(message: string, public readonly attempts: number, cause?: unknown) {
    super(message);
    this.name = "TokenRefreshError";
    if (cause !== undefined) {
      (this as Error & { cause?: unknown }).cause = cause;
    }
  }
}

/** Decode the `exp` claim of a JWT without verifying its signature. */
export function decodeTokenExpiry(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return null;
  }
  try {
    const normalized = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(normalized)) as { exp?: unknown };
    return typeof payload.exp === "number" && Number.isFinite(payload.exp)
      ? payload.exp * 1000
      : null;
  } catch {
    return null;
  }
}

interface Waiter {
  resolve: (token: string) => void;
  reject: (error: Error) => void;
}

/**
 * Manages the lifecycle of an authentication token, refreshing it shortly
 * before expiry and coalescing concurrent callers into a single refresh.
 *
 * @example
 * ```ts
 * const manager = new TokenRefreshManager({ refreshEndpoint: "/auth/refresh" });
 * manager.setToken(jwt);
 * const token = await manager.getToken(); // refreshes when near expiry
 * ```
 */
export class TokenRefreshManager {
  private readonly config: Required<
    Pick<
      TokenRefreshConfig,
      | "refreshEndpoint"
      | "refreshBufferMs"
      | "maxRetries"
      | "retryBaseDelayMs"
      | "retryMaxDelayMs"
      | "jitter"
      | "maxTrackedEvents"
    >
  > &
    TokenRefreshConfig;

  private token: string | null = null;
  private refreshToken: string | null = null;
  private expiresAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private refreshing = false;
  private disposed = false;
  private readonly abortController = new AbortController();
  private resolveDisposal: () => void = () => undefined;
  private readonly disposalPromise = new Promise<void>((resolve) => {
    this.resolveDisposal = resolve;
  });
  private readonly waiters: Waiter[] = [];
  private readonly successHandlers = new Set<(event: TokenRefreshEvent) => void>();
  private readonly failureHandlers = new Set<(event: TokenRefreshFailureEvent) => void>();
  private readonly successes: TokenRefreshEvent[] = [];
  private readonly failures: TokenRefreshFailureEvent[] = [];
  private counters: TokenRefreshStats = {
    refreshes: 0,
    successes: 0,
    failures: 0,
    fallbacks: 0,
    scheduled: 0,
    queued: 0,
  };

  constructor(config: TokenRefreshConfig) {
    if (!config.refreshEndpoint) {
      throw new Error("refreshEndpoint is required");
    }
    this.config = {
      ...config,
      refreshBufferMs: config.refreshBufferMs ?? 60_000,
      maxRetries: Math.max(1, config.maxRetries ?? 3),
      retryBaseDelayMs: config.retryBaseDelayMs ?? 250,
      retryMaxDelayMs: config.retryMaxDelayMs ?? 5_000,
      jitter: config.jitter ?? true,
      maxTrackedEvents: config.maxTrackedEvents ?? 100,
    };
  }

  /** Install an initial token and schedule its preemptive refresh. */
  setToken(token: string, refreshToken?: string): void {
    this.token = token;
    if (refreshToken !== undefined) {
      this.refreshToken = refreshToken;
    }
    this.expiresAt = decodeTokenExpiry(token);
    this.scheduleRefresh();
  }

  /** Currently cached token (may be expired; prefer {@link getToken}). */
  peekToken(): string | null {
    return this.token;
  }

  /** Whether a refresh cycle is currently in progress. */
  get isRefreshing(): boolean {
    return this.refreshing;
  }

  /** Return a valid token, refreshing first when it is expiring or expired. */
  async getToken(): Promise<string> {
    if (this.disposed) {
      throw new TokenRefreshError("TokenRefreshManager has been disposed", 0);
    }

    if (this.refreshing) {
      this.counters.queued += 1;
      return new Promise<string>((resolve, reject) => {
        this.waiters.push({ resolve, reject });
      });
    }

    if (this.token === null || this.isExpiring()) {
      return this.refresh();
    }
    return this.token;
  }

  /** Force a refresh cycle. Concurrent callers share the same cycle. */
  async refresh(): Promise<string> {
    if (this.refreshing) {
      return this.getToken();
    }
    return Promise.race([
      this.performRefresh(),
      this.disposalPromise.then(() => {
        throw new TokenRefreshError("TokenRefreshManager has been disposed", 0);
      }),
    ]);
  }

  private async performRefresh(): Promise<string> {
    this.refreshing = true;
    this.counters.refreshes += 1;
    const startedAt = this.now();
    let lastError: unknown;

    try {
      for (let attempt = 1; attempt <= this.config.maxRetries; attempt += 1) {
        if (this.disposed) {
          throw new TokenRefreshError("TokenRefreshManager has been disposed", attempt);
        }
        try {
          const response = await this.requestRefresh();
          this.applyToken(response);
          const event: TokenRefreshEvent = {
            timestamp: this.now(),
            durationMs: Math.max(0, this.now() - startedAt),
            attempt,
          };
          this.counters.successes += 1;
          this.pushEvent(this.successes, event);
          this.successHandlers.forEach((handler) => handler(event));
          this.resolveWaiters(response.token);

          // Re-arm scheduling because setToken() skipped it while refreshing.
          this.scheduleRefresh();
          return response.token;
        } catch (error) {
          if (this.disposed) {
            this.rejectWaiters(new TokenRefreshError("TokenRefreshManager has been disposed", attempt, error));
            throw new TokenRefreshError("TokenRefreshManager has been disposed", attempt, error);
          }
          lastError = error;
          this.counters.failures += 1;
          const failure: TokenRefreshFailureEvent = {
            timestamp: this.now(),
            attempt,
            message: error instanceof Error ? error.message : String(error),
          };
          this.pushEvent(this.failures, failure);
          this.failureHandlers.forEach((handler) => handler(failure));

          if (attempt < this.config.maxRetries) {
            await this.delay(this.backoffDelay(attempt));
          }
        }
      }

      const fallback = await this.resolveFallback();
      if (fallback !== null) {
        this.counters.fallbacks += 1;
        this.token = fallback;
        this.expiresAt = decodeTokenExpiry(fallback);
        this.resolveWaiters(fallback);
        this.scheduleRefresh();
        return fallback;
      }

      const error = new TokenRefreshError(
        `Token refresh failed after ${this.config.maxRetries} attempts`,
        this.config.maxRetries,
        lastError,
      );
      this.rejectWaiters(error);
      throw error;
    } finally {
      this.refreshing = false;
    }
  }

  /** Subscribe to successful refresh events; returns an unsubscribe function. */
  onRefreshed(handler: (event: TokenRefreshEvent) => void): () => void {
    this.successHandlers.add(handler);
    return () => this.successHandlers.delete(handler);
  }

  /** Subscribe to failed attempts; returns an unsubscribe function. */
  onRefreshFailed(handler: (event: TokenRefreshFailureEvent) => void): () => void {
    this.failureHandlers.add(handler);
    return () => this.failureHandlers.delete(handler);
  }

  /** Operation counters. */
  stats(): TokenRefreshStats {
    return { ...this.counters };
  }

  /** Copy of successful refresh events (oldest first). */
  refreshedEvents(): TokenRefreshEvent[] {
    return this.successes.map((event) => ({ ...event }));
  }

  /** Copy of failed-attempt events (oldest first). */
  failedEvents(): TokenRefreshFailureEvent[] {
    return this.failures.map((event) => ({ ...event }));
  }

  /** Cancel scheduled refreshes and release queued callers. */
  dispose(): void {
    this.disposed = true;
    this.abortController.abort();
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.rejectWaiters(new TokenRefreshError("TokenRefreshManager has been disposed", 0));
    this.resolveDisposal();
    this.successHandlers.clear();
    this.failureHandlers.clear();
  }

  private now(): number {
    return this.config.now ? this.config.now() : Date.now();
  }

  private isExpiring(): boolean {
    if (this.expiresAt === null) {
      // Opaque tokens cannot be checked; refresh proactively.
      return true;
    }
    return this.expiresAt - this.now() <= this.config.refreshBufferMs;
  }

  private applyToken(response: TokenRefreshResponse): void {
    if (!response || typeof response.token !== "string" || response.token.length === 0) {
      throw new Error("Refresh endpoint returned no token");
    }
    this.token = response.token;
    if (response.refreshToken !== undefined) {
      this.refreshToken = response.refreshToken;
    }
    this.expiresAt =
      response.expiresIn !== undefined
        ? this.now() + response.expiresIn * 1000
        : decodeTokenExpiry(response.token);
  }

  private async requestRefresh(): Promise<TokenRefreshResponse> {
    const fetchImpl = this.config.fetch ?? globalThis.fetch;
    if (!fetchImpl) {
      throw new Error("No fetch implementation available for token refresh");
    }
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...(typeof this.config.headers === "function"
        ? this.config.headers()
        : (this.config.headers ?? {})),
    };
    const response = await fetchImpl(this.config.refreshEndpoint, {
      method: "POST",
      headers,
      signal: this.abortController.signal,
      body: JSON.stringify({
        token: this.token,
        refreshToken: this.refreshToken,
      }),
    });
    if (!response.ok) {
      throw new Error(`Refresh endpoint responded with ${response.status}`);
    }
    return (await response.json()) as TokenRefreshResponse;
  }

  private async resolveFallback(): Promise<string | null> {
    const fallback = this.config.fallbackToken;
    if (fallback === undefined) {
      return null;
    }
    return typeof fallback === "function" ? await fallback() : fallback;
  }

  private scheduleRefresh(): void {
    if (this.disposed || this.timer !== null) {
      return;
    }
    if (this.expiresAt === null) {
      return;
    }
    const delay = Math.max(0, this.expiresAt - this.config.refreshBufferMs - this.now());
    this.counters.scheduled += 1;
    this.timer = setTimeout(() => {
      this.timer = null;
      void this.refresh().catch(() => {
        // Failures are already reported through onRefreshFailed.
      });
    }, delay);
  }

  private backoffDelay(attempt: number): number {
    const exponential = Math.min(
      this.config.retryMaxDelayMs,
      this.config.retryBaseDelayMs * 2 ** (attempt - 1),
    );
    if (!this.config.jitter) {
      return exponential;
    }
    return Math.round(exponential * (0.5 + Math.random() * 0.5));
  }

  private delay(ms: number): Promise<void> {
    if (ms <= 0) {
      return Promise.resolve();
    }
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private pushEvent<T>(target: T[], event: T): void {
    if (target.length >= this.config.maxTrackedEvents) {
      target.shift();
    }
    target.push(event);
  }

  private resolveWaiters(token: string): void {
    const waiters = this.waiters.splice(0, this.waiters.length);
    waiters.forEach((waiter) => waiter.resolve(token));
  }

  private rejectWaiters(error: Error): void {
    const waiters = this.waiters.splice(0, this.waiters.length);
    waiters.forEach((waiter) => waiter.reject(error));
  }
}
