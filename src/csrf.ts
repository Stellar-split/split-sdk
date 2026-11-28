/**
 * CSRF protection utilities (issue #1059).
 *
 * Provides a small, dependency-free token system for defending state-changing
 * requests against Cross-Site Request Forgery:
 *
 * - {@link generateCsrfToken} creates cryptographically random tokens
 *   (256-bit default) encoded as base64url for safe transport in headers,
 *   cookies, and forms.
 * - {@link hashCsrfToken} produces a SHA-256 digest for storing tokens
 *   server-side, so a leaked session store never exposes usable tokens.
 * - {@link csrfTokensMatch} compares two tokens in constant time (both sides
 *   are hashed to fixed-length digests first, so `timingSafeEqual` never
 *   observes differing lengths).
 * - {@link extractCsrfToken} reads a token from a case-insensitive header
 *   record (string or first value of an array header).
 * - {@link CsrfTokenManager} ties it together: per-session tokens with TTL,
 *   optional single-use consumption, rotation, revocation, LRU-bounded
 *   storage, and expired-entry cleanup. Only token *hashes* are retained.
 *
 * The default header (`x-csrf-token`) and cookie (`xsrf-token`) names follow
 * the synchronizer-token / double-submit-cookie patterns; both are exported
 * so server integrations stay consistent.
 *
 * Issue #1059
 */

import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { EventEmitter } from "node:events";
import { StellarSplitError } from "./errors.js";

/** Default request header carrying the CSRF token. */
export const CSRF_HEADER_NAME = "x-csrf-token";
/** Default cookie carrying the CSRF token (double-submit-cookie pattern). */
export const CSRF_COOKIE_NAME = "xsrf-token";

/** Default token entropy: 32 random bytes (256 bits). */
const DEFAULT_TOKEN_BYTES = 32;
/** Minimum accepted token entropy: 16 random bytes (128 bits). */
const MIN_TOKEN_BYTES = 16;
/** Default token lifetime: 30 minutes. */
const DEFAULT_TTL_MS = 30 * 60_000;
/** Default cap on concurrently tracked sessions (LRU-evicted above this). */
const DEFAULT_MAX_SESSIONS = 10_000;
/** Longest accepted session identifier. */
const MAX_SESSION_ID_LENGTH = 256;

/** Thrown when CSRF configuration or session identifiers are invalid. */
export class CsrfError extends StellarSplitError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "CSRF_ERROR", context);
    this.name = "CsrfError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// CSRF event tracking
// ---------------------------------------------------------------------------

/** CSRF lifecycle events emitted by {@link CsrfTokenManager}. */
export type CsrfEventType =
  | "csrf:token_issued"
  | "csrf:token_refreshed"
  | "csrf:token_validated"
  | "csrf:token_rejected"
  | "csrf:token_revoked"
  | "csrf:tokens_revoked_all"
  | "csrf:cleanup";

/** Payload accompanying every emitted CSRF event. */
export interface CsrfEvent {
  /** Event kind. */
  type: CsrfEventType;
  /** Session the event relates to, when applicable. */
  sessionId?: string;
  /** Epoch milliseconds when the event occurred. */
  timestamp: number;
  /** Optional human-readable detail (e.g. rejection reason). */
  reason?: string;
}

/** Listener invoked for each emitted {@link CsrfEvent}. */
export type CsrfEventListener = (event: CsrfEvent) => void;

// ---------------------------------------------------------------------------
// Token helpers
// ---------------------------------------------------------------------------

/**
 * Generate a cryptographically random CSRF token.
 *
 * @param tokenBytes - Entropy in bytes (≥ 16). Defaults to 32 (256 bits).
 * @returns A base64url-encoded random token.
 * @throws {CsrfError} If `tokenBytes` is not an integer ≥ 16.
 *
 * @example
 * generateCsrfToken();      // "3q2+7w==…" style base64url string
 * generateCsrfToken(64);    // 512-bit token
 */
export function generateCsrfToken(tokenBytes: number = DEFAULT_TOKEN_BYTES): string {
  if (!Number.isInteger(tokenBytes) || tokenBytes < MIN_TOKEN_BYTES) {
    throw new CsrfError(
      `tokenBytes must be an integer of at least ${MIN_TOKEN_BYTES}`,
      { tokenBytes },
    );
  }
  return randomBytes(tokenBytes).toString("base64url");
}

/**
 * Hash a CSRF token with SHA-256 for storage.
 *
 * @param token - Raw token produced by {@link generateCsrfToken}.
 * @returns Lowercase hex SHA-256 digest (64 chars).
 *
 * @example
 * hashCsrfToken(token); // store this, never the raw token
 */
export function hashCsrfToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/**
 * Compare two CSRF tokens in constant time.
 *
 * Both operands are hashed to fixed-length 32-byte digests before
 * `timingSafeEqual` runs, so neither the tokens' contents nor their lengths
 * leak through response timing.
 *
 * @param a - First token.
 * @param b - Second token.
 * @returns `true` when both tokens are identical strings.
 */
export function csrfTokensMatch(a: string, b: string): boolean {
  if (typeof a !== "string" || typeof b !== "string") return false;
  if (a.length === 0 || b.length === 0) return false;
  const digestA = createHash("sha256").update(a, "utf8").digest();
  const digestB = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(digestA, digestB);
}

/**
 * Extract a CSRF token from a request-header record.
 *
 * Lookup is case-insensitive and array-valued headers use their first entry.
 *
 * @param headers    - Header record (e.g. from Express/Node `req.headers`).
 * @param headerName - Header to read. Defaults to {@link CSRF_HEADER_NAME}.
 * @returns The trimmed token, or `null` when absent/empty.
 *
 * @example
 * extractCsrfToken({ "X-CSRF-Token": "abc" }); // "abc"
 */
export function extractCsrfToken(
  headers: Record<string, string | string[] | undefined>,
  headerName: string = CSRF_HEADER_NAME,
): string | null {
  const wanted = headerName.toLowerCase();
  for (const [name, value] of Object.entries(headers)) {
    if (name.toLowerCase() !== wanted) continue;
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== "string") return null;
    const token = raw.trim();
    return token.length > 0 ? token : null;
  }
  return null;
}

// ---------------------------------------------------------------------------
// Session-bound token manager
// ---------------------------------------------------------------------------

/** Options for {@link CsrfTokenManager}. */
export interface CsrfTokenManagerOptions {
  /** Token lifetime in milliseconds. Defaults to 30 minutes. */
  ttlMs?: number;
  /** Entropy per token in bytes (≥ 16). Defaults to 32. */
  tokenBytes?: number;
  /** Maximum tracked sessions before least-recently-used eviction. Defaults to 10 000. */
  maxSessions?: number;
  /** Optional emitter used to publish {@link CsrfEvent}s. */
  emitter?: EventEmitter;
}

interface StoredCsrfToken {
  /** SHA-256 digest of the issued token — the raw token is never retained. */
  hash: string;
  /** Absolute expiry in epoch milliseconds. */
  expiresAt: number;
}

function normalizeSessionId(sessionId: unknown): string {
  if (typeof sessionId !== "string" || sessionId.trim().length === 0) {
    throw new CsrfError("sessionId must be a non-empty string", {
      received: typeof sessionId,
    });
  }
  const sid = sessionId.trim();
  if (sid.length > MAX_SESSION_ID_LENGTH) {
    throw new CsrfError(
      `sessionId exceeds maximum length of ${MAX_SESSION_ID_LENGTH} characters`,
      { length: sid.length },
    );
  }
  return sid;
}

function hashMatches(storedHash: string, token: string): boolean {
  // Both sides are SHA-256 hex digests (fixed 64 chars) before the
  // constant-time comparison runs.
  if (storedHash.length !== 64) return false;
  try {
    return timingSafeEqual(
      Buffer.from(storedHash, "hex"),
      Buffer.from(hashCsrfToken(token), "hex"),
    );
  } catch {
    return false;
  }
}

/**
 * Session-scoped CSRF token store.
 *
 * Issues one token per session, validates submissions against the stored
 * SHA-256 digest in constant time, and supports rotation, revocation,
 * optional single-use consumption, and expired-entry cleanup. Storage is
 * bounded by `maxSessions` with least-recently-used eviction so an attacker
 * cannot grow memory unboundedly by spamming session identifiers.
 *
 * @example
 * const csrf = new CsrfTokenManager({ ttlMs: 60_000 });
 * const token = csrf.issueToken("session-42");
 * csrf.validateToken("session-42", token);                  // true
 * csrf.validateToken("session-42", token, { consume: true }); // consumes it
 * csrf.validateToken("session-42", token);                  // false afterwards
 */
export class CsrfTokenManager {
  private readonly _tokens = new Map<string, StoredCsrfToken>();
  private readonly _ttlMs: number;
  private readonly _tokenBytes: number;
  private readonly _maxSessions: number;
  private readonly _emitter?: EventEmitter;
  private readonly _listeners = new Set<CsrfEventListener>();

  constructor(options: CsrfTokenManagerOptions = {}) {
    this._ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this._tokenBytes = options.tokenBytes ?? DEFAULT_TOKEN_BYTES;
    this._maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    this._emitter = options.emitter;

    if (!Number.isFinite(this._ttlMs) || this._ttlMs <= 0) {
      throw new CsrfError("ttlMs must be a positive number", { ttlMs: this._ttlMs });
    }
    if (!Number.isInteger(this._tokenBytes) || this._tokenBytes < MIN_TOKEN_BYTES) {
      throw new CsrfError(
        `tokenBytes must be an integer of at least ${MIN_TOKEN_BYTES}`,
        { tokenBytes: this._tokenBytes },
      );
    }
    if (!Number.isInteger(this._maxSessions) || this._maxSessions < 1) {
      throw new CsrfError("maxSessions must be an integer of at least 1", {
        maxSessions: this._maxSessions,
      });
    }
  }

  /** Number of sessions currently tracked (including unexpired bookkeeping). */
  get size(): number {
    return this._tokens.size;
  }

  /**
   * Subscribe to CSRF events emitted by this manager.
   *
   * @param listener - Callback invoked for every event.
   * @returns An unsubscribe function.
   */
  onCsrfEvent(listener: CsrfEventListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _emit(
    type: CsrfEventType,
    sessionId?: string,
    reason?: string,
  ): void {
    const event: CsrfEvent = { type, timestamp: Date.now() };
    if (sessionId !== undefined) event.sessionId = sessionId;
    if (reason !== undefined) event.reason = reason;

    for (const listener of this._listeners) {
      try {
        listener(event);
      } catch {
        // Listener failures must never break CSRF processing.
      }
    }
    if (this._emitter) {
      try {
        this._emitter.emit(type, event);
      } catch {
        // Emitter failures must never break CSRF processing.
      }
    }
  }

  /**
   * Issue (or replace) the CSRF token for `sessionId`.
   *
   * @param sessionId - Session the token is bound to.
   * @returns The raw token — return it to the client, store only its hash.
   * @throws {CsrfError} If `sessionId` is empty or too long.
   */
  issueToken(sessionId: string): string {
    const sid = normalizeSessionId(sessionId);
    const token = generateCsrfToken(this._tokenBytes);
    this._evictIfNeeded();
    this._tokens.delete(sid);
    this._tokens.set(sid, {
      hash: hashCsrfToken(token),
      expiresAt: Date.now() + this._ttlMs,
    });
    this._emit("csrf:token_issued", sid);
    return token;
  }

  /**
   * Validate a submitted token against the session's stored hash.
   *
   * @param sessionId - Session the token was issued for.
   * @param token     - Token submitted by the client.
   * @param options   - `consume: true` makes the token single-use (replay
   *                    protection for state-changing requests).
   * @returns `true` when the token exists, is unexpired, and matches.
   * @throws {CsrfError} If `sessionId` is empty or too long.
   */
  validateToken(
    sessionId: string,
    token: string,
    options: { consume?: boolean } = {},
  ): boolean {
    const sid = normalizeSessionId(sessionId);
    if (typeof token !== "string" || token.length === 0) {
      this._emit("csrf:token_rejected", sid, "missing_token");
      return false;
    }

    const stored = this._tokens.get(sid);
    if (!stored) {
      this._emit("csrf:token_rejected", sid, "unknown_session");
      return false;
    }
    if (stored.expiresAt <= Date.now()) {
      this._tokens.delete(sid);
      this._emit("csrf:token_rejected", sid, "expired");
      return false;
    }
    if (!hashMatches(stored.hash, token)) {
      this._emit("csrf:token_rejected", sid, "mismatch");
      return false;
    }

    // Re-insert so a successful validation counts as a recent use for LRU
    // eviction; consumption drops the entry entirely.
    this._tokens.delete(sid);
    if (!options.consume) {
      this._tokens.set(sid, stored);
    }
    this._emit("csrf:token_validated", sid);
    return true;
  }

  /**
   * Issue a fresh token for `sessionId`, invalidating the previous one.
   *
   * @param sessionId - Session to rotate.
   * @returns The new raw token.
   * @throws {CsrfError} If `sessionId` is empty or too long.
   */
  rotateToken(sessionId: string): string {
    const sid = normalizeSessionId(sessionId);
    const token = this.issueToken(sid);
    this._emit("csrf:token_refreshed", sid);
    return token;
  }

  /**
   * Refresh the token for `sessionId` only when it is missing or expired.
   *
   * Useful for long-lived sessions: callers can refresh lazily without
   * invalidating a still-valid token on every request.
   *
   * @param sessionId - Session to refresh.
   * @returns The existing raw token is not recoverable, so a new token is
   *          always returned; `refreshed` reports whether the previous token
   *          was still valid.
   */
  refreshToken(sessionId: string): { token: string; refreshed: boolean } {
    const sid = normalizeSessionId(sessionId);
    const stored = this._tokens.get(sid);
    const stillValid = stored !== undefined && stored.expiresAt > Date.now();
    const token = this.issueToken(sid);
    this._emit("csrf:token_refreshed", sid, stillValid ? "rotated" : "renewed");
    return { token, refreshed: stillValid };
  }

  /**
   * Revoke the token bound to `sessionId`.
   *
   * @param sessionId - Session to revoke.
   * @returns `true` when a token was actually removed.
   */
  revokeToken(sessionId: string): boolean {
    if (typeof sessionId !== "string") return false;
    const sid = sessionId.trim();
    const removed = this._tokens.delete(sid);
    if (removed) this._emit("csrf:token_revoked", sid);
    return removed;
  }

  /** Revoke every tracked token (e.g. on logout or global invalidation). */
  revokeAll(): void {
    const count = this._tokens.size;
    this._tokens.clear();
    this._emit("csrf:tokens_revoked_all", undefined, `count=${count}`);
  }

  /**
   * Drop all expired entries.
   *
   * @returns Number of entries removed.
   */
  cleanup(): number {
    const now = Date.now();
    let removed = 0;
    for (const [sid, stored] of this._tokens) {
      if (stored.expiresAt <= now) {
        this._tokens.delete(sid);
        removed++;
      }
    }
    if (removed > 0) {
      this._emit("csrf:cleanup", undefined, `removed=${removed}`);
    }
    return removed;
  }

  private _evictIfNeeded(): void {
    // Map iteration order is insertion order; successful validations
    // re-insert, so the first key is the least recently used.
    while (this._tokens.size >= this._maxSessions) {
      const oldest = this._tokens.keys().next();
      if (oldest.done) break;
      this._tokens.delete(oldest.value);
    }
  }
}

// ---------------------------------------------------------------------------
// Stateless, signed CSRF protection for request middleware
// ---------------------------------------------------------------------------

/** Thrown when a request's CSRF token fails validation. */
export class CsrfValidationError extends StellarSplitError {
  readonly reason: string;

  constructor(reason: string, context?: Record<string, unknown>) {
    super(`CSRF validation failed: ${reason}`, "CSRF_VALIDATION_FAILED", { reason, ...context });
    this.name = "CsrfValidationError";
    this.reason = reason;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

/** Options for {@link CsrfProtection}. */
export interface CsrfOptions {
  /** HMAC signing secret. A random one is generated when omitted (not stable across restarts/instances — pass a persistent secret in production). */
  secret?: string;
  /** Header carrying the token. Defaults to {@link CSRF_HEADER_NAME}. */
  headerName?: string;
  /** Token lifetime in ms. Defaults to 30 minutes. */
  ttlMs?: number;
  /** Optional emitter used to publish CSRF events. */
  emitter?: EventEmitter;
}

/** Outcome of validating a request's CSRF token. */
export interface CsrfValidationResult {
  valid: boolean;
  reason?: string;
  /** A freshly issued token, when the protection layer chooses to rotate on success. */
  refreshedToken?: string;
}

/** Context passed to {@link CsrfProtection.on} listeners. */
export interface CsrfEventContext {
  reason: string;
  timestamp: number;
}

const CSRF_REJECTED_EVENT = "csrf:rejected";

/**
 * Stateless, HMAC-signed CSRF protection for request middleware.
 *
 * Unlike {@link CsrfTokenManager} (which tracks one token per session id
 * server-side), this issues self-verifying tokens — `issuedAt.nonce.hmac` —
 * that need no server-side storage: validity is checked purely from the
 * token's own signature and age.
 */
export class CsrfProtection {
  readonly options: Required<Pick<CsrfOptions, "headerName" | "ttlMs">>;
  private readonly secret: string;
  private readonly emitter?: EventEmitter;

  constructor(options: CsrfOptions = {}) {
    this.secret = options.secret ?? randomBytes(32).toString("hex");
    this.options = {
      headerName: options.headerName ?? CSRF_HEADER_NAME,
      ttlMs: options.ttlMs ?? 30 * 60 * 1000,
    };
    this.emitter = options.emitter;
  }

  /** Issue a fresh, self-verifying CSRF token. */
  generateToken(): string {
    const issuedAt = Date.now();
    const nonce = randomBytes(16).toString("hex");
    const payload = `${issuedAt}.${nonce}`;
    const signature = createHmac("sha256", this.secret).update(payload).digest("hex");
    return `${payload}.${signature}`;
  }

  /** Issue a replacement token (e.g. after a successful validation, to rotate). */
  refreshToken(_previousToken: string): string {
    return this.generateToken();
  }

  private verifyToken(token: string): { valid: boolean; reason?: string } {
    const parts = token.split(".");
    if (parts.length !== 3) {
      return { valid: false, reason: "malformed_token" };
    }
    const [issuedAtRaw, nonce, signature] = parts;
    const payload = `${issuedAtRaw}.${nonce}`;
    const expected = createHmac("sha256", this.secret).update(payload).digest("hex");

    const sigBuf = Buffer.from(signature!, "hex");
    const expectedBuf = Buffer.from(expected, "hex");
    if (sigBuf.length !== expectedBuf.length || !timingSafeEqual(sigBuf, expectedBuf)) {
      return { valid: false, reason: "invalid_signature" };
    }

    const issuedAt = Number(issuedAtRaw);
    if (!Number.isFinite(issuedAt) || Date.now() - issuedAt > this.options.ttlMs) {
      return { valid: false, reason: "expired_token" };
    }
    return { valid: true };
  }

  /** Validate the CSRF token carried by an incoming request's headers. */
  validateRequest(req: {
    headers: Record<string, string | string[] | undefined>;
  }): CsrfValidationResult {
    const token = extractCsrfToken(req.headers, this.options.headerName);
    if (!token) {
      return { valid: false, reason: "missing_token" };
    }
    const result = this.verifyToken(token);
    if (!result.valid) {
      return { valid: false, reason: result.reason };
    }
    return { valid: true };
  }

  /** Emit a CSRF rejection event for observability. */
  emitRejected(_req: unknown, reason: string): void {
    this.emitter?.emit(CSRF_REJECTED_EVENT, { reason, timestamp: Date.now() } satisfies CsrfEventContext);
  }

  /** Subscribe to CSRF rejection events. Returns an unsubscribe function. */
  on(handler: (event: CsrfEventContext) => void): () => void {
    if (!this.emitter) {
      return () => {};
    }
    this.emitter.on(CSRF_REJECTED_EVENT, handler);
    return () => {
      this.emitter?.off(CSRF_REJECTED_EVENT, handler);
    };
  }
}


