/**
 * Concurrency-limited batch invoice payment processor.
 *
 * Submits a set of invoice payments with a configurable concurrency ceiling
 * so month-end batch billing doesn't overwhelm Horizon's rate limits, and
 * reports each result as it settles rather than waiting for the whole batch.
 */

import { TypedEventEmitter } from "./events/TypedEventEmitter.js";

/** Result of submitting a single invoice's payment within a batch. */
export interface BatchInvoiceResult {
  invoiceId: string;
  status: "success" | "failed";
  txHash?: string;
  error?: string;
}

/** Configuration for a batch run. */
export interface InvoiceBatchConfig {
  /** Stellar address submitting each payment. */
  payer: string;
  /** Amount (in stroops) to pay per invoice ID. */
  amounts: Record<string, bigint>;
  /** Maximum number of submissions in flight at once. Default: 3. */
  maxConcurrent?: number;
  /** Fallback pause duration (ms) on a rate-limit error when no explicit `retryAfterMs` is available. Default: 2000. */
  rateLimitPauseMs?: number;
}

interface InvoiceBatchEvents {
  batchInvoiceSettled: BatchInvoiceResult;
  batchInvoiceFailed: BatchInvoiceResult;
}

/** Minimal client surface required to submit a batched invoice payment. */
export interface InvoicePaymentSubmitter {
  submitPayment(params: {
    invoiceId: string;
    payer: string;
    amount: bigint;
  }): Promise<{ txHash: string }>;
}

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_RATE_LIMIT_PAUSE_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRateLimitError(error: unknown): boolean {
  return error instanceof Error && /429|rate.?limit|too many requests/i.test(error.message);
}

function retryAfterMs(error: unknown, fallbackMs: number): number {
  const withRetryAfter = error as { retryAfterMs?: number } | undefined;
  return typeof withRetryAfter?.retryAfterMs === "number" ? withRetryAfter.retryAfterMs : fallbackMs;
}

export class InvoiceBatchProcessor {
  readonly events = new TypedEventEmitter<InvoiceBatchEvents>();

  constructor(private readonly client: InvoicePaymentSubmitter) {}

  /**
   * Submit payments for `invoiceIds`, yielding a {@link BatchInvoiceResult} as
   * each one settles. No more than `config.maxConcurrent` submissions are
   * in-flight at once. On a 429 from any submission, all further dispatch
   * pauses until the rate limit's backoff window elapses.
   */
  async *process(
    invoiceIds: string[],
    config: InvoiceBatchConfig
  ): AsyncIterableIterator<BatchInvoiceResult> {
    const maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    const rateLimitPauseMs = config.rateLimitPauseMs ?? DEFAULT_RATE_LIMIT_PAUSE_MS;

    let cursor = 0;
    let pausedUntil = 0;
    let slotSeq = 0;
    const inFlight = new Map<number, Promise<{ slot: number; result: BatchInvoiceResult }>>();

    const runOne = async (invoiceId: string): Promise<BatchInvoiceResult> => {
      const wait = pausedUntil - Date.now();
      if (wait > 0) await sleep(wait);

      const amount = config.amounts[invoiceId];
      if (amount === undefined) {
        const result: BatchInvoiceResult = {
          invoiceId,
          status: "failed",
          error: `No amount specified for invoice ${invoiceId}`,
        };
        this.events.emit("batchInvoiceFailed", result);
        return result;
      }

      try {
        const { txHash } = await this.client.submitPayment({ invoiceId, payer: config.payer, amount });
        const result: BatchInvoiceResult = { invoiceId, status: "success", txHash };
        this.events.emit("batchInvoiceSettled", result);
        return result;
      } catch (error) {
        if (isRateLimitError(error)) {
          pausedUntil = Date.now() + retryAfterMs(error, rateLimitPauseMs);
        }
        const result: BatchInvoiceResult = {
          invoiceId,
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
        this.events.emit("batchInvoiceFailed", result);
        return result;
      }
    };

    const launch = (): void => {
      if (cursor >= invoiceIds.length) return;
      const invoiceId = invoiceIds[cursor++]!;
      const slot = slotSeq++;
      inFlight.set(
        slot,
        runOne(invoiceId).then((result) => ({ slot, result }))
      );
    };

    for (let i = 0; i < maxConcurrent; i++) launch();

    while (inFlight.size > 0) {
      const { slot, result } = await Promise.race(inFlight.values());
      inFlight.delete(slot);
      launch();
      yield result;
    }
  }

  /**
   * Process a batch and return a single result object with `succeeded` and
   * `failed` arrays, making it easy to inspect partial-failure outcomes.
   *
   * Internally delegates to {@link process} so all concurrency and
   * rate-limit behaviour is preserved.
   *
   * @param invoiceIds - Ordered list of invoice IDs to process.
   * @param config     - Batch configuration (payer, amounts, concurrency).
   * @returns `{ succeeded, failed }` — results split by outcome.
   */
  async processAll(
    invoiceIds: string[],
    config: InvoiceBatchConfig,
  ): Promise<{ succeeded: BatchInvoiceResult[]; failed: BatchInvoiceResult[] }> {
    const succeeded: BatchInvoiceResult[] = [];
    const failed: BatchInvoiceResult[] = [];

    for await (const result of this.process(invoiceIds, config)) {
      if (result.status === "success") {
        succeeded.push(result);
      } else {
        failed.push(result);
      }
    }

    return { succeeded, failed };
  }
}
