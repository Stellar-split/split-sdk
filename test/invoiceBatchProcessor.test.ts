import { describe, it, expect, vi } from "vitest";
import { InvoiceBatchProcessor } from "../src/invoiceBatchProcessor.js";
import type { InvoicePaymentSubmitter } from "../src/invoiceBatchProcessor.js";

async function drain<T>(iter: AsyncIterableIterator<T>): Promise<T[]> {
  const results: T[] = [];
  for await (const item of iter) results.push(item);
  return results;
}

describe("InvoiceBatchProcessor", () => {
  it("submits every invoice and reports success results", async () => {
    const submitPayment = vi.fn().mockImplementation(async ({ invoiceId }: { invoiceId: string }) => ({
      txHash: `tx-${invoiceId}`,
    }));
    const processor = new InvoiceBatchProcessor({ submitPayment } as InvoicePaymentSubmitter);

    const results = await drain(
      processor.process(["inv1", "inv2", "inv3"], {
        payer: "GPAYER",
        amounts: { inv1: 1n, inv2: 2n, inv3: 3n },
      })
    );

    expect(results).toHaveLength(3);
    expect(new Set(results.map((r) => r.invoiceId))).toEqual(new Set(["inv1", "inv2", "inv3"]));
    expect(results.every((r) => r.status === "success")).toBe(true);
    expect(submitPayment).toHaveBeenCalledTimes(3);
  });

  it("never runs more than maxConcurrent submissions at once", async () => {
    let active = 0;
    let maxActive = 0;
    const submitPayment = vi.fn().mockImplementation(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
      return { txHash: "tx" };
    });
    const processor = new InvoiceBatchProcessor({ submitPayment } as InvoicePaymentSubmitter);

    await drain(
      processor.process(["a", "b", "c", "d", "e"], {
        payer: "GPAYER",
        amounts: { a: 1n, b: 1n, c: 1n, d: 1n, e: 1n },
        maxConcurrent: 2,
      })
    );

    expect(maxActive).toBeLessThanOrEqual(2);
  });

  it("reports failed invoices individually without aborting the rest of the batch", async () => {
    const submitPayment = vi.fn().mockImplementation(async ({ invoiceId }: { invoiceId: string }) => {
      if (invoiceId === "bad") throw new Error("insufficient funds");
      return { txHash: `tx-${invoiceId}` };
    });
    const processor = new InvoiceBatchProcessor({ submitPayment } as InvoicePaymentSubmitter);

    const results = await drain(
      processor.process(["good1", "bad", "good2"], {
        payer: "GPAYER",
        amounts: { good1: 1n, bad: 1n, good2: 1n },
      })
    );

    expect(results).toHaveLength(3);
    const bad = results.find((r) => r.invoiceId === "bad")!;
    expect(bad.status).toBe("failed");
    expect(bad.error).toContain("insufficient funds");
    expect(results.filter((r) => r.status === "success")).toHaveLength(2);
  });

  it("pauses in-flight dispatch on a 429 and resumes after the backoff window", async () => {
    let calls = 0;
    const submitPayment = vi.fn().mockImplementation(async ({ invoiceId }: { invoiceId: string }) => {
      calls++;
      if (invoiceId === "throttled") {
        const err = new Error("429 too many requests") as Error & { retryAfterMs?: number };
        err.retryAfterMs = 20;
        throw err;
      }
      return { txHash: `tx-${invoiceId}` };
    });
    const processor = new InvoiceBatchProcessor({ submitPayment } as InvoicePaymentSubmitter);

    const start = Date.now();
    const results = await drain(
      processor.process(["throttled", "after1", "after2"], {
        payer: "GPAYER",
        amounts: { throttled: 1n, after1: 1n, after2: 1n },
        maxConcurrent: 1,
      })
    );
    const elapsed = Date.now() - start;

    expect(calls).toBe(3);
    expect(results.find((r) => r.invoiceId === "throttled")!.status).toBe("failed");
    expect(results.filter((r) => r.status === "success")).toHaveLength(2);
    expect(elapsed).toBeGreaterThanOrEqual(20);
  });

  it("emits batchInvoiceSettled and batchInvoiceFailed events", async () => {
    const submitPayment = vi.fn().mockImplementation(async ({ invoiceId }: { invoiceId: string }) => {
      if (invoiceId === "bad") throw new Error("failed");
      return { txHash: "tx" };
    });
    const processor = new InvoiceBatchProcessor({ submitPayment } as InvoicePaymentSubmitter);

    const settled = vi.fn();
    const failed = vi.fn();
    processor.events.on("batchInvoiceSettled", settled);
    processor.events.on("batchInvoiceFailed", failed);

    await drain(processor.process(["good", "bad"], { payer: "GPAYER", amounts: { good: 1n, bad: 1n } }));

    expect(settled).toHaveBeenCalledTimes(1);
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("fails an invoice with no configured amount without calling submitPayment", async () => {
    const submitPayment = vi.fn().mockResolvedValue({ txHash: "tx" });
    const processor = new InvoiceBatchProcessor({ submitPayment } as InvoicePaymentSubmitter);

    const results = await drain(
      processor.process(["missing"], { payer: "GPAYER", amounts: {} })
    );

    expect(results[0]!.status).toBe("failed");
    expect(submitPayment).not.toHaveBeenCalled();
  });
});

