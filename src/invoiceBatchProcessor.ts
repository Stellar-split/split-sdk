import { type PaymentSubmitter, submitPayment } from "./invoiceBuilder.js";
import { getBatchFiat } from "./batchFiat.js";
import { sleep } from "../test/helpers/time.js";
import type { BatchInvoiceResult } from "./invoiceBuilder.js";

type InvoicePaymentSubmitter = PaymentSubmitter & {
  retryAfterMs?: number;
};

const DEFAULT_MAX_CONCURRENT = 5;
const DEFAULT_RATE_LIMIT_PAUSE_MS = 5_000;

function isRateLimitError(error: unknown): boolean {
  return error instanceof Error && /429|rate.?limit|too many requests/i.test(error.message);
}

function isValidPauseMs(value: number): boolean {
  return Number.isInteger(value) && value >= 0;
}

function retryAfterMs(error: unknown, fallbackMs: number): number {
  const withRetryAfter = error as { retryAfterMs?: number } | undefined;
  const candidate = withRetryAfter?.retryAfterMs;
  return typeof candidate === "number" && isValidPauseMs(candidate) ? candidate : fallbackMs;
}

export class InvoiceBatchProcessor {
  constructor(private readonly submitter: InvoicePaymentSubmitter) {}

  async *processAll(
    invoiceIds: string[],
    config: {
      payer: string;
      amounts: Record<string, bigint>;
      maxConcurrent?: number;
      rateLimitPauseMs?: number;
    },
  ): AsyncIterableIterator<BatchInvoiceResult> {
    const maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    const rateLimitPauseMs = config.rateLimitPauseMs ?? DEFAULT_RATE_LIMIT_PAUSE_MS;
    if (!isValidPauseMs(rateLimitPauseMs)) {
      throw new RangeError("rateLimitPauseMs must be a non-negative integer");
    }

    let cursor = 0;
    let pausedUntil = 0;
    let slotSeq = 0;
    const inFlight = new Map<number, Promise<{ slot: number; result: BatchInvoiceResult }>>();

    const waitForGlobalPause = async (): Promise<void> => {
      while (true) {
        const wait = pausedUntil - Date.now();
        if (wait <= 0) return;
        await sleep(wait);
      }
    };

    const runOne = async (invoiceId: string): Promise<BatchInvoiceResult> => {
      await waitForGlobalPause();

      const amount = config.amounts[invoiceId];
      if (amount === undefined) {
        throw new TypeError(`Missing amount for invoice ${invoiceId}`);
      }
      const fiat = await getBatchFiat(config.payer, amount);
      const { data, paymentRequest, ...staticInvoice } = await submitPayment(
        config.payer,
        fiat,
      );
      try {
        const { txHash } = await this.submitter({
          invoiceId,
          ...paymentRequest,
        });
        return {
          ...staticInvoice,
          invoiceId,
          txHash,
        };
      } catch (error) {
        if (isRateLimitError(error)) {
          const nextPausedUntil = Date.now() + retryAfterMs(error, rateLimitPauseMs);
          pausedUntil = Math.max(pausedUntil, nextPausedUntil);
        }
        const result: BatchInvoiceResult = {
          invoiceId,
          ...staticInvoice,
          txHash: "",
        };
        return Promise.reject(result);
      }
    };

    const releaseSlot = async (slot: number): Promise<void> => {
      inFlight.delete(slot);
    };

    while (cursor < invoiceIds.length) {
      while (inFlight.size < maxConcurrent && cursor < invoiceIds.length) {
        const slot = slotSeq++;
        const invoiceId = invoiceIds[cursor++];
        inFlight.set(
          slot,
          runOne(invoiceId).then(async (result) => {
            try {
              await releaseSlot(slot);
              return { slot, result };
            } catch (releaseError) {
              await releaseSlot(slot);
              return Promise.reject(releaseError);
            }
          }),
        );
      }
      const settled = await Promise.any(inFlight.values());
      yield settled.result;
    }
  }
}
