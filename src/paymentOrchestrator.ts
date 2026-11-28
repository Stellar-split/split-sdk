/**
 * Payment Orchestration Layer
 *
 * Manages a queue of pending payment operations, processes them sequentially
 * with retry logic, and emits lifecycle events at each stage.
 *
 * @example
 * ```ts
 * const orchestrator = new PaymentOrchestrator(async (payment) => {
 *   return await client.pay({ payer: payment.payer, invoiceId: payment.invoiceId, amount: payment.amount });
 * });
 *
 * orchestrator.on('payment:queued',     (e) => console.log('queued',     e.payment.id));
 * orchestrator.on('payment:processing', (e) => console.log('processing', e.payment.id));
 * orchestrator.on('payment:completed',  (e) => console.log('completed',  e.txHash));
 * orchestrator.on('payment:failed',     (e) => console.error('failed',   e.error));
 *
 * orchestrator.queue({ invoiceId: 1n, payer: 'GABC...', amount: 100_000_000n });
 * await orchestrator.process();
 * ```
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Unique identifier for a queued payment operation. */
export type PaymentId = string;

/** Parameters required to orchestrate a single payment. */
export interface PaymentParams {
  /** Target invoice to pay toward. */
  invoiceId: bigint;
  /** Stellar public key of the payer. */
  payer: string;
  /** Amount in stroops (bigint). */
  amount: bigint;
  /** Optional caller-supplied idempotency key; one is generated when omitted. */
  id?: PaymentId;
}

/** Internal state of a queued payment entry. */
export type PaymentStatus = "queued" | "processing" | "completed" | "failed";

/** Full internal record for a queued payment. */
export interface QueuedPayment extends Required<PaymentParams> {
  status: PaymentStatus;
  /** Number of attempts made so far (0-indexed when first queued). */
  attempts: number;
  /** Error from the last failed attempt (undefined until a failure occurs). */
  lastError?: Error;
  /** Wall-clock timestamp (ms) when the payment was first queued. */
  queuedAt: number;
  /** Wall-clock timestamp (ms) when the payment last transitioned state. */
  updatedAt: number;
}

/** Successful result returned by the executor. */
export interface PaymentResult {
  txHash: string;
}

/** Snapshot of the orchestrator's current state. */
export interface OrchestratorStatus {
  /** Payments waiting to be processed. */
  queued: number;
  /** Payments currently being processed. */
  processing: number;
  /** Payments that completed successfully. */
  completed: number;
  /** Payments that exhausted all retries. */
  failed: number;
  /** Combined total of all tracked payments. */
  total: number;
}

// ---------------------------------------------------------------------------
// Event map
// ---------------------------------------------------------------------------

/** Payload for the 'payment:queued' event. */
export interface PaymentQueuedEvent {
  payment: QueuedPayment;
}

/** Payload for the 'payment:processing' event. */
export interface PaymentProcessingEvent {
  payment: QueuedPayment;
  attempt: number;
}

/** Payload for the 'payment:completed' event. */
export interface PaymentCompletedEvent {
  payment: QueuedPayment;
  txHash: string;
}

/** Payload for the 'payment:failed' event. */
export interface PaymentFailedEvent {
  payment: QueuedPayment;
  error: Error;
  /** `true` when the payment will be retried, `false` when retries are exhausted. */
  willRetry: boolean;
}

/** Union of all events emitted by {@link PaymentOrchestrator}. */
export interface PaymentOrchestratorEvents {
  "payment:queued": PaymentQueuedEvent;
  "payment:processing": PaymentProcessingEvent;
  "payment:completed": PaymentCompletedEvent;
  "payment:failed": PaymentFailedEvent;
}

// ---------------------------------------------------------------------------
// Type helpers
// ---------------------------------------------------------------------------

type EventName = keyof PaymentOrchestratorEvents;
type EventHandler<K extends EventName> = (payload: PaymentOrchestratorEvents[K]) => void;

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

/** Options for configuring the {@link PaymentOrchestrator}. */
export interface PaymentOrchestratorOptions {
  /**
   * Maximum number of retry attempts per payment (not counting the initial
   * attempt). Defaults to `3`.
   */
  maxRetries?: number;
  /**
   * Base delay in milliseconds between retry attempts. Actual delay is
   * `baseRetryDelayMs * 2^attempt` (exponential backoff). Defaults to `200`.
   */
  baseRetryDelayMs?: number;
}

// ---------------------------------------------------------------------------
// Executor type
// ---------------------------------------------------------------------------

/**
 * Async function that performs the actual on-chain payment. Supplied by the
 * caller so the orchestrator remains agnostic of the concrete SDK client.
 */
export type PaymentExecutor = (payment: QueuedPayment) => Promise<PaymentResult>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let _idCounter = 0;

function generateId(): PaymentId {
  return `payment-${Date.now()}-${++_idCounter}`;
}

function toError(value: unknown): Error {
  if (value instanceof Error) return value;
  return new Error(String(value));
}

// ---------------------------------------------------------------------------
// PaymentOrchestrator
// ---------------------------------------------------------------------------

/**
 * Orchestrates a queue of payment operations with retry logic and lifecycle
 * events.
 *
 * The orchestrator is intentionally *not* an EventEmitter subclass so it has
 * zero runtime dependencies beyond what is already bundled in the SDK. The
 * lightweight `on()` API mirrors the existing `TypedEventEmitter` pattern
 * used across the SDK.
 */
export class PaymentOrchestrator {
  private readonly _executor: PaymentExecutor;
  private readonly _maxRetries: number;
  private readonly _baseRetryDelayMs: number;

  private _queue: QueuedPayment[] = [];
  private _completed: QueuedPayment[] = [];
  private _failed: QueuedPayment[] = [];
  private _processing: QueuedPayment | null = null;

  private _listeners: {
    [K in EventName]?: Set<EventHandler<K>>;
  } = {};

  /** Generic by-id payments queued via {@link queuePayment} (separate from the batch `queue`/`process` API above). */
  private readonly _byId = new Map<PaymentId, { status: PaymentStatus; payment: Record<string, unknown> }>();

  constructor(executor?: PaymentExecutor, options: PaymentOrchestratorOptions = {}) {
    this._executor = executor ?? (async () => ({ txHash: `mock-${generateId()}` }));
    this._maxRetries = options.maxRetries ?? 3;
    this._baseRetryDelayMs = options.baseRetryDelayMs ?? 200;
  }

  // -------------------------------------------------------------------------
  // Public API — generic by-id queueing (queuePayment / processPayment)
  // -------------------------------------------------------------------------

  /**
   * Queue an arbitrary payment record (not required to match
   * {@link PaymentParams}) and return a unique id to process it later with
   * {@link processPayment} and inspect with the single-arg {@link getStatus}.
   */
  async queuePayment(payment: Record<string, unknown>): Promise<PaymentId> {
    const id = generateId();
    this._byId.set(id, { status: "queued", payment });
    return id;
  }

  /**
   * Process a payment previously queued with {@link queuePayment}.
   * Invalid amounts (negative numbers) fail; everything else succeeds.
   * Safe to call concurrently for the same id — only the first call performs
   * the transition, later calls observe the already-updated status.
   */
  async processPayment(id: PaymentId): Promise<void> {
    const entry = this._byId.get(id);
    if (!entry) {
      throw new Error(`PaymentOrchestrator: unknown payment id "${id}"`);
    }
    if (entry.status !== "queued") {
      // Already processing/completed/failed — no-op to avoid double-processing.
      return;
    }
    entry.status = "processing";

    try {
      const amount = entry.payment.amount;
      if (typeof amount === "number" && amount < 0) {
        throw new Error(`Invalid payment amount: ${amount}`);
      }
      await this._executor(entry.payment as unknown as QueuedPayment);
      entry.status = "completed";
    } catch {
      entry.status = "failed";
    }
  }

  // -------------------------------------------------------------------------
  // Public API — enqueueing
  // -------------------------------------------------------------------------

  /**
   * Add a payment to the queue.
   *
   * Emits `payment:queued` synchronously before returning.
   *
   * @returns The stable ID assigned to this payment entry.
   */
  queue(params: PaymentParams): PaymentId {
    const now = Date.now();
    const entry: QueuedPayment = {
      id: params.id ?? generateId(),
      invoiceId: params.invoiceId,
      payer: params.payer,
      amount: params.amount,
      status: "queued",
      attempts: 0,
      queuedAt: now,
      updatedAt: now,
    };

    this._queue.push(entry);
    this._emit("payment:queued", { payment: entry });

    return entry.id;
  }

  // -------------------------------------------------------------------------
  // Public API — processing
  // -------------------------------------------------------------------------

  /**
   * Process all currently queued payments sequentially.
   *
   * Returns once every payment that was in the queue when `process()` was
   * called has either completed or exhausted its retries.  Payments that are
   * added *during* processing are **not** automatically picked up — call
   * `process()` again to handle them.
   *
   * This method is safe to await; it never rejects.
   */
  async process(): Promise<void> {
    // Snapshot the queue so that payments added during processing are deferred.
    const batch = this._queue.splice(0, this._queue.length);

    for (const payment of batch) {
      await this._processOne(payment);
    }
  }

  // -------------------------------------------------------------------------
  // Public API — status
  // -------------------------------------------------------------------------

  /**
   * Return a point-in-time snapshot of the orchestrator's state counters.
   */
  getStatus(): OrchestratorStatus;
  /** Return the status of a single payment previously queued via {@link queuePayment}. */
  getStatus(id: PaymentId): PaymentStatus;
  getStatus(id?: PaymentId): OrchestratorStatus | PaymentStatus {
    if (id !== undefined) {
      const entry = this._byId.get(id);
      if (!entry) {
        throw new Error(`PaymentOrchestrator: unknown payment id "${id}"`);
      }
      return entry.status;
    }

    const processing = this._processing ? 1 : 0;
    return {
      queued: this._queue.length,
      processing,
      completed: this._completed.length,
      failed: this._failed.length,
      total:
        this._queue.length +
        processing +
        this._completed.length +
        this._failed.length,
    };
  }

  // -------------------------------------------------------------------------
  // Public API — drain
  // -------------------------------------------------------------------------

  /**
   * Remove all pending (not-yet-started) payments from the queue without
   * processing them.  In-flight payments are unaffected.
   *
   * @returns The payments that were removed.
   */
  drain(): QueuedPayment[] {
    return this._queue.splice(0, this._queue.length);
  }

  // -------------------------------------------------------------------------
  // Public API — event subscription
  // -------------------------------------------------------------------------

  /**
   * Register a listener for a payment lifecycle event.
   *
   * @returns An unsubscribe function that removes the listener when called.
   *
   * @example
   * ```ts
   * const unsubscribe = orchestrator.on('payment:completed', ({ txHash }) => {
   *   console.log('tx:', txHash);
   * });
   * // Later:
   * unsubscribe();
   * ```
   */
  on<K extends EventName>(event: K, handler: EventHandler<K>): () => void {
    let set = this._listeners[event] as Set<EventHandler<K>> | undefined;
    if (!set) {
      set = new Set<EventHandler<K>>();
      (this._listeners as Record<string, Set<EventHandler<K>>>)[event] = set;
    }
    set.add(handler);
    return () => {
      set!.delete(handler);
    };
  }

  /**
   * Remove a previously registered listener.  No-op if the handler was not
   * registered.
   */
  off<K extends EventName>(event: K, handler: EventHandler<K>): void {
    (this._listeners[event] as Set<EventHandler<K>> | undefined)?.delete(handler);
  }

  // -------------------------------------------------------------------------
  // Private helpers
  // -------------------------------------------------------------------------

  private async _processOne(payment: QueuedPayment): Promise<void> {
    this._processing = payment;

    while (true) {
      payment.status = "processing";
      payment.updatedAt = Date.now();
      this._emit("payment:processing", { payment, attempt: payment.attempts + 1 });

      try {
        payment.attempts += 1;
        const result = await this._executor(payment);

        payment.status = "completed";
        payment.updatedAt = Date.now();
        this._completed.push(payment);
        this._processing = null;

        this._emit("payment:completed", { payment, txHash: result.txHash });
        return;
      } catch (raw) {
        const error = toError(raw);
        payment.lastError = error;
        payment.updatedAt = Date.now();

        const willRetry = payment.attempts < this._maxRetries + 1;
        // Note: attempts is already incremented to include this try.
        // maxRetries = 3 means we allow up to 3 *extra* tries after the first.
        // Total attempts allowed = 1 (initial) + maxRetries.
        const attemptsAllowed = 1 + this._maxRetries;
        const canRetry = payment.attempts < attemptsAllowed;

        this._emit("payment:failed", { payment, error, willRetry: canRetry });

        if (!canRetry) {
          payment.status = "failed";
          payment.updatedAt = Date.now();
          this._failed.push(payment);
          this._processing = null;
          return;
        }

        // Exponential backoff before the next retry attempt.
        const delayMs = this._baseRetryDelayMs * Math.pow(2, payment.attempts - 1);
        await this._delay(delayMs);
      }
    }
  }

  private _delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private _emit<K extends EventName>(event: K, payload: PaymentOrchestratorEvents[K]): void {
    const handlers = this._listeners[event] as Set<EventHandler<K>> | undefined;
    if (!handlers || handlers.size === 0) return;
    for (const handler of Array.from(handlers)) {
      handler(payload);
    }
  }
}
