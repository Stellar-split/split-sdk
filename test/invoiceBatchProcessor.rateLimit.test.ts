import { describe, it, expect, vi } from "vitest";
import { InvoiceBatchProcessor } from "../src/invoiceBatchProcessor.js";
import type { InvoicePaymentSubmitter } from "../src/invoiceBatchProcessor.js";

function rateLimitError(retryAfterMs: number): Error & { retryAfterMs: number } {
  return Object.assign(new Error("429 rate limit"), { retryAfterMs });
}

describe("InvoiceBatchProcessor – rate-limit authority", () => {
  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid rateLimitPauseMs=%s before submitting",
    async (rateLimitPauseMs) => {
      const submitPayment = vi.fn().mockResolvedValue({ txHash: "tx-inv1" });
      const processor = new InvoiceBatchProcessor(
        { submitPayment } as InvoicePaymentSubmitter,
      );

      await expect(
        processor.processAll(["inv1"], {
          payer: "GPAYER",
          amounts: { inv1: 1n },
          rateLimitPauseMs,
        }),
      ).rejects.toThrow(new RangeError("rateLimitPauseMs must be a non-negative integer"));

      expect(submitPayment).not.toHaveBeenCalled();
    },
  );

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "falls back when a 429 exposes malformed retryAfterMs=%s",
    async (retryAfterMs) => {
      vi.useFakeTimers();
      try {
        const submitPayment = vi
          .fn()
          .mockRejectedValueOnce(rateLimitError(retryAfterMs))
          .mockResolvedValueOnce({ txHash: "tx-inv2" });
        const processor = new InvoiceBatchProcessor(
          { submitPayment } as InvoicePaymentSubmitter,
        );

        const run = processor.processAll(["inv1", "inv2"], {
          payer: "GPAYER",
          amounts: { inv1: 1n, inv2: 1n },
          maxConcurrent: 1,
          rateLimitPauseMs: 100,
        });

        await vi.advanceTimersByTimeAsync(0);
        expect(submitPayment).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(99);
        expect(submitPayment).toHaveBeenCalledTimes(1);
        await vi.advanceTimersByTimeAsync(1);
        await run;
        expect(submitPayment).toHaveBeenCalledTimes(2);
      } finally {
        vi.useRealTimers();
      }
    },
  );

  it("does not let a shorter later 429 reduce an existing global pause", async () => {
    vi.useFakeTimers();
    try {
      const submitPayment = vi.fn().mockImplementation(
        ({ invoiceId }: { invoiceId: string }) => {
          if (invoiceId === "inv1") {
            return Promise.reject(rateLimitError(1_000));
          }
          if (invoiceId === "inv2") {
            return new Promise((_resolve, reject) => {
              setTimeout(() => reject(rateLimitError(100)), 50);
            });
          }
          return Promise.resolve({ txHash: `tx-${invoiceId}` });
        },
      );
      const processor = new InvoiceBatchProcessor(
        { submitPayment } as InvoicePaymentSubmitter,
      );

      const run = processor.processAll(["inv1", "inv2", "inv3", "inv4"], {
        payer: "GPAYER",
        amounts: { inv1: 1n, inv2: 1n, inv3: 1n, inv4: 1n },
        maxConcurrent: 2,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(submitPayment).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(200);
      expect(submitPayment).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(799);
      expect(submitPayment).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await run;
      expect(submitPayment).toHaveBeenCalledTimes(4);
    } finally {
      vi.useRealTimers();
    }
  });

  it("re-checks a shared pause when another in-flight 429 extends it", async () => {
    vi.useFakeTimers();
    try {
      const submitPayment = vi.fn().mockImplementation(
        ({ invoiceId }: { invoiceId: string }) => {
          if (invoiceId === "inv1") {
            return Promise.reject(rateLimitError(100));
          }
          if (invoiceId === "inv2") {
            return new Promise((_resolve, reject) => {
              setTimeout(() => reject(rateLimitError(1_000)), 50);
            });
          }
          return Promise.resolve({ txHash: `tx-${invoiceId}` });
        },
      );
      const processor = new InvoiceBatchProcessor(
        { submitPayment } as InvoicePaymentSubmitter,
      );

      const run = processor.processAll(["inv1", "inv2", "inv3"], {
        payer: "GPAYER",
        amounts: { inv1: 1n, inv2: 1n, inv3: 1n },
        maxConcurrent: 2,
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(submitPayment).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(100);
      expect(submitPayment).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(949);
      expect(submitPayment).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      await run;
      expect(submitPayment).toHaveBeenCalledTimes(3);
    } finally {
      vi.useRealTimers();
    }
  });
});
