import type { Invoice, Payment, InvoiceExt } from "./types.js";

/** Call types supported by the batcher. */
export type BatchCallType = "getInvoice" | "getPaymentHistory" | "getInvoiceExt";

interface PendingCall<T> {
  type: BatchCallType;
  invoiceId: string;
  resolve: (value: T) => void;
  reject: (error: Error) => void;
}

/** Fetch functions that BatchedRpcClient delegates to. */
export interface BatchFetchers {
  fetchInvoice: (id: string) => Promise<Invoice>;
  fetchPaymentHistory: (id: string) => Promise<Payment[]>;
  fetchInvoiceExt: (id: string) => Promise<InvoiceExt>;
}

/**
 * BatchedRpcClient collects getInvoice, getPaymentHistory, and getInvoiceExt
 * calls within a 10 ms window (configurable) and dispatches them in groups
 * of up to 20 (configurable). Each overflow group starts a new batch
 * immediately.
 */
export class BatchedRpcClient {
  private readonly _windowMs: number;
  private readonly _maxBatchSize: number;
  private readonly _fetchers: BatchFetchers;

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _pending: PendingCall<any>[] = [];
  private _timer: ReturnType<typeof setTimeout> | null = null;

  constructor(
    fetchers: BatchFetchers,
    windowMs = 10,
    maxBatchSize = 20,
  ) {
    this._fetchers = fetchers;
    this._windowMs = windowMs;
    this._maxBatchSize = maxBatchSize;
  }

  getInvoice(id: string): Promise<Invoice> {
    return this._enqueue<Invoice>("getInvoice", id);
  }

  getPaymentHistory(id: string): Promise<Payment[]> {
    return this._enqueue<Payment[]>("getPaymentHistory", id);
  }

  getInvoiceExt(id: string): Promise<InvoiceExt> {
    return this._enqueue<InvoiceExt>("getInvoiceExt", id);
  }

  private _enqueue<T>(type: BatchCallType, invoiceId: string): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this._pending.push({ type, invoiceId, resolve, reject } as PendingCall<T>);

      // Overflow: flush immediately without waiting for the timer
      if (this._pending.length >= this._maxBatchSize) {
        this._flush();
        return;
      }

      if (!this._timer) {
        this._timer = setTimeout(() => this._flush(), this._windowMs);
      }
    });
  }

  private _flush(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }

    if (this._pending.length === 0) return;

    // Take up to _maxBatchSize calls and leave the rest for the next flush
    const batch = this._pending.splice(0, this._maxBatchSize);

    // If there are still items after the splice, schedule another flush
    if (this._pending.length > 0 && !this._timer) {
      this._timer = setTimeout(() => this._flush(), this._windowMs);
    }

    this._dispatchBatch(batch);
  }

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private _dispatchBatch(batch: PendingCall<any>[]): void {
    for (const call of batch) {
      let promise: Promise<unknown>;

      switch (call.type) {
        case "getInvoice":
          promise = this._fetchers.fetchInvoice(call.invoiceId);
          break;
        case "getPaymentHistory":
          promise = this._fetchers.fetchPaymentHistory(call.invoiceId);
          break;
        case "getInvoiceExt":
          promise = this._fetchers.fetchInvoiceExt(call.invoiceId);
          break;
      }

      promise.then(call.resolve, call.reject);
    }
  }

  /** Number of calls queued but not yet dispatched. */
  get pendingCount(): number {
    return this._pending.length;
  }

  /** Reject all pending calls and cancel any scheduled flush. */
  clear(): void {
    if (this._timer) {
      clearTimeout(this._timer);
      this._timer = null;
    }
    for (const call of this._pending) {
      call.reject(new Error("BatchedRpcClient cleared"));
    }
    this._pending = [];
  }
}

// ---------------------------------------------------------------------------
// Legacy export — kept for backwards compatibility
// ---------------------------------------------------------------------------

/** @deprecated Use BatchedRpcClient instead */
export interface BatcherConfig {
  windowMs: number;
  maxBatchSize: number;
}

/** @deprecated Use BatchedRpcClient instead */
export class RequestBatcher {
  private readonly _inner: BatchedRpcClient;

  constructor(config: BatcherConfig = { windowMs: 10, maxBatchSize: 20 }) {
    const stub: BatchFetchers = {
      fetchInvoice: async (id) => ({
        id,
        creator: "",
        recipients: [],
        token: "",
        deadline: 0,
        funded: 0n,
        status: "Pending",
        payments: [],
      } as Invoice),
      fetchPaymentHistory: async () => [],
      fetchInvoiceExt: async () => ({ parentInvoiceId: null, cloneDepth: 0 }),
    };
    this._inner = new BatchedRpcClient(stub, config.windowMs, config.maxBatchSize);
  }

  async getInvoice(invoiceId: string): Promise<Invoice> {
    return this._inner.getInvoice(invoiceId);
  }

  getPendingCount(): number {
    return this._inner.pendingCount;
  }

  clear(): void {
    this._inner.clear();
  }
}
