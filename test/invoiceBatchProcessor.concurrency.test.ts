import { describe, it, expect, vi } from "vitest";
import { InvoiceBatchProcessor } from "../src/invoiceBatchProcessor.js";
import type { InvoicePaymentSubmitter } from "../src/invoiceBatchProcessor.js";

describe("InvoiceBatchProcessor – concurrency configuration", () => {
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])(
    "rejects invalid maxConcurrent=%s before submitting",
    async (maxConcurrent) => {
      const submitPayment = vi.fn().mockResolvedValue({ txHash: "tx-inv1" });
      const processor = new InvoiceBatchProcessor(
        { submitPayment } as InvoicePaymentSubmitter,
      );

      await expect(
        processor.processAll(["inv1"], {
          payer: "GPAYER",
          amounts: { inv1: 1n },
          maxConcurrent,
        }),
      ).rejects.toThrow(new RangeError("maxConcurrent must be a positive integer"));

      expect(submitPayment).not.toHaveBeenCalled();
    },
  );

  it("caps initial launch attempts at the number of invoices", async () => {
    const submitPayment = vi
      .fn()
      .mockImplementation(async ({ invoiceId }: { invoiceId: string }) => ({
        txHash: `tx-${invoiceId}`,
      }));
    const processor = new InvoiceBatchProcessor(
      { submitPayment } as InvoicePaymentSubmitter,
    );

    const { succeeded, failed } = await processor.processAll(
      ["inv1", "inv2"],
      {
        payer: "GPAYER",
        amounts: { inv1: 1n, inv2: 1n },
        maxConcurrent: Number.MAX_SAFE_INTEGER,
      },
    );

    expect(succeeded).toHaveLength(2);
    expect(failed).toHaveLength(0);
    expect(submitPayment).toHaveBeenCalledTimes(2);
  });
});
