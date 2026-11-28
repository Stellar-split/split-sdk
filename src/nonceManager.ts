/**
 * NonceManager — Automatic transaction nonce management and replay protection.
 *
 * Tracks nonce state per account, automatically increments nonces for sequential
 * transaction generation, handles resets and on-chain synchronization, and validates
 * nonces prior to submission to prevent replay attacks.
 */

import { StellarSplitError } from "./errors.js";

// ---------------------------------------------------------------------------
// Types & Interfaces
// ---------------------------------------------------------------------------

export interface NonceState {
  accountId: string;
  currentNonce: bigint;
  lastUpdated: number;
  inFlightNonces: bigint[];
}

export interface NonceManagerOptions {
  /**
   * Default starting nonce for newly tracked accounts (default: 0n).
   * Pass a plain `number` (instead of `bigint`) to also receive nonces
   * back as `number` from {@link NonceManager.acquireNextNonce} and friends.
   */
  initialNonce?: bigint | number;
  /** Amount to increment nonce by on each auto-increment (default: 1n). */
  incrementStep?: bigint | number;
  /** Maximum number of committed nonces retained in memory for replay protection (default: 1000). */
  replayWindowSize?: number;
  /** Time-to-live in milliseconds for replay protection entries (default: 300_000 ms = 5 min). */
  replayTtlMs?: number;
  /** Whether strict sequential ordering is required during validation (default: true). */
  strictOrdering?: boolean;
}

export interface NonceResetOptions {
  /** New nonce value to reset to. Defaults to 0n if omitted. */
  newNonce?: bigint;
  /** Reason for the reset (e.g. 'sync', 'reorg', 'manual', 'error'). */
  reason?: string;
  /** Whether to clear the seen replay history for this account. Defaults to false. */
  clearReplayHistory?: boolean;
}

export interface NonceValidationResult {
  valid: boolean;
  error?: string;
  expectedNonce?: bigint;
  receivedNonce?: bigint;
}

export interface NonceReservation {
  accountId: string;
  nonce: bigint | number;
  reservedAt: number;
}

export interface NonceStats {
  /** Total nonces issued via acquire/reserve. */
  issued: number;
  /** Nonces currently reserved/in-flight. */
  pending: number;
  /** Nonces committed successfully. */
  committed: number;
  /** Nonces rolled back or released. */
  rolledBack: number;
  /** Number of automatic recoveries performed (e.g. re-sync from Horizon). */
  recovered: number;
  /** Number of detected nonce conflicts. */
  conflicts: number;
  /** Number of accounts currently tracked. */
  trackedAccounts: number;
}

export interface NonceRecoveryOptions {
  /** Fetches the authoritative (on-chain) nonce for the account. */
  fetchFn: () => Promise<bigint | number | string>;
  /** Optional nonce that triggered the recovery (for diagnostics). */
  failedNonce?: bigint | number | string;
  /** Reason for recovery (e.g. 'SEQUENCE_NUMBER_TOO_OLD', 'mismatch'). */
  reason?: string;
}

export type NonceEventType =
  | "nonce:acquired"
  | "nonce:committed"
  | "nonce:rolled_back"
  | "nonce:reset"
  | "nonce:validation_failed"
  | "nonce:conflict";

export interface NonceEvent {
  type: NonceEventType;
  accountId: string;
  nonce?: bigint;
  previousNonce?: bigint;
  newNonce?: bigint;
  reason?: string;
  timestamp: number;
}

export type NonceEventListener = (event: NonceEvent) => void;

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export class NonceError extends StellarSplitError {
  constructor(message: string, code: string = "NONCE_ERROR", context?: Record<string, unknown>) {
    super(message, code, context);
    this.name = "NonceError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidNonceError extends NonceError {
  constructor(message: string, context?: Record<string, unknown>) {
    super(message, "INVALID_NONCE", context);
    this.name = "InvalidNonceError";
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class DuplicateNonceError extends NonceError {
  readonly nonce: bigint;

  constructor(accountId: string, nonce: bigint) {
    super(
      `Replay attack detected: nonce ${nonce.toString()} has already been used for account ${accountId}.`,
      "DUPLICATE_NONCE",
      { accountId, nonce: nonce.toString() }
    );
    this.name = "DuplicateNonceError";
    this.nonce = nonce;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class StaleNonceError extends NonceError {
  readonly expectedNonce: bigint;
  readonly receivedNonce: bigint;

  constructor(accountId: string, expectedNonce: bigint, receivedNonce: bigint) {
    super(
      `Stale nonce: expected nonce ${expectedNonce.toString()}, but received ${receivedNonce.toString()} for account ${accountId}.`,
      "STALE_NONCE",
      { accountId, expectedNonce: expectedNonce.toString(), receivedNonce: receivedNonce.toString() }
    );
    this.name = "StaleNonceError";
    this.expectedNonce = expectedNonce;
    this.receivedNonce = receivedNonce;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class NonceGapError extends NonceError {
  readonly expectedNonce: bigint;
  readonly receivedNonce: bigint;

  constructor(accountId: string, expectedNonce: bigint, receivedNonce: bigint) {
    super(
      `Nonce gap detected: expected nonce ${expectedNonce.toString()}, but received ${receivedNonce.toString()} for account ${accountId}.`,
      "NONCE_GAP",
      { accountId, expectedNonce: expectedNonce.toString(), receivedNonce: receivedNonce.toString() }
    );
    this.name = "NonceGapError";
    this.expectedNonce = expectedNonce;
    this.receivedNonce = receivedNonce;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

// ---------------------------------------------------------------------------
// NonceManager Implementation
// ---------------------------------------------------------------------------

export class NonceManager {
  private readonly defaultInitialNonce: bigint;
  private readonly incrementStep: bigint;
  private readonly replayWindowSize: number;
  private readonly replayTtlMs: number;
  private readonly strictOrdering: boolean;
  /**
   * When the manager is constructed with plain `number` options (instead of
   * `bigint`), nonces are returned to callers as `number` too, so e.g.
   * `acquireNextNonce()` round-trips the same numeric type that was
   * configured. Internal state is always tracked in `bigint`.
   */
  private readonly numericMode: boolean;

  /** Tracked accounts and their nonce states. */
  private readonly states = new Map<string, NonceState>();

  /**
   * Replay detection cache: map accountId -> Map(nonceString -> timestamp).
   */
  private readonly committedNonces = new Map<string, Map<string, number>>();

  /** Event listeners */
  private readonly listeners = new Set<NonceEventListener>();

  /** Per-account serialization queues for atomic reservations. */
  private readonly accountLocks = new Map<string, Promise<void>>();

  /** Aggregate statistics counters. */
  private stats: NonceStats = {
    issued: 0,
    pending: 0,
    committed: 0,
    rolledBack: 0,
    recovered: 0,
    conflicts: 0,
    trackedAccounts: 0,
  };

  constructor(options: NonceManagerOptions = {}) {
    this.numericMode =
      typeof options.initialNonce === "number" || typeof options.incrementStep === "number";
    this.defaultInitialNonce = BigInt(options.initialNonce ?? 0);
    this.incrementStep = BigInt(options.incrementStep ?? 1);
    this.replayWindowSize = options.replayWindowSize ?? 1000;
    this.replayTtlMs = options.replayTtlMs ?? 300_000;
    this.strictOrdering = options.strictOrdering ?? true;
  }

  /** Convert an internal bigint nonce to the manager's configured public numeric type. */
  private toPublic(value: bigint): bigint | number {
    return this.numericMode ? Number(value) : value;
  }

  // -------------------------------------------------------------------------
  // Account Tracking & State
  // -------------------------------------------------------------------------

  /**
   * Register or initialize tracking for an account.
   * If already tracked, returns existing state without overwriting.
   */
  trackAccount(accountId: string, initialNonce?: bigint): NonceState {
    if (!accountId || typeof accountId !== "string") {
      throw new InvalidNonceError("Invalid accountId: must be a non-empty string.");
    }

    let state = this.states.get(accountId);
    if (!state) {
      state = {
        accountId,
        currentNonce: initialNonce ?? this.defaultInitialNonce,
        lastUpdated: Date.now(),
        inFlightNonces: [],
      };
      this.states.set(accountId, state);
    }
    return { ...state, inFlightNonces: [...state.inFlightNonces] };
  }

  /**
   * Check whether an account is currently tracked.
   */
  hasAccount(accountId: string): boolean {
    return this.states.has(accountId);
  }

  /**
   * Get the current nonce state for an account.
   * If not already tracked, initializes it.
   */
  getNonceState(accountId: string): NonceState {
    this.ensureTracked(accountId);
    const state = this.states.get(accountId)!;
    return { ...state, inFlightNonces: [...state.inFlightNonces] };
  }

  /**
   * Get the current nonce for an account.
   */
  getNonce(accountId: string): bigint {
    return this.getNonceState(accountId).currentNonce;
  }

  /**
   * Peek at the next nonce that will be returned by auto-increment,
   * without mutating state or advancing the counter.
   */
  peekNextNonce(accountId: string): bigint {
    const state = this.getNonceState(accountId);
    return state.currentNonce;
  }

  // -------------------------------------------------------------------------
  // Auto-Increment & Lifecycle
  // -------------------------------------------------------------------------

  /**
   * Acquire the next nonce for transaction creation and automatically increment
   * the tracked counter.
   *
   * The returned nonce is placed into `inFlightNonces` until committed or rolled back.
   */
  acquireNextNonce(accountId: string): bigint | number {
    this.ensureTracked(accountId);
    const state = this.states.get(accountId)!;

    const nonceToIssue = state.currentNonce;
    state.currentNonce += this.incrementStep;
    state.lastUpdated = Date.now();
    state.inFlightNonces.push(nonceToIssue);

    this.stats.issued += 1;
    this.stats.pending += 1;

    this.emit({
      type: "nonce:acquired",
      accountId,
      nonce: nonceToIssue,
      timestamp: Date.now(),
    });

    return this.toPublic(nonceToIssue);
  }

  /**
   * Get the current nonce for an account in the manager's configured public
   * numeric type (see {@link NonceManagerOptions.initialNonce}).
   */
  getCurrentNonce(accountId: string): bigint | number {
    return this.toPublic(this.getNonceState(accountId).currentNonce);
  }

  /**
   * Get the list of currently in-flight (acquired but not yet committed or
   * rolled back) nonces for an account.
   */
  getInFlightNonces(accountId: string): Array<bigint | number> {
    return this.getNonceState(accountId).inFlightNonces.map((n) => this.toPublic(n));
  }

  /**
   * Atomically reserve the next nonce for an account.
   *
   * Reservations for the same account are serialized so concurrent callers can
   * never receive the same nonce. The returned reservation must be either
   * committed via {@link commitNonce} or released via {@link releaseNonce}.
   */
  async reserveNonce(accountId: string): Promise<NonceReservation> {
    return this.withAccountLock(accountId, () => {
      const nonce = this.acquireNextNonce(accountId);
      return {
        accountId,
        nonce,
        reservedAt: Date.now(),
      };
    });
  }

  /**
   * Release a previously reserved nonce without committing it.
   * Rolls the counter back when possible so the nonce can be reused.
   */
  releaseNonce(accountId: string, nonce: bigint | number | string): void {
    const parsed = this.parseNonce(nonce);
    this.ensureTracked(accountId);
    const state = this.states.get(accountId)!;

    const idx = state.inFlightNonces.indexOf(parsed);
    if (idx === -1) {
      // Nothing to release; treat as a conflict signal.
      this.stats.conflicts += 1;
      return;
    }

    this.rollbackNonce(accountId, parsed);
  }

  /**
   * Detect whether a nonce conflicts with current tracked state
   * (already committed, or currently in-flight).
   */
  detectConflict(accountId: string, nonce: bigint | number | string): boolean {
    const parsed = this.parseNonce(nonce);
    const state = this.getNonceState(accountId);

    if (state.inFlightNonces.includes(parsed)) {
      return true;
    }

    const history = this.committedNonces.get(accountId);
    if (history && history.has(parsed.toString())) {
      const seenTime = history.get(parsed.toString())!;
      if (Date.now() - seenTime <= this.replayTtlMs) {
        return true;
      }
    }

    return false;
  }

  /**
   * Alias for {@link acquireNextNonce}.
   */
  consumeNonce(accountId: string): bigint | number {
    return this.acquireNextNonce(accountId);
  }

  /**
   * Commit a nonce after transaction submission or confirmation.
   * Records the nonce into the replay detection cache to prevent replays.
   */
  commitNonce(accountId: string, nonce: bigint | number | string): void {
    const parsed = this.parseNonce(nonce);
    this.ensureTracked(accountId);
    const state = this.states.get(accountId)!;

    // Remove from in-flight list if present
    const idx = state.inFlightNonces.indexOf(parsed);
    if (idx !== -1) {
      state.inFlightNonces.splice(idx, 1);
      if (this.stats.pending > 0) {
        this.stats.pending -= 1;
      }
    }

    // Add to committed replay protection map
    let history = this.committedNonces.get(accountId);
    if (!history) {
      history = new Map<string, number>();
      this.committedNonces.set(accountId, history);
    }

    const key = parsed.toString();
    history.set(key, Date.now());

    // Prune expired or excessive entries
    this.pruneReplayCache(history);

    this.stats.committed += 1;

    this.emit({
      type: "nonce:committed",
      accountId,
      nonce: parsed,
      timestamp: Date.now(),
    });
  }

  /**
   * Roll back an acquired in-flight nonce (e.g. if transaction construction
   * or signing failed before network broadcast).
   */
  rollbackNonce(accountId: string, nonce: bigint | number | string): void {
    const parsed = this.parseNonce(nonce);
    this.ensureTracked(accountId);
    const state = this.states.get(accountId)!;

    const idx = state.inFlightNonces.indexOf(parsed);
    if (idx !== -1) {
      state.inFlightNonces.splice(idx, 1);
      if (this.stats.pending > 0) {
        this.stats.pending -= 1;
      }
    }

    // If this was the most recently issued nonce and currentNonce matches next step,
    // step currentNonce back down so it can be reused.
    //
    // In numericMode this reuse-after-rollback behavior is skipped: nonces
    // are never reused once issued, even if rolled back, so the counter only
    // ever advances via acquireNextNonce. This matches callers that treat a
    // rolled-back nonce as a permanently burned slot rather than risking a
    // collision with another concurrently in-flight reservation.
    if (!this.numericMode && state.currentNonce === parsed + this.incrementStep) {
      state.currentNonce = parsed;
    }

    this.stats.rolledBack += 1;

    this.emit({
      type: "nonce:rolled_back",
      accountId,
      nonce: parsed,
      timestamp: Date.now(),
    });
  }

  // -------------------------------------------------------------------------
  // Resets & Synchronization
  // -------------------------------------------------------------------------

  /**
   * Handle nonce reset for an account.
   * Can be used to recover from desynchronization or explicit reset.
   */
  resetNonce(accountId: string, options?: NonceResetOptions | bigint): void {
    this.ensureTracked(accountId);
    const state = this.states.get(accountId)!;
    const previous = state.currentNonce;

    let targetNonce = 0n;
    let reason = "manual";
    let clearReplay = false;

    if (typeof options === "bigint") {
      targetNonce = options;
    } else if (options) {
      if (options.newNonce !== undefined) {
        targetNonce = options.newNonce;
      }
      if (options.reason) {
        reason = options.reason;
      }
      clearReplay = options.clearReplayHistory ?? false;
    }

    if (targetNonce < 0n) {
      throw new InvalidNonceError(`Cannot reset nonce to negative value: ${targetNonce.toString()}`);
    }

    state.currentNonce = targetNonce;
    state.inFlightNonces = [];
    state.lastUpdated = Date.now();

    if (clearReplay) {
      this.committedNonces.delete(accountId);
    }

    this.emit({
      type: "nonce:reset",
      accountId,
      previousNonce: previous,
      newNonce: targetNonce,
      reason,
      timestamp: Date.now(),
    });
  }

  /**
   * Synchronize the account's nonce with an external / on-chain source.
   */
  async syncNonce(accountId: string, fetchFn: () => Promise<bigint | number | string>): Promise<bigint> {
    const onChainVal = await fetchFn();
    const parsed = this.parseNonce(onChainVal);
    this.resetNonce(accountId, { newNonce: parsed, reason: "sync" });
    return parsed;
  }

  /**
   * Automatically recover from a nonce mismatch or a
   * SEQUENCE_NUMBER_TOO_OLD-style error by re-syncing from the authoritative
   * source (e.g. Horizon) and clearing in-flight reservations.
   *
   * Returns the recovered (authoritative) nonce.
   */
  async recoverNonce(accountId: string, options: NonceRecoveryOptions): Promise<bigint> {
    return this.withAccountLock(accountId, async () => {
      this.ensureTracked(accountId);
      const state = this.states.get(accountId)!;

      // Any in-flight reservations are now invalid; roll them back.
      const inFlight = [...state.inFlightNonces];
      for (const nonce of inFlight) {
        this.rollbackNonce(accountId, nonce);
      }

      const onChainVal = await options.fetchFn();
      const parsed = this.parseNonce(onChainVal);

      this.resetNonce(accountId, {
        newNonce: parsed,
        reason: options.reason ?? "recovery",
      });

      this.stats.recovered += 1;

      return parsed;
    });
  }

  /**
   * Handle a submission failure by automatically recovering the nonce when the
   * error indicates a stale/too-old sequence number. Returns the recovered
   * nonce, or `undefined` if the error is not nonce-related.
   */
  async handleSubmissionError(
    accountId: string,
    error: unknown,
    fetchFn: () => Promise<bigint | number | string>
  ): Promise<bigint | undefined> {
    const message = error instanceof Error ? error.message : String(error);
    const isNonceError =
      /SEQUENCE_NUMBER_TOO_OLD|SEQUENCE_NUMBER_TOO_NEW|tx_bad_seq|stale nonce|nonce gap/i.test(message);

    if (!isNonceError) {
      return undefined;
    }

    this.stats.conflicts += 1;
    return this.recoverNonce(accountId, {
      fetchFn,
      reason: message,
    });
  }

  /**
   * Snapshot of aggregate nonce statistics.
   */
  getStats(accountId?: string): NonceStats {
    if (accountId === undefined) {
      return {
        ...this.stats,
        pending: this.countPending(),
        trackedAccounts: this.states.size,
      };
    }
    const state = this.states.get(accountId);
    return {
      ...this.stats,
      pending: state?.inFlightNonces.length ?? 0,
      trackedAccounts: state ? 1 : 0,
    };
  }

  /**
   * Record that `nonce` was issued externally (e.g. by a sequence cache
   * managing its own counter) so later {@link detectConflict} calls and
   * replay protection can see it.
   */
  recordIssued(accountId: string, nonce: bigint | number | string): void {
    this.ensureTracked(accountId);
    this.stats.issued += 1;
    this.commitNonce(accountId, nonce);
  }

  /**
   * Flag `nonce` as having conflicted (e.g. rejected on-chain with a stale
   * sequence error). Returns whether the account was already tracked.
   */
  markConflict(accountId: string, nonce: bigint | number | string): boolean {
    const known = this.states.has(accountId);
    this.ensureTracked(accountId);
    this.stats.conflicts += 1;
    this.emit({
      type: "nonce:conflict",
      accountId,
      nonce: this.parseNonce(nonce),
      timestamp: Date.now(),
    });
    return known;
  }

  /**
   * Synchronize an account's tracked nonce to match a freshly fetched
   * on-chain value, discarding any stale in-flight reservations.
   */
  syncBase(accountId: string, base: bigint): void {
    this.ensureTracked(accountId);
    const state = this.states.get(accountId)!;
    state.currentNonce = base;
    state.inFlightNonces = [];
    state.lastUpdated = Date.now();
  }

  /**
   * Reset tracked nonce state. With `accountId`, resets just that account
   * (alias for {@link resetNonce}); with no argument, resets every tracked
   * account back to its default initial nonce.
   */
  reset(accountId?: string): void {
    if (accountId !== undefined) {
      this.resetNonce(accountId);
      return;
    }
    for (const id of [...this.states.keys()]) {
      this.resetNonce(id);
    }
  }

  /**
   * Reset statistics counters (does not affect tracked nonce state).
   */
  resetStats(): void {
    this.stats = {
      issued: 0,
      pending: 0,
      committed: 0,
      rolledBack: 0,
      recovered: 0,
      conflicts: 0,
      trackedAccounts: this.states.size,
    };
  }

  // -------------------------------------------------------------------------
  // Validation Before Send
  // -------------------------------------------------------------------------

  /**
   * Validate a nonce before sending a transaction.
   * Throws typed errors (DuplicateNonceError, StaleNonceError, NonceGapError, InvalidNonceError)
   * if validation fails.
   */
  validateBeforeSend(
    accountId: string,
    nonce: bigint | number | string,
    options?: { strictOrdering?: boolean }
  ): void {
    const result = this.validate(accountId, nonce, options);
    if (!result.valid) {
      this.emit({
        type: "nonce:validation_failed",
        accountId,
        nonce: result.receivedNonce,
        reason: result.error ?? "Validation failed",
        timestamp: Date.now(),
      });

      if (result.error?.includes("Replay attack")) {
        throw new DuplicateNonceError(accountId, result.receivedNonce!);
      }
      if (result.error?.includes("Stale")) {
        throw new StaleNonceError(accountId, result.expectedNonce!, result.receivedNonce!);
      }
      if (result.error?.includes("gap")) {
        throw new NonceGapError(accountId, result.expectedNonce!, result.receivedNonce!);
      }
      throw new InvalidNonceError(result.error ?? "Invalid nonce");
    }
  }

  /**
   * Pure check method that returns validation details without throwing.
   */
  validate(
    accountId: string,
    nonce: bigint | number | string,
    options?: { strictOrdering?: boolean }
  ): NonceValidationResult {
    let parsed: bigint;
    try {
      parsed = this.parseNonce(nonce);
    } catch (err) {
      return {
        valid: false,
        error: err instanceof Error ? err.message : "Invalid nonce format",
      };
    }

    // 1. Replay attack check: has this nonce already been committed?
    const history = this.committedNonces.get(accountId);
    if (history && history.has(parsed.toString())) {
      const seenTime = history.get(parsed.toString())!;
      const now = Date.now();
      if (now - seenTime <= this.replayTtlMs) {
        return {
          valid: false,
          error: `Replay attack detected: nonce ${parsed.toString()} was already committed for account ${accountId}`,
          receivedNonce: parsed,
        };
      }
    }

    // 2. Ordering check against current state
    const state = this.getNonceState(accountId);
    const expected = state.currentNonce;
    const isStrict = options?.strictOrdering ?? this.strictOrdering;

    if (parsed < expected) {
      // Check if it's currently marked as in-flight
      const isInFlight = state.inFlightNonces.includes(parsed);
      if (!isInFlight) {
        return {
          valid: false,
          error: `Stale nonce: received ${parsed.toString()} is lower than expected nonce ${expected.toString()}`,
          expectedNonce: expected,
          receivedNonce: parsed,
        };
      }
    } else if (isStrict && parsed > expected) {
      return {
        valid: false,
        error: `Nonce gap: received ${parsed.toString()} but expected ${expected.toString()}`,
        expectedNonce: expected,
        receivedNonce: parsed,
      };
    }

    return {
      valid: true,
      expectedNonce: expected,
      receivedNonce: parsed,
    };
  }

  // -------------------------------------------------------------------------
  // Event Subscription & Utilities
  // -------------------------------------------------------------------------

  /**
   * Subscribe to nonce lifecycle events. Returns unsubscribe function.
   */
  onEvent(listener: NonceEventListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  /**
   * Clear all tracked accounts and state.
   */
  clear(): void {
    this.states.clear();
    this.committedNonces.clear();
    this.listeners.clear();
    this.accountLocks.clear();
    this.resetStats();
  }

  /**
   * Total number of tracked accounts.
   */
  get size(): number {
    return this.states.size;
  }

  // -------------------------------------------------------------------------
  // Internal Helpers
  // -------------------------------------------------------------------------

  private ensureTracked(accountId: string): void {
    if (!this.states.has(accountId)) {
      this.trackAccount(accountId);
    }
  }

  /**
   * Serialize operations per account to guarantee atomic reservations.
   */
  private async withAccountLock<T>(accountId: string, fn: () => T | Promise<T>): Promise<T> {
    const previous = this.accountLocks.get(accountId) ?? Promise.resolve();

    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });

    const chained = previous.then(() => gate);
    this.accountLocks.set(accountId, chained);

    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.accountLocks.get(accountId) === chained) {
        this.accountLocks.delete(accountId);
      }
    }
  }

  private countPending(): number {
    let total = 0;
    for (const state of this.states.values()) {
      total += state.inFlightNonces.length;
    }
    return total;
  }

  private parseNonce(val: bigint | number | string): bigint {
    if (typeof val === "bigint") {
      if (val < 0n) throw new InvalidNonceError(`Nonce cannot be negative: ${val.toString()}`);
      return val;
    }
    if (typeof val === "number") {
      if (!Number.isFinite(val) || !Number.isInteger(val) || val < 0) {
        throw new InvalidNonceError(`Nonce must be a non-negative integer: ${val}`);
      }
      return BigInt(val);
    }
    if (typeof val === "string") {
      const trimmed = val.trim();
      if (!/^\d+$/.test(trimmed)) {
        throw new InvalidNonceError(`Invalid numeric nonce string: "${val}"`);
      }
      return BigInt(trimmed);
    }
    throw new InvalidNonceError(`Unsupported nonce type: ${typeof val}`);
  }

  private pruneReplayCache(history: Map<string, number>): void {
    const now = Date.now();
    for (const [nonceStr, timestamp] of history) {
      if (now - timestamp > this.replayTtlMs) {
        history.delete(nonceStr);
      }
    }
    while (history.size > this.replayWindowSize) {
      const oldestKey = history.keys().next().value;
      if (oldestKey !== undefined) {
        history.delete(oldestKey);
      } else {
        break;
      }
    }
  }

  private emit(event: NonceEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (err) {
        console.error("Error in NonceManager event listener:", err);
      }
    }
  }
}
