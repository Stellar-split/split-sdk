import type {
  BatchProcessor,
  BatchProcessorConfig,
  BatchResult,
  InvoicePaymentSubmitter,
} from "./interfaces/invoicePaymentSubmitter.js";

const DEFAULT_MAX_CONCURRENT = 3;
const DEFAULT_RATE_LIMIT_PAUSE_MS = 2_000;

export class InvoiceBatchProcessor implements BatchProcessor {
  private readonly submitter: InvoicePaymentSubmitter;

  constructor(submitter: InvoicePaymentSubmitter) {
    this.submitter = submitter;
  }

  async processAll(
    invoiceIds: string[],
    config: BatchProcessorConfig,
  ): Promise<BatchResult> {
    const payer = config.payer;
    const maxConcurrent = config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT;
    const rateLimitPauseMs = config.rateLimitPauseMs ?? DEFAULT_RATE_LIMIT_PAUSE_MS;

    if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1) {
      throw new RangeError("maxConcurrent must be a positive integer");
    }

    let cursor = 0;
    let pausedUntil = 0;
    let slotSeq = 0;
    const inFlight = new Map<number, Promise<void>>();
    const succeeded: string[] = [];
    const failed: string[] = [];

    const launch = async (): Promise<void> => {
      while (true) {
        if (cursor >= invoiceIds.length) return;

        const now = Date.now();
        if (now < pausedUntil) {
          await new Promise((resolve) =>
            setTimeout(resolve, pausedUntil - now),
          );
          continue;
        }

        const invoiceId = invoiceIds[cursor];
        const amounts = config.amounts ?? {};
        const amount = amounts[invoiceId];

        if (amount === undefined || amount <= 0n) {
          failed.push(invoiceId);
          cursor++;
          continue;
        }

        const slot = slotSeq++;
        const slotPromise = (async (): Promise<void> => {
          try {
            await this.submitter.submitPayment({
              invoiceId,
              payer,
              amount,
            });
            succeeded.push(invoiceId);
          } catch {
            failed.push(invoiceId);
          } finally {
            inFlight.delete(slot);
          }
        })();

        inFlight.set(slot, slotPromise);
        cursor++;
        return;
      }
    };

    const initialLaunches = Math.min(maxConcurrent, invoiceIds.length);
    for (let i = 0; i < initialLaunches; i++) launch();

    while (inFlight.size > 0) {
      const { slot, result } = await Promise.race(inFlight.values());
      inFlight.delete(slot);

      if (result === "rate-limited") {
        pausedUntil = Date.now() + rateLimitPauseMs;
      }

      if (cursor < invoiceIds.length) {
        launch();
      }
    }

    return { succeeded, failed };
  }
}
